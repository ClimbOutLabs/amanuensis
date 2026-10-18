/** The part of calling a Google product's REST API that does not depend on the product: the user's own login, retries, size caps. */
import { z } from 'zod';
import { GoogleApiError } from './errors';
import type { GoogleAccessTokens } from './GoogleAccessTokens';
import { fetchGoogle } from './oauth';

/** Most times a request is tried when Google says it is busy. */
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 10_000;

/** Largest response read into memory; bigger ones are refused unread. Ordinary answers are far smaller. */
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const ErrorBodySchema = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Why Google refused a request, from the reason it names in the error body. */
function reasonOf(body: unknown): string {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return '';
  }
  const { errors, details } = parsed.data.error;
  return errors?.[0]?.reason ?? details?.[0]?.reason ?? '';
}

const BUSY_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'backendError']);
const API_OFF_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);

/**
 * The JSON body of a response, read without ever holding more than the limit: a Content-Length over it is
 * refused unread, and a body that has none (or lies) is counted as it streams in.
 */
async function readJsonCapped(input: {
  response: Response;
  maxBytes: number;
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = Number(input.response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > input.maxBytes) {
    await input.response.body?.cancel();
    return { ok: false };
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = input.response.body?.getReader();
  if (reader === undefined) {
    return { ok: true, value: undefined };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > input.maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: true, value: undefined };
  }
}

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

/**
 * Whether trying a request again is safe. A request that creates, changes or sends is never repeated after a failure
 * that may have happened after Google acted (a server error, a timeout); only a refusal for going too fast,
 * which Google answers before doing anything, is retried.
 */
function isRetryable(input: { status: number; reason: string; method: RequestMethod }): boolean {
  if (input.method === 'POST' || input.method === 'PATCH') {
    return input.status === 429 || RATE_LIMIT_REASONS.has(input.reason);
  }
  return input.status === 429 || input.status >= 500 || BUSY_REASONS.has(input.reason);
}

function retryDelayMs(input: { response: Response; attempt: number }): number {
  const seconds = Number(input.response.headers.get('retry-after'));
  const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : BACKOFF_BASE_MS * 2 ** input.attempt;
  return Math.min(asked, MAX_RETRY_WAIT_MS);
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface GoogleRestRequest {
  method: RequestMethod;
  path: string;
  query: Query | undefined;
  body: unknown;
  /** Said when the outcome is unknown (no answer, or a server error) for a request that creates or sends. */
  unknownOutcome?: string;
  /** Largest response read; the default fits any list. */
  maxResponseBytes?: number;
}

/** What differs per product: where it lives, what to call it, and the error type its tools catch. */
export interface GoogleRestProduct {
  /** How the product is named to the user, e.g. `Gmail`. */
  name: string;
  baseUrl: string;
  /** Said when the product's API is not turned on in the user's Google project. */
  apiOffMessage: string;
  /** Said when Google refuses for lack of a scope. */
  scopeMessage: string;
  notFoundMessage: string;
  tooLargeMessage: string;
}

function describeFailure(input: { product: GoogleRestProduct; status: number; reason: string }): string {
  const { product, status, reason } = input;
  const busy = `${product.name} is busy right now. Try again in a minute.`;
  if (status === 429 || BUSY_REASONS.has(reason)) {
    return busy;
  }
  if (API_OFF_REASONS.has(reason)) {
    return product.apiOffMessage;
  }
  if (SCOPE_REASONS.has(reason)) {
    return product.scopeMessage;
  }
  switch (status) {
    case 400:
      return `${product.name} did not accept that request.`;
    case 403:
      return "Google didn't allow that. Open Settings, Connectors, Google and check what is turned on.";
    case 404:
      return product.notFoundMessage;
    default:
      return status >= 500
        ? busy
        : `${product.name} could not be reached (HTTP ${String(status)}). Try again in a minute.`;
  }
}

/** A malformed response, even one nested deep enough to overflow the parser, is a failure and not a crash. */
function safeParse<T>(input: { schema: z.ZodType<T>; value: unknown }) {
  try {
    return input.schema.safeParse(input.value);
  } catch (error) {
    return { success: false as const, error };
  }
}

export class GoogleRestClient {
  readonly #tokens: GoogleAccessTokens;
  readonly #fetchImpl: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #product: GoogleRestProduct;

  constructor(input: {
    product: GoogleRestProduct;
    tokens: GoogleAccessTokens;
    fetchImpl: typeof fetch | undefined;
    /** Replaceable so tests do not wait. */
    sleep: ((ms: number) => Promise<void>) | undefined;
  }) {
    this.#product = input.product;
    this.#tokens = input.tokens;
    this.#fetchImpl = input.fetchImpl ?? fetch;
    this.#sleep = input.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async #send(input: GoogleRestRequest): Promise<unknown> {
    const product = this.#product;
    const busy = `${product.name} is busy right now. Try again in a minute.`;
    const url = new URL(`${product.baseUrl}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item);
        }
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const access = await this.#tokens.get();
      let response: Response;
      try {
        response = await fetchGoogle({
          fetchImpl: this.#fetchImpl,
          url: url.toString(),
          init: {
            method: input.method,
            headers: {
              Authorization: `Bearer ${access.access_token}`,
              ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          },
        });
      } catch (error) {
        throw new GoogleApiError({ status: 503, message: input.unknownOutcome ?? busy, cause: error });
      }
      if (response.status === 401 && !refreshed) {
        // A cached token Google no longer honors: refresh once. A refresh Google refuses flips needs-reconnect.
        refreshed = true;
        this.#tokens.invalidate();
        continue;
      }
      if (response.ok) {
        let read: Awaited<ReturnType<typeof readJsonCapped>>;
        try {
          read = await readJsonCapped({ response, maxBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES });
        } catch (error) {
          throw new GoogleApiError({ status: 503, message: input.unknownOutcome ?? busy, cause: error });
        }
        if (!read.ok) {
          throw new GoogleApiError({ status: 502, message: input.unknownOutcome ?? product.tooLargeMessage });
        }
        return read.value;
      }
      const errorBody = await readJsonCapped({ response, maxBytes: MAX_ERROR_BODY_BYTES }).catch(() => undefined);
      const reason = reasonOf(errorBody?.ok === true ? errorBody.value : undefined);
      const failure = { status: response.status, reason, method: input.method };
      if (attempt + 1 < MAX_ATTEMPTS && isRetryable(failure)) {
        await this.#sleep(retryDelayMs({ response, attempt }));
        continue;
      }
      throw new GoogleApiError({
        status: response.status,
        message:
          input.unknownOutcome !== undefined && response.status >= 500
            ? input.unknownOutcome
            : describeFailure({ product, status: response.status, reason }),
      });
    }
  }

  async parsed<T>(schema: z.ZodType<T>, request: GoogleRestRequest): Promise<T> {
    const body = safeParse({ schema, value: await this.#send(request) });
    if (!body.success) {
      throw new GoogleApiError({
        status: 502,
        message: request.unknownOutcome ?? `${this.#product.name} returned a response Aman could not read.`,
        cause: body.error,
      });
    }
    return body.data;
  }
}
