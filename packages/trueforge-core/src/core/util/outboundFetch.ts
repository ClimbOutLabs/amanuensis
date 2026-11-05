import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Outbound HTTP for model providers and remote MCP: one undici Agent per audience, carrying
 * short connect waits so a dead endpoint fails fast, plus retries for the failures that mean
 * the request never reached the server (or, for replayable callers, may not have been
 * processed). Retries only ever replay a request before its response body is consumed.
 *
 * Ported from upstream trueforge #894 and #756, adapted to this fork: upstream builds these
 * fetches on its SSRF guard's pinned DNS lookup; the fork checks outbound addresses at each
 * call site instead, so this module owns only the timeouts and the retries. The MCP body
 * timeout lives here too: an idle MCP event stream is silent for long stretches, and undici's
 * default 300s bodyTimeout kills it, so the connection drops and reconnects every few minutes.
 */

export interface OutboundFetchOptions {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  maxRetries: number;
  /**
   * Whether requests are safe to replay after upstream may have received them. When false,
   * headers timeouts and 409/520/524 are not retried.
   */
  idempotent: boolean;
}

export interface OutboundFetch {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

/** Model outbound undici connect timeout. Env: `MODEL_HTTP_CONNECT_TIMEOUT_MS`. */
export const DEFAULT_MODEL_HTTP_CONNECT_TIMEOUT_MS = 5_000;
/**
 * Model outbound undici headersTimeout. Env: `MODEL_HTTP_HEADERS_TIMEOUT_MS`.
 * 5 minutes, the same as the model's default first-chunk wait (VercelAILLM `firstChunkMs`) and
 * undici's own default that model calls ran on before: a local model that is still loading sends
 * no headers until its first token, and must not be cut off sooner than the first-chunk wait.
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
 * MCP outbound undici headersTimeout. Env: `MCP_HTTP_HEADERS_TIMEOUT_MS`.
 * Matches the default MCP request timeout: a JSON-response server sends headers only after
 * the tool finishes.
 */
export const DEFAULT_MCP_HTTP_HEADERS_TIMEOUT_MS = 4 * 60 * 1000;
/**
 * MCP outbound undici bodyTimeout. Env: `MCP_HTTP_BODY_TIMEOUT_MS`.
 * Default 30m so an idle event stream is not killed at undici's 300s.
 */
export const DEFAULT_MCP_HTTP_BODY_TIMEOUT_MS = 30 * 60 * 1000;
/** MCP outbound fetch retries. Env: `MCP_HTTP_MAX_RETRIES`. */
export const DEFAULT_MCP_HTTP_MAX_RETRIES = 2;

export function defaultModelOutboundFetchOptions(): OutboundFetchOptions {
  return {
    connectTimeoutMs: DEFAULT_MODEL_HTTP_CONNECT_TIMEOUT_MS,
    headersTimeoutMs: DEFAULT_MODEL_HTTP_HEADERS_TIMEOUT_MS,
    bodyTimeoutMs: DEFAULT_MODEL_HTTP_BODY_TIMEOUT_MS,
    maxRetries: DEFAULT_MODEL_HTTP_MAX_RETRIES,
    idempotent: true,
  };
}

export function defaultMcpOutboundFetchOptions(): OutboundFetchOptions {
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
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER_FACTOR = 0.2;
// Longer server-requested waits fall back to backoff rather than stalling the caller.
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

/** Connect / headers-read timeouts from undici (including nested under TypeError: fetch failed). */
export function isRetryableOutboundTransportError(error: unknown, options: { idempotent: boolean }): boolean {
  const code = getErrorCode(error);
  if (code === 'UND_ERR_CONNECT_TIMEOUT') {
    return true;
  }
  return options.idempotent && code === 'UND_ERR_HEADERS_TIMEOUT';
}

function isRetryableOutboundStatus(status: number, options: { idempotent: boolean }): boolean {
  return UNPROCESSED_RETRY_STATUSES.has(status) || (options.idempotent && MAYBE_PROCESSED_RETRY_STATUSES.has(status));
}

/** Server-requested delay from `retry-after-ms` or `retry-after` (seconds or HTTP date), if usable. */
function retryAfterMs(headers: { get(name: string): string | null }): number | undefined {
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
  if (delayMs === undefined || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_RETRY_AFTER_MS) {
    return undefined;
  }
  return delayMs;
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
 * Retry `fetchFn` on the failures that mean the request never got an answer: connect timeouts,
 * retryable gateway statuses, and (for idempotent callers only) headers timeouts and statuses
 * where upstream may already have processed the request. Honors Retry-After up to 5s, else
 * backs off. A retry replays the request from the start; response bodies are never consumed
 * before the decision, so nothing already streaming is ever replayed.
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
        delayMs = retryAfterMs(response.headers) ?? delayMs;
        void response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (!isRetryableOutboundTransportError(error, { idempotent }) || attempt >= maxRetries || signal?.aborted) {
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
export function createOutboundFetch(options: OutboundFetchOptions): OutboundFetch {
  const agent = createOutboundAgent(options);
  const retried = withOutboundHttpRetries(agentFetch(agent), options);
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
let modelOutbound: OutboundFetch | undefined;
let mcpOptions: OutboundFetchOptions = defaultMcpOutboundFetchOptions();
let mcpAgent: Agent | undefined;

/** Replace the outbound Agents (timeouts and retries) from server configuration. */
export function configureOutboundFetches(config: { model: OutboundFetchOptions; mcp: OutboundFetchOptions }): void {
  const previousModel = modelOutbound;
  const previousMcpAgent = mcpAgent;
  modelOptions = config.model;
  modelOutbound = undefined;
  mcpOptions = config.mcp;
  mcpAgent = undefined;
  void previousModel?.close();
  void previousMcpAgent?.close().catch(() => undefined);
}

/** Drop-in fetch for model-provider HTTP, with the model timeouts and retries. */
export async function modelOutboundFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  modelOutbound ??= createOutboundFetch(modelOptions);
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
