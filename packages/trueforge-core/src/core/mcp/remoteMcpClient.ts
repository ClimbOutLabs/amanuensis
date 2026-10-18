import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// SSE remains required during the Streamable HTTP migration (some servers still speak SSE only).

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { context, propagation } from '@opentelemetry/api';
import { McpConnectionError } from '../errors';
import { withTimeout } from '../util/promiseUtils';
import { isRedirectStatus, redirectTargetOrigin } from '../util/redirects';
import type { ToolSchema } from './IMCPServer';

/** Networking for remote (url-based) MCP servers, kept separate so it can be mocked in tests. */

export type RemoteMcpTransportType = 'streamable-http' | 'sse';

export interface RemoteMcpConnection {
  readonly transportType: RemoteMcpTransportType;
  /** Session id for a stateful server, or null for a stateless one. */
  readonly sessionId: string | null;
  listTools(cursor?: string): Promise<{ tools: ToolSchema[]; nextCursor?: string | undefined }>;
  callTool(params: CallToolRequest['params']): Promise<CallToolResult>;
  close(): Promise<void>;
}

// SSE transport type kept for dual-probe support during migration.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see TRANSPORT_PROBE_ORDER
type McpTransport = StreamableHTTPClientTransport | SSEClientTransport;

const CLIENT_INFO = { name: 'tfy-agent-mcp-client', version: '1.0.0' } as const;
const TRANSPORT_PROBE_ORDER: RemoteMcpTransportType[] = ['streamable-http', 'sse'];

class McpClientWithTimeout extends Client {
  constructor(private readonly requestTimeoutMs: number) {
    super(CLIENT_INFO, { capabilities: {} });
  }

  // SDK Client.request is loosely typed; forward with an explicit timeout.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK request typing
  override request(req: any, schema: any, options?: any): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- MCP SDK request typing
    return super.request(req, schema, { ...options, timeout: this.requestTimeoutMs });
  }
}

function createTransport({
  type,
  url,
  headers,
  sessionId,
  fetchFn,
}: {
  type: RemoteMcpTransportType;
  url: URL;
  headers: Record<string, string>;
  sessionId?: string | undefined;
  /** Replaces the global fetch for every request the transport makes, its streams included. */
  fetchFn?: FetchLike | undefined;
}): McpTransport {
  const requestInit = { headers };
  const fetchOption = fetchFn === undefined ? {} : { fetch: fetchFn };
  if (type === 'streamable-http') {
    return new StreamableHTTPClientTransport(url, {
      requestInit,
      ...fetchOption,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- dual-transport probe; see TRANSPORT_PROBE_ORDER
  return new SSEClientTransport(url, { requestInit, ...fetchOption });
}

/** Where a refused redirect pointed. `target` is an origin only: a Location can carry a secret in its query. */
interface RefusedRedirect {
  status: number;
  target: string | undefined;
  /** True when redirects within the server's own origin were still allowed. */
  sameOriginOnly: boolean;
}

function redirectRefusedMessage({ status, target, sameOriginOnly }: RefusedRedirect): string {
  const to = target === undefined ? '' : ` to ${target}`;
  return sameOriginOnly
    ? `server answered HTTP ${String(status)} with a redirect${to}, and this connection does not follow redirects to another origin`
    : `server answered HTTP ${String(status)} with a redirect${to}, and this connection does not follow redirects`;
}

const MAX_SAME_ORIGIN_REDIRECTS = 5;

/**
 * A fetch that never follows a redirect to another origin, and remembers the first one it refused.
 * The connector's headers, secrets included, belong to the origin the user configured: following
 * a redirect would hand them, and the approved arguments, to wherever that origin points. A host
 * vouched for as first-party refuses every redirect; any other connector may still follow one that
 * stays on its own origin. The transports make several kinds of request (POST, the event stream,
 * DELETE) and wrap what a failing fetch throws in their own types, so the refusal is recorded here
 * and read back by the caller instead of recovered from the error.
 */
function createRedirectGuardFetch({ sameOriginOnly }: { sameOriginOnly: boolean }): {
  fetch: FetchLike;
  refusal: () => RefusedRedirect | undefined;
} {
  let refusal: RefusedRedirect | undefined;
  return {
    fetch: async (requestUrl, init) => {
      let currentUrl: string | URL = requestUrl;
      let currentInit = init;
      for (let hop = 0; ; hop += 1) {
        const response = await fetch(currentUrl, { ...currentInit, redirect: 'manual' });
        if (!isRedirectStatus(response.status)) {
          return response;
        }
        const target = redirectTargetOrigin({ response, requestUrl: currentUrl });
        const location = response.headers.get('location');
        const sameOrigin = target !== undefined && target === new URL(currentUrl).origin && location !== null;
        if (!sameOriginOnly || !sameOrigin || hop >= MAX_SAME_ORIGIN_REDIRECTS) {
          const refused = { status: response.status, target, sameOriginOnly };
          refusal ??= refused;
          await response.body?.cancel().catch(() => {
            /* no-op */
          });
          throw new McpConnectionError(redirectRefusedMessage(refused), 502);
        }
        await response.body?.cancel().catch(() => {
          /* no-op */
        });
        currentUrl = new URL(location, currentUrl);
        // 307 and 308 repeat the request as it was; the older codes turn a POST into a bodiless GET.
        if (response.status !== 307 && response.status !== 308 && currentInit?.method?.toUpperCase() === 'POST') {
          currentInit = { ...currentInit, method: 'GET', body: null };
        }
      }
    },
    refusal: () => refusal,
  };
}

export function isSessionExpiredError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ('code' in error && error.code === 404) {
    return true;
  }
  return (
    error.message.includes('HTTP 404') ||
    error.message.toLowerCase().includes('session') ||
    isNotInitializedServerError(error.message)
  );
}

/**
 * Matches a JSON-RPC -32000 "not initialized" server error. Streamable-HTTP MCP servers that keep
 * sessions in memory answer a request carrying a stale session id with HTTP 400 and a JSON-RPC body
 * like {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}
 * after a restart wipes their session table. The transport surfaces the whole body inside the error
 * message, so this pairs the -32000 code with the "not initialized" text instead of retrying on every
 * -32000 (application-defined server errors in the -32000..-32099 range) or every mention of
 * "initialized". Deliberately does not match a bare HTTP 400: a 400 without the -32000 payload is
 * more likely a malformed request, and misclassifying it would burn a fresh reconnect for nothing.
 */
function isNotInitializedServerError(message: string): boolean {
  if (!message.toLowerCase().includes('not initialized')) {
    return false;
  }
  return /"code"\s*:\s*-32000\b/.test(message);
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ('code' in error && error.code === 401) {
    return true;
  }
  return error.message.includes('HTTP 401');
}

/** Inject the active otel trace context so each request propagates its span. */
function stampTraceHeaders(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}

function getTransportSessionId(transport: McpTransport): string | null {
  return transport instanceof StreamableHTTPClientTransport ? (transport.sessionId ?? null) : null;
}

function toConnectError(error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) {
    return error;
  }
  if (isAuthError(error)) {
    return new McpConnectionError('upstream returned 401 Unauthorized', 401, {
      cause: error,
    });
  }
  if (isSessionExpiredError(error)) {
    // Still reads as session-expired, so the caller reconnects instead of failing.
    return new McpConnectionError('upstream session expired', 502, { cause: error });
  }
  return new McpConnectionError(describeTransportError(error), 502, { cause: error });
}

/**
 * The SDK puts the upstream response body into its error text, and a body can echo the
 * request's credentials back. Keep the SDK's description and status, never the body.
 */
function describeTransportError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error);
  const posting = /^(.*?Error POSTing to endpoint)(?: \(HTTP (\d+)\))?:/s.exec(message);
  if (posting === null) {
    return message;
  }
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const status = posting[2] ?? (typeof code === 'number' && code > 0 ? String(code) : undefined);
  return status === undefined ? (posting[1] ?? message) : `${posting[1] ?? message} (HTTP ${status})`;
}

function buildConnection(
  client: McpClientWithTimeout,
  transport: McpTransport,
  transportType: RemoteMcpTransportType,
  headers: Record<string, string>,
  requestOptions: { signal: AbortSignal },
): RemoteMcpConnection {
  return {
    transportType,
    sessionId: getTransportSessionId(transport),
    listTools: async (cursor?: string) => {
      stampTraceHeaders(headers);
      const response = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      return {
        tools: response.tools,
        nextCursor: response.nextCursor,
      };
    },
    callTool: async (callParams: CallToolRequest['params']): Promise<CallToolResult> => {
      stampTraceHeaders(headers);
      return (await client.callTool(callParams, undefined, requestOptions)) as CallToolResult;
    },
    close: async (): Promise<void> => {
      await client.close().catch(() => {
        /* no-op */
      });
    },
  };
}

/**
 * Connect to a remote MCP server, keeping the first transport that connects. `sessionId` is passed to
 * every attempt so a stateful session resumes in place instead of opening a throwaway one.
 *
 * `knownTransportType` is a hint (from a prior connect / persisted state): it's tried first for a fast
 * path, but on failure we still fall back to probing the remaining transports, so a stale or wrong
 * hint (server switched transports, bad resume data) self-heals instead of failing every turn.
 */
export async function connectRemoteMcp(params: {
  url: string;
  headers: Record<string, string>;
  sessionId?: string | undefined;
  knownTransportType?: RemoteMcpTransportType | undefined;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  signal: AbortSignal;
  /**
   * Answer any redirect with an error. Set for a connection the host marked first-party; every other
   * connection refuses a redirect to another origin and follows one within the server's own origin.
   */
  refuseRedirects?: boolean | undefined;
  onClose?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}): Promise<RemoteMcpConnection> {
  const url = new URL(params.url);
  const requestOptions = { signal: params.signal };
  const redirectRefusal = createRedirectGuardFetch({ sameOriginOnly: params.refuseRedirects !== true });
  const candidates = params.knownTransportType
    ? [params.knownTransportType, ...TRANSPORT_PROBE_ORDER.filter(t => t !== params.knownTransportType)]
    : TRANSPORT_PROBE_ORDER;
  const failures: { transport: RemoteMcpTransportType; error: string }[] = [];

  for (const transportType of candidates) {
    const transport = createTransport({
      type: transportType,
      url,
      headers: params.headers,
      sessionId: params.sessionId,
      fetchFn: redirectRefusal.fetch,
    });
    const client = new McpClientWithTimeout(params.requestTimeoutMs);
    try {
      stampTraceHeaders(params.headers);
      await withTimeout(
        // Concrete transports use sessionId: string|undefined; Transport uses an optional
        // property — exactOptionalPropertyTypes rejects assignability without this cast.
        client.connect(transport as Parameters<Client['connect']>[0], requestOptions),
        params.connectTimeoutMs,
        transportType,
      );
    } catch (error) {
      await client.close().catch(() => {
        /* no-op */
      });
      // A refused redirect is final: the URL does not serve MCP itself, so another transport on it would fare no better.
      const refused = redirectRefusal.refusal();
      if (refused !== undefined) {
        throw new McpConnectionError(redirectRefusedMessage(refused), 502, { cause: error });
      }
      if (isAuthError(error)) {
        throw toConnectError(error);
      }
      // A session-expired error means the transport is right but the session is stale: surface it so
      // the caller reconnects fresh instead of falling through to a different transport.
      if (params.sessionId && isSessionExpiredError(error)) {
        throw toConnectError(error);
      }
      failures.push({ transport: transportType, error: describeTransportError(error) });
      continue;
    }

    // Set on the client (not the transport) so the SDK's own onclose/onerror cleanup still runs; the
    // SDK invokes these from inside it. Only wired on the kept connection, so failed attempts stay quiet.
    client.onclose = () => params.onClose?.();
    client.onerror = error => params.onError?.(error);
    return buildConnection(client, transport, transportType, params.headers, requestOptions);
  }

  throw new McpConnectionError(`failed to connect (tried ${candidates.join(', ')}): ${JSON.stringify(failures)}`, 502);
}
