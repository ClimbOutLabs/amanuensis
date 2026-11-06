import { z } from 'zod';

/** The one place the Tavily wire facts live: host, endpoints, request shape, credit rules. */
export const TAVILY_API_HOST = 'api.tavily.com';
/** Host of the Tavily preset connector; choosing it as the search provider selects this client. */
export const TAVILY_CONNECTOR_HOST = 'mcp.tavily.com';
export const TAVILY_SEARCH_ENDPOINT = '/search';
export const TAVILY_EXTRACT_ENDPOINT = '/extract';

export const TAVILY_SEARCH_TOOL_NAME = 'tavily_search';
export const TAVILY_EXTRACT_TOOL_NAME = 'tavily_extract';
export const TAVILY_SOURCE_TOOLS = [TAVILY_SEARCH_TOOL_NAME, TAVILY_EXTRACT_TOOL_NAME] as const;

/** An advanced search costs 2 credits; the extract of up to 5 pages costs 1. */
export const TAVILY_SEARCH_CREDITS = 2;
export const TAVILY_MAX_EXTRACT_URLS = 3;

const SEARCH_MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 40_000;
/** Page-side wait Tavily is asked to apply, in seconds (its documented range is 1 to 60). */
const EXTRACT_PAGE_TIMEOUT_SECONDS = 20;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The preset connector ships this untouched value in its Authorization header. */
const PRESET_KEY_PLACEHOLDER = 'YOUR_TAVILY_API_KEY';
const BEARER_PREFIX = /^Bearer\s+/i;

export type TavilyAuth = { kind: 'key'; key: string } | { kind: 'keyless' };

export function isTavilyConnectorUrl(url: string): boolean {
  try {
    return new URL(url).hostname === TAVILY_CONNECTOR_HOST;
  } catch {
    return false;
  }
}

/** A missing or untouched key means keyless, which Tavily allows for search and extract only. */
export function tavilyAuthFromHeader(header: string | undefined): TavilyAuth {
  const key = header === undefined ? '' : header.replace(BEARER_PREFIX, '').trim();
  return key === '' || key === PRESET_KEY_PLACEHOLDER ? { kind: 'keyless' } : { kind: 'key', key };
}

/** Basic extraction: 1 credit for every 5 successful pages; failed pages are free. */
export function extractCreditsFor(successfulPages: number): number {
  return Math.ceil(successfulPages / 5);
}

export interface TavilySearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** A picture Tavily's image search found for the query, with its description when Tavily wrote one. */
export interface TavilySearchImage {
  url: string;
  description: string | null;
}

export interface TavilySearchOutcome {
  hits: TavilySearchHit[];
  images: TavilySearchImage[];
}

export interface TavilyPage {
  url: string;
  title: string | null;
  text: string;
}

export interface TavilyExtractOutcome {
  pages: TavilyPage[];
  failed: { url: string; error: string }[];
}

/** Message is written for the person using the app: what happened, then the one thing to do. */
export class TavilyError extends Error {
  readonly status: number | null;

  constructor(input: { message: string; status: number | null; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'TavilyError';
    this.status = input.status;
  }
}

/** With descriptions asked for, Tavily lists each image as an object; without them, as a bare link. */
const searchImageSchema = z.union([z.string(), z.object({ url: z.string(), description: z.string().nullish() })]);

const searchResponseSchema = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string(), content: z.string() })),
  images: z.array(searchImageSchema).nullish(),
});
const extractResponseSchema = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().nullish(), raw_content: z.string() })),
  failed_results: z.array(z.object({ url: z.string(), error: z.string() })).default([]),
});

export type TavilyFetch = (url: string, init: RequestInit) => Promise<Response>;

function statusMessage({ status, auth }: { status: number; auth: TavilyAuth }): string {
  if (status === 401) {
    return 'Tavily did not accept your key. Open Settings, then Connectors, then Tavily, and paste the key again.';
  }
  if (status === 429) {
    return auth.kind === 'keyless'
      ? 'The free Tavily allowance is used up for now. Add a free key in Settings, then Connectors, then Tavily, or try again in a few minutes.'
      : 'Tavily is getting too many requests. Wait a minute and ask again.';
  }
  if (status === 432 || status === 433) {
    return 'Your Tavily plan has no credits left. Add credits in your Tavily account, or wait for next month.';
  }
  if (status >= 500) {
    return 'Tavily had a problem on their side. Try again in a few minutes.';
  }
  return 'Tavily could not use this request. Ask again in different words.';
}

async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const read: { done: boolean; value?: unknown } = await reader.read();
    if (read.done) {
      return text + decoder.decode();
    }
    if (!(read.value instanceof Uint8Array)) {
      await reader.cancel();
      return null;
    }
    total += read.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(read.value, { stream: true });
  }
}

/** The single Tavily client: builds the request, applies the key or the keyless header, and explains failures. */
export class TavilyClient {
  readonly #auth: TavilyAuth;
  readonly #fetch: TavilyFetch;

  constructor(input: { auth: TavilyAuth; fetchImpl: TavilyFetch }) {
    this.#auth = input.auth;
    this.#fetch = input.fetchImpl;
  }

  get keyless(): boolean {
    return this.#auth.kind === 'keyless';
  }

  async search({
    query,
    signal,
    includeDomains,
  }: {
    query: string;
    signal: AbortSignal | undefined;
    /**
     * When set, Tavily is asked to restrict results to these domains. A request-side
     * narrowing only: callers that must keep other domains out filter the results
     * themselves, because a domain still covers every path under it.
     */
    includeDomains?: readonly string[] | undefined;
  }): Promise<TavilySearchOutcome> {
    // Pictures cost no extra credit, and a space may only show a picture the chat has seen, so every
    // search asks for them rather than guessing when the person will want one.
    const body = await this.#post({
      endpoint: TAVILY_SEARCH_ENDPOINT,
      payload: {
        query,
        search_depth: 'advanced',
        max_results: SEARCH_MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true,
        ...(includeDomains === undefined || includeDomains.length === 0
          ? {}
          : { include_domains: [...includeDomains], include_domains_mode: 'restrict' }),
      },
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal,
    });
    const parsed = searchResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TavilyError({
        message: 'Aman could not read the answer from Tavily. Try again in a few minutes.',
        status: null,
        cause: parsed.error,
      });
    }
    return {
      hits: parsed.data.results.map(hit => ({ title: hit.title, url: hit.url, snippet: hit.content })),
      images: (parsed.data.images ?? []).map(image =>
        typeof image === 'string'
          ? { url: image, description: null }
          : { url: image.url, description: image.description ?? null },
      ),
    };
  }

  async extract({
    urls,
    signal,
  }: {
    urls: readonly string[];
    signal: AbortSignal | undefined;
  }): Promise<TavilyExtractOutcome> {
    const body = await this.#post({
      endpoint: TAVILY_EXTRACT_ENDPOINT,
      payload: { urls, extract_depth: 'basic', format: 'markdown', timeout: EXTRACT_PAGE_TIMEOUT_SECONDS },
      timeoutMs: EXTRACT_TIMEOUT_MS,
      signal,
    });
    const parsed = extractResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TavilyError({
        message: 'Aman could not read the answer from Tavily. Try again in a few minutes.',
        status: null,
        cause: parsed.error,
      });
    }
    return {
      pages: parsed.data.results.map(page => ({ url: page.url, title: page.title ?? null, text: page.raw_content })),
      failed: parsed.data.failed_results,
    };
  }

  async #post({
    endpoint,
    payload,
    timeoutMs,
    signal,
  }: {
    endpoint: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal | undefined;
  }): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#auth.kind === 'key') {
      headers['Authorization'] = `Bearer ${this.#auth.key}`;
    } else {
      headers['X-Tavily-Access-Mode'] = 'keyless';
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`https://${TAVILY_API_HOST}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        // A redirect would carry the key to another host.
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      throw new TavilyError({
        message: 'Aman could not reach Tavily. Check your internet connection and try again.',
        status: null,
        cause: error,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TavilyError({
        message: statusMessage({ status: response.status, auth: this.#auth }),
        status: response.status,
      });
    }
    const text = await readCapped(response);
    if (text === null) {
      throw new TavilyError({
        message: 'The answer from Tavily was too large to use. Ask a narrower question.',
        status: null,
      });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new TavilyError({
        message: 'Aman could not read the answer from Tavily. Try again in a few minutes.',
        status: null,
        cause: error,
      });
    }
  }
}
