import type { AgentUIServer, ListSessionsParams } from './types.js';

/** Cached pages go stale after this window so external session changes surface. */
const SESSION_LIST_TTL_MS = 30_000;

type SessionListPage = ReturnType<AgentUIServer['listSessions']>;
type SessionListResolvedPage = Awaited<SessionListPage>;

type CacheEntry = { at: number; page: SessionListPage };

type DeletedMark = { at: number; confirmed: boolean };

type FetchMark = { startedAt: number };

export type SessionListCache = {
  pages: Map<string, CacheEntry>;
  /** Chats deleted through any wrapped server, with the time of the delete. */
  deleted: Map<string, DeletedMark>;
  /** List fetches that have started and not yet landed. */
  inFlight: Set<FetchMark>;
};

export function createSessionListCache(): SessionListCache {
  return { pages: new Map(), deleted: new Map(), inFlight: new Set() };
}

// `startTimestamp` is a rolling "now − 1 year" that differs on every call;
// keying on it would make each request unique and defeat the cache.
function cacheKey(request: ListSessionsParams | undefined): string {
  const rest: ListSessionsParams = { ...request };
  delete rest.startTimestamp;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** True while a fetch that started no later than the delete is still out. */
function hasFetchOutFromBefore(cache: SessionListCache, at: number): boolean {
  for (const fetch of cache.inFlight) {
    if (fetch.startedAt <= at) return true;
  }
  return false;
}

/**
 * Drops tombstones past the window. A tombstone still stays while a fetch that started
 * before the delete is out, however old it gets: that fetch can land at any time, and
 * the tombstone is what filters the deleted chat out of it when it does.
 */
function pruneDeleted(cache: SessionListCache, now: number): void {
  for (const [sessionId, mark] of cache.deleted) {
    if (now - mark.at < SESSION_LIST_TTL_MS) continue;
    if (hasFetchOutFromBefore(cache, mark.at)) continue;
    cache.deleted.delete(sessionId);
  }
}

/**
 * A fetch that started after a delete and lands without the chat confirms the server has
 * caught up with the delete. The tombstone is then spent, and goes once no fetch that
 * started before the delete is still out.
 */
function confirmDeleted(cache: SessionListCache, fetch: FetchMark, page: SessionListResolvedPage): void {
  for (const [sessionId, mark] of cache.deleted) {
    if (fetch.startedAt <= mark.at) continue;
    if (page.data.some(item => item.id === sessionId)) continue;
    mark.confirmed = true;
  }
  clearConfirmed(cache);
}

function clearConfirmed(cache: SessionListCache): void {
  for (const [sessionId, mark] of cache.deleted) {
    if (mark.confirmed && !hasFetchOutFromBefore(cache, mark.at)) cache.deleted.delete(sessionId);
  }
}

/**
 * A page fetched before a chat was deleted can resolve after the delete. Filtering the
 * deleted chats out as the page lands keeps that stale page from bringing the chat back.
 */
function withoutDeletedSessions(page: SessionListResolvedPage, cache: SessionListCache): SessionListResolvedPage {
  if (cache.deleted.size === 0) return page;
  const data = page.data.filter(item => !cache.deleted.has(item.id));
  return data.length === page.data.length ? page : { ...page, data };
}

/** Deduplicates session pages and invalidates them after mutations or TTL expiry. */
export function withSessionListCache({
  server,
  cache,
}: {
  server: AgentUIServer;
  cache: SessionListCache;
}): AgentUIServer {
  const { deleteSession } = server;
  return {
    ...server,
    listSessions(request) {
      const key = cacheKey(request);
      const now = Date.now();
      pruneDeleted(cache, now);
      const entry = cache.pages.get(key);
      if (entry !== undefined && now - entry.at < SESSION_LIST_TTL_MS) return entry.page;
      const fetch: FetchMark = { startedAt: now };
      cache.inFlight.add(fetch);
      const page = server.listSessions(request).then(resolved => {
        confirmDeleted(cache, fetch, resolved);
        return withoutDeletedSessions(resolved, cache);
      });
      cache.pages.set(key, { at: now, page });
      const onSettled = () => {
        cache.inFlight.delete(fetch);
        clearConfirmed(cache);
      };
      void page.then(onSettled, onSettled);
      // Allow failed pages to be retried.
      void page.catch(() => {
        if (cache.pages.get(key)?.page === page) cache.pages.delete(key);
      });
      return page;
    },
    async createSession(request) {
      const result = await server.createSession(request);
      cache.pages.clear();
      return result;
    },
    async updateSession(request) {
      const result = await server.updateSession(request);
      cache.pages.clear();
      return result;
    },
    ...(deleteSession != null
      ? {
          deleteSession: async (request: { sessionId: string }) => {
            await deleteSession.call(server, request);
            cache.deleted.set(request.sessionId, { at: Date.now(), confirmed: false });
            cache.pages.clear();
          },
        }
      : {}),
  };
}
