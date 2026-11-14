import { Agent, fetch as undiciFetch } from 'undici';
import { isRedirectStatus } from './redirects';

/**
 * Outbound HTTP for model providers and remote MCP: one undici Agent per audience, carrying
 * short connect waits so a dead endpoint fails fast, plus retries for the failures that mean
 * the request never reached the server (or, for replayable callers, may not have been
 * processed). Retries only ever replay a request before its response body is consumed.
 *
 * Ported from upstream trueforge #894 and #756, adapted to this fork: upstream builds these
 * fetches on its SSRF guard's pinned DNS lookup; the fork checks outbound addresses at each
 * call site instead, so this module owns the timeouts, the retries, and the hops of a model
 * redirect, each of which is put to the check the host configures before it is followed. The
 * MCP body timeout lives here too: an idle MCP event stream is silent for long stretches, and
 * undici's default 300s bodyTimeout kills it, so the connection drops and reconnects every few
 * minutes.
 */

/** The timeouts and retry count one audience (model calls or MCP calls) runs with. */
export interface OutboundTimeouts {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  maxRetries: number;
}

export interface OutboundFetchOptions extends OutboundTimeouts {
  /**
   * Whether requests are safe to replay after upstream may have received them. When false,
   * 409/520/524 are not retried. Fixed per audience: model requests are, tool calls are not.
   */
  idempotent: boolean;
}

interface OutboundFetch {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

/** Model outbound undici connect timeout. Env: `MODEL_HTTP_CONNECT_TIMEOUT_MS`. */
export const DEFAULT_MODEL_HTTP_CONNECT_TIMEOUT_MS = 5_000;
/**
 * Model outbound undici headersTimeout. Env: `MODEL_HTTP_HEADERS_TIMEOUT_MS`.
 * 5 minutes, undici's own default that model calls ran on before. A backstop only: the model's
 * first-chunk wait starts when the request is sent, covers the wait for headers too, and is
 * the limit a slow local model actually meets.
 */
export const DEFAULT_MODEL_HTTP_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Model outbound undici bodyTimeout (idle between body chunks). Env: `MODEL_HTTP_BODY_TIMEOUT_MS`.
 * 5 minutes, undici's own default; the stream's own chunk wait (`chunkMs`) is the tighter limit.
 */
export const DEFAULT_MODEL_HTTP_BODY_TIMEOUT_MS = 5 * 60 * 1000;
/** Model outbound fetch retries. Env: `MODEL_HTTP_MAX_RETRIES`. */
export const DEFAULT_MODEL_HTTP_MAX_RETRIES = 2;

/** MCP outbound undici connect timeout. Env: `MCP_HTTP_CONNECT_TIMEOUT_MS`. */
export const DEFAULT_MCP_HTTP_CONNECT_TIMEOUT_MS = 5_000;
/**
 * How much longer the MCP headers timeout waits than the MCP request timeout. A JSON-response
 * server sends headers only after the tool finishes, so the request timeout must fire first and
 * report a slow tool, not a dropped connection.
 */
export const MCP_HTTP_HEADERS_TIMEOUT_MARGIN_MS = 5_000;
/** MCP outbound undici headersTimeout with the default 4 minute MCP request timeout. */
const DEFAULT_MCP_HTTP_HEADERS_TIMEOUT_MS = 4 * 60 * 1000 + MCP_HTTP_HEADERS_TIMEOUT_MARGIN_MS;
/**
 * MCP outbound undici bodyTimeout. Env: `MCP_HTTP_BODY_TIMEOUT_MS`.
 * Default 30m so an idle event stream is not killed at undici's 300s.
 */
export const DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS = 30 * 60 * 1000;
/** MCP outbound fetch retries. Env: `MCP_HTTP_MAX_RETRIES`. */
export const DEFAULT_MCP_HTTP_MAX_RETRIES = 2;

function defaultModelOutboundFetchOptions(): OutboundFetchOptions {
  return {
    connectTimeoutMs: DEFAULT_MODEL_HTTP_CONNECT_TIMEOUT_MS,
    headersTimeoutMs: DEFAULT_MODEL_HTTP_HEADERS_TIMEOUT_MS,
    bodyTimeoutMs: DEFAULT_MODEL_HTTP_BODY_TIMEOUT_MS,
    maxRetries: DEFAULT_MODEL_HTTP_MAX_RETRIES,
    idempotent: true,
  };
}

function defaultMcpOutboundFetchOptions(): OutboundFetchOptions {
  return {
    connectTimeoutMs: DEFAULT_MCP_HTTP_CONNECT_TIMEOUT_MS,
    headersTimeoutMs: DEFAULT_MCP_HTTP_HEADERS_TIMEOUT_MS,
    bodyTimeoutMs: DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS,
    maxRetries: DEFAULT_MCP_HTTP_MAX_RETRIES,
    // Tool calls are not safe to replay once upstream may have received them.
    idempotent: false,
  };
}

// Rejected before processing (timeout, rate limit, gateway never reached the origin).
const UNPROCESSED_RETRY_STATUSES = new Set([408, 429, 521, 522, 523, 530]);
// Upstream may have processed the request (409 conflict, 520 bad origin response, 524 origin timeout).
const MAYBE_PROCESSED_RETRY_STATUSES = new Set([409, 520, 524]);
// undici's BodyTimeoutError message.
const UNDICI_BODY_TIMEOUT_MESSAGE = 'Body Timeout Error';
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER_FACTOR = 0.2;
// A longer server-requested wait returns the answer rather than stalling the caller.
const MAX_RETRY_AFTER_MS = 5_000;

function getErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const code = Reflect.get(current, 'code');
      if (typeof code === 'string') {
        return code;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * A connect timeout from undici (including nested under TypeError: fetch failed): the request
 * never reached the server. A headers timeout is not retried: the server already has the
 * request and is slow, and sending it again only multiplies the wait.
 */
export function isRetryableOutboundTransportError(error: unknown): boolean {
  return getErrorCode(error) === 'UND_ERR_CONNECT_TIMEOUT';
}

/**
 * An undici body timeout: the server went quiet mid-response, such as an idle event stream.
 * The MCP SDK reports a dropped event stream as a new Error carrying only the original's text,
 * with no cause, so undici's own message is the signal when the code is gone.
 */
export function isOutboundBodyTimeout(error: unknown): boolean {
  if (getErrorCode(error) === 'UND_ERR_BODY_TIMEOUT') {
    return true;
  }
  return error instanceof Error && error.message.includes(UNDICI_BODY_TIMEOUT_MESSAGE);
}

function isRetryableOutboundStatus(status: number, options: { idempotent: boolean }): boolean {
  return UNPROCESSED_RETRY_STATUSES.has(status) || (options.idempotent && MAYBE_PROCESSED_RETRY_STATUSES.has(status));
}

type RetryAfter = { kind: 'none' } | { kind: 'wait'; delayMs: number } | { kind: 'too_long' };

/**
 * Server-requested delay from `retry-after-ms` or `retry-after` (seconds or HTTP date). A wait
 * longer than the cap means the server will refuse an early retry, so the caller gets the answer.
 */
function readRetryAfter(headers: { get(name: string): string | null }): RetryAfter {
  let delayMs: number | undefined;
  const retryAfterMsHeader = headers.get('retry-after-ms');
  if (retryAfterMsHeader !== null) {
    delayMs = Number.parseFloat(retryAfterMsHeader);
  } else {
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    }
  }
  if (delayMs === undefined || !Number.isFinite(delayMs)) {
    return { kind: 'none' };
  }
  if (delayMs > MAX_RETRY_AFTER_MS) {
    return { kind: 'too_long' };
  }
  return { kind: 'wait', delayMs: Math.max(0, delayMs) };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const aborted = new Error('This operation was aborted');
  aborted.name = 'AbortError';
  return aborted;
}

function retryDelayMs(attempt: number): number {
  const base = RETRY_INITIAL_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt;
  const jitterMultiplier = 1 + (Math.random() - 0.5) * RETRY_JITTER_FACTOR;
  return Math.max(0, Math.round(base * jitterMultiplier));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal !== undefined) {
        reject(abortError(signal));
        return;
      }
      reject(new Error('This operation was aborted'));
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function mergeRequestInit(input: string | URL | Request, init: RequestInit): RequestInit {
  if (!(input instanceof Request)) {
    return init;
  }
  return {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
    redirect: input.redirect,
    ...init,
  };
}

/** Bodies that undici can send more than once without re-reading a stream. */
function isReplayableBodyInit(body: NonNullable<RequestInit['body']>): boolean {
  return (
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams
  );
}

/**
 * Normalize to URL + init, buffering one-shot stream bodies so retries can replay them.
 * A `Request` body is always a stream even when constructed from a string; callers that
 * accept a `Request` merge it into init before calling this (see mergeRequestInit).
 */
async function materializeReplayableOutboundRequest(
  input: string | URL,
  init: RequestInit,
): Promise<{ input: URL; init: RequestInit }> {
  const url = new URL(input);
  const body = init.body;
  if (body == null || isReplayableBodyInit(body)) {
    return { input: url, init };
  }
  const buffer = await new Response(body).arrayBuffer();
  return {
    input: url,
    init: {
      ...init,
      body: buffer,
    },
  };
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Judges one redirect target before the model fetch follows it: true when the target may be
 * dialled. The host app supplies the check, because its address rules live there; this module
 * only refuses to follow a redirect the check has not passed.
 */
export type OutboundRedirectCheck = (url: string) => Promise<boolean>;

/** Why a checked redirect was stopped: the target named no usable address, the chain ran too long, or the check refused the target. */
export type OutboundRedirectRefusalKind = 'bad-redirect' | 'too-many' | 'refused';

/** A request was stopped at a redirect the redirect check refuses or cannot judge. */
export class OutboundRedirectRefusedError extends Error {
  readonly kind: OutboundRedirectRefusalKind;

  constructor(message: string, kind: OutboundRedirectRefusalKind = 'refused') {
    super(message);
    this.name = 'OutboundRedirectRefusedError';
    this.kind = kind;
  }
}

const MAX_CHECKED_REDIRECTS = 5;

/**
 * The request with its credential headers taken out, for a redirect hop to another origin:
 * Authorization, Cookie, and the API key headers (`x-api-key`, `api-key`). Those belong to
 * the origin the caller configured, so none of them travels to a different one. Every other
 * header, and the rest of the request, travels as it was. This is the one place that decides
 * which headers are credentials for a cross-origin hop; every checked redirect loop uses it.
 */
export function withoutCrossOriginCredentials(init: RequestInit): RequestInit {
  if (init.headers === undefined) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.delete('authorization');
  headers.delete('cookie');
  headers.delete('x-api-key');
  headers.delete('api-key');
  return { ...init, headers };
}

/**
 * Follow redirects by hand, putting every target to `check` before dialling it: a provider
 * whose base address passed the host's address check can still answer with a redirect to an
 * address that would have been refused, so no hop is followed on the transport's say-so. The
 * MCP sign-in dial follows redirects through this same loop: at most MAX_CHECKED_REDIRECTS
 * hops, 301, 302 and 303 turn a POST into a bodiless GET while 307 and 308 replay the
 * request as it was, and a hop to another origin goes without the caller's credential
 * headers (see withoutCrossOriginCredentials). Those headers belong to the origin the
 * caller configured, the principle the MCP connection's redirect guard enforces by refusing
 * such hops outright.
 */
export function withCheckedRedirects(fetchFn: FetchFn, check: OutboundRedirectCheck): FetchFn {
  return async (input, init) => {
    let currentUrl = new URL(input);
    let currentInit: RequestInit = init ?? {};
    for (let hop = 0; ; hop += 1) {
      const response = await fetchFn(currentUrl, { ...currentInit, redirect: 'manual' });
      if (!isRedirectStatus(response.status)) {
        return response;
      }
      const location = response.headers.get('location');
      let target: URL | undefined;
      if (location !== null) {
        try {
          target = new URL(location, currentUrl);
        } catch {
          target = undefined;
        }
      }
      await response.body?.cancel().catch(() => undefined);
      if (target === undefined || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
        throw new OutboundRedirectRefusedError(
          `model server answered HTTP ${String(response.status)} with a redirect that does not name an http(s) address, so the request was stopped`,
          'bad-redirect',
        );
      }
      if (hop >= MAX_CHECKED_REDIRECTS) {
        throw new OutboundRedirectRefusedError(
          `model server kept redirecting (more than ${String(MAX_CHECKED_REDIRECTS)} redirects), so the request was stopped`,
          'too-many',
        );
      }
      if (!(await check(target.href))) {
        throw new OutboundRedirectRefusedError(
          `model server answered HTTP ${String(response.status)} with a redirect to ${target.origin}, and that address is not one the server may connect to, so the request was stopped`,
        );
      }
      // 307 and 308 repeat the request as it was; the older codes turn a POST into a bodiless GET.
      if (response.status !== 307 && response.status !== 308 && currentInit.method?.toUpperCase() === 'POST') {
        currentInit = { ...currentInit, method: 'GET', body: null };
      }
      if (target.origin !== currentUrl.origin) {
        currentInit = withoutCrossOriginCredentials(currentInit);
      }
      currentUrl = target;
    }
  };
}

/**
 * Retry `fetchFn` on the failures that mean the request never got an answer: connect timeouts,
 * retryable gateway statuses, and (for idempotent callers only) statuses where upstream may
 * already have processed the request. Honors Retry-After up to 5s; a longer one returns the
 * answer as is; without one, backs off. A retry replays the request from the start; response
 * bodies are never consumed before the decision, so nothing already streaming is ever replayed.
 */
export function withOutboundHttpRetries(fetchFn: FetchFn, options: OutboundFetchOptions): FetchFn {
  const { maxRetries, idempotent } = options;
  return async (input, init) => {
    const effectiveInit = init ?? {};
    const signal = effectiveInit.signal ?? undefined;
    // Buffer stream bodies once so a retry does not hit a consumed-body error.
    const replayable =
      maxRetries > 0
        ? await materializeReplayableOutboundRequest(input, effectiveInit)
        : { input, init: effectiveInit };
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      let delayMs = retryDelayMs(attempt);
      try {
        const response = await fetchFn(replayable.input, replayable.init);
        if (!isRetryableOutboundStatus(response.status, { idempotent }) || attempt >= maxRetries) {
          return response;
        }
        const retryAfter = readRetryAfter(response.headers);
        if (retryAfter.kind === 'too_long') {
          return response;
        }
        if (retryAfter.kind === 'wait') {
          delayMs = retryAfter.delayMs;
        }
        void response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (!isRetryableOutboundTransportError(error) || attempt >= maxRetries || signal?.aborted) {
          throw error;
        }
      }
      await sleep(delayMs, signal);
      attempt += 1;
    }
  };
}

function createOutboundAgent(options: OutboundFetchOptions): Agent {
  return new Agent({
    bodyTimeout: options.bodyTimeoutMs,
    headersTimeout: options.headersTimeoutMs,
    connectTimeout: options.connectTimeoutMs,
  });
}

/** One undici call through `agent`, with the caller's init carried across the undici/DOM type bridge. */
function agentFetch(agent: Agent): FetchFn {
  return async (input, init) => {
    const url = new URL(input);
    const merged = init ?? {};
    // npm undici vs DOM fetch types do not line up under exactOptionalPropertyTypes; the
    // merged init is assigned onto a plain object, the same bridge as http/tls.ts uses.
    const requestInit: Record<string, unknown> = { dispatcher: agent };
    Object.assign(requestInit, merged, {
      dispatcher: agent,
      ...(merged.body != null && typeof merged.body === 'object' && 'getReader' in merged.body
        ? { duplex: 'half' }
        : {}),
    });
    return undiciFetch(url.href, requestInit);
  };
}

/** Builds a pooled undici Agent + fetch with the given timeouts and retries. */
function createOutboundFetch(
  options: OutboundFetchOptions,
  redirectCheck: OutboundRedirectCheck | undefined,
): OutboundFetch {
  const agent = createOutboundAgent(options);
  const base = redirectCheck === undefined ? agentFetch(agent) : withCheckedRedirects(agentFetch(agent), redirectCheck);
  const retried = withOutboundHttpRetries(base, options);
  return {
    // A `Request` input is normalized to URL + merged init once; the retries then replay
    // that pair, never the one-shot Request itself.
    fetch: async (input, init) => {
      const merged = mergeRequestInit(input, init ?? {});
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      return retried(url, merged);
    },
    close: async () => {
      await agent.close().catch(() => undefined);
    },
  };
}

// The Agents are built on first use, not at import: importing this module (directly or via
// the core index) must not open a connection pool or depend on undici being constructible.
let modelOptions: OutboundFetchOptions = defaultModelOutboundFetchOptions();
let modelRedirectCheck: OutboundRedirectCheck | undefined;
let modelOutbound: OutboundFetch | undefined;
let mcpOptions: OutboundFetchOptions = defaultMcpOutboundFetchOptions();
let mcpAgent: Agent | undefined;

/** Replace the outbound Agents (timeouts and retries) from server configuration. */
export function configureOutboundFetches(config: {
  model: OutboundTimeouts;
  mcp: OutboundTimeouts;
  /**
   * The check every model redirect target must pass before the model fetch follows it. A host
   * that enforces address rules on model providers supplies it; without one, model redirects
   * are followed by the transport as before.
   */
  modelRedirectCheck?: OutboundRedirectCheck | undefined;
}): void {
  const previousModel = modelOutbound;
  const previousMcpAgent = mcpAgent;
  modelOptions = { ...config.model, idempotent: true };
  modelRedirectCheck = config.modelRedirectCheck;
  modelOutbound = undefined;
  // Tool calls are not safe to replay once upstream may have received them.
  mcpOptions = { ...config.mcp, idempotent: false };
  mcpAgent = undefined;
  void previousModel?.close();
  void previousMcpAgent?.close().catch(() => undefined);
}

/** Drop-in fetch for model-provider HTTP, with the model timeouts and retries. */
export async function modelOutboundFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  modelOutbound ??= createOutboundFetch(modelOptions, modelRedirectCheck);
  return modelOutbound.fetch(input, init);
}

/**
 * The base fetch under a remote MCP connection: undici through the MCP Agent, so every hop
 * of the caller's own redirect guard runs with the MCP connect/headers/body timeouts. The
 * caller wraps it with its redirect guard, response size cap and `withOutboundHttpRetries`.
 */
export async function mcpOutboundBaseFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  mcpAgent ??= createOutboundAgent(mcpOptions);
  return agentFetch(mcpAgent)(input, init);
}

/** The configured MCP outbound options, for callers composing their own fetch stack. */
export function currentMcpOutboundFetchOptions(): OutboundFetchOptions {
  return mcpOptions;
}
