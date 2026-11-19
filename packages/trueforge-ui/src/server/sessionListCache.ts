import type { AgentUIServer, ListSessionsParams } from './types.js';

/** Cached pages go stale after this window so external session changes surface. */
const SESSION_LIST_TTL_MS = 30_000;

type SessionListPage = ReturnType<AgentUIServer['listSessions']>;
type SessionListResolvedPage = Awaited<SessionListPage>;

type CacheEntry = { at: number; page: SessionListPage };

export type SessionListCache = {
  pages: Map<string, CacheEntry>;
  /** Chats deleted through any wrapped server, with the time of the delete. */
  deleted: Map<string, number>;
};

export function createSessionListCache(): SessionListCache {
  return { pages: new Map(), deleted: new Map() };
}

// `startTimestamp` is a rolling "now − 1 year" that differs on every call;
// keying on it would make each request unique and defeat the cache.
function cacheKey(request: ListSessionsParams | undefined): string {
  const rest: ListSessionsParams = { ...request };
  delete rest.startTimestamp;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** Drops tombstones old enough that no fetch started before the delete can still land. */
function pruneDeleted(cache: SessionListCache, now: number): void {
  for (const [sessionId, at] of cache.deleted) {
    if (now - at >= SESSION_LIST_TTL_MS) cache.deleted.delete(sessionId);
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
      const page = server.listSessions(request).then(resolved => withoutDeletedSessions(resolved, cache));
      cache.pages.set(key, { at: now, page });
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
            cache.deleted.set(request.sessionId, Date.now());
            cache.pages.clear();
          },
        }
      : {}),
  };
}
