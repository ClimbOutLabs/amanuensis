/**
 * Short-lived server memory of the pages `tavily_extract` returned, so a place claim can be checked
 * against the text the model actually saw. Keyed by URL because a held call resumes in a new turn
 * and a per-turn memory would be gone by then; the text is public page content, never stored on
 * disk and never logged.
 */
export interface FetchedPage {
  url: string;
  text: string;
  /** Stamped here, from the server clock. */
  fetched_at: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PAGES = 50;

export class FetchedPageStore {
  readonly #pages = new Map<string, FetchedPage & { expires_at: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPages: number;

  constructor(input: { now: () => number; ttlMs: number; maxPages: number }) {
    this.#now = input.now;
    this.#ttlMs = input.ttlMs;
    this.#maxPages = input.maxPages;
  }

  remember({ url, text }: { url: string; text: string }): FetchedPage {
    const now = this.#now();
    const page: FetchedPage = { url, text, fetched_at: new Date(now).toISOString() };
    this.#pages.delete(url);
    this.#pages.set(url, { ...page, expires_at: now + this.#ttlMs });
    while (this.#pages.size > this.#maxPages) {
      const oldest = this.#pages.keys().next();
      if (oldest.done) {
        break;
      }
      this.#pages.delete(oldest.value);
    }
    return page;
  }

  recall(url: string): FetchedPage | undefined {
    const stored = this.#pages.get(url);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.expires_at <= this.#now()) {
      this.#pages.delete(url);
      return undefined;
    }
    return { url: stored.url, text: stored.text, fetched_at: stored.fetched_at };
  }
}

/** The one memory the Tavily tools write and the pin tool reads. */
export const fetchedPages = new FetchedPageStore({
  now: Date.now,
  ttlMs: DEFAULT_TTL_MS,
  maxPages: DEFAULT_MAX_PAGES,
});
