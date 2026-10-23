/** Compact relative age for sidebar session rows (e.g. 30m, 22h, 1d). */
export function formatRelativeShort(date: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * Indices into `threadIds` ordered newest-first by `lastMessageAt`.
 * Stabilizes UI when assistant-ui appends a switched-to thread at the end.
 * Missing `lastMessageAt` (empty local "New Chat") sorts as newest so it stays on top.
 */
export function threadListIndicesByRecency({
  threadIds,
  threadItems,
}: {
  threadIds: readonly string[];
  threadItems: readonly { id: string; remoteId?: string | null; lastMessageAt?: Date | null }[];
}): number[] {
  const timeByKey = new Map<string, number>();
  for (const item of threadItems) {
    // Empty / not-yet-messaged threads have no timestamp; treat as newest.
    const t = item.lastMessageAt?.getTime() ?? Number.POSITIVE_INFINITY;
    timeByKey.set(item.id, t);
    if (item.remoteId != null) timeByKey.set(item.remoteId, t);
  }
  return threadIds
    .map((id, index) => ({ index, t: timeByKey.get(id) ?? 0 }))
    .sort((a, b) => b.t - a.t || a.index - b.index)
    .map(row => row.index);
}

/** Indices of the threads whose title contains the query, ignoring case. A blank query keeps every index. */
export function filterIndicesByTitle({
  indices,
  threadIds,
  threadItems,
  query,
}: {
  indices: readonly number[];
  threadIds: readonly string[];
  threadItems: readonly { id: string; remoteId?: string | null; title?: string | null }[];
  query: string;
}): number[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...indices];
  const titleByKey = new Map<string, string>();
  for (const item of threadItems) {
    const title = item.title ?? '';
    titleByKey.set(item.id, title);
    if (item.remoteId != null) titleByKey.set(item.remoteId, title);
  }
  return indices.filter(index => {
    const id = threadIds[index];
    if (id === undefined) return false;
    return (titleByKey.get(id) ?? '').toLocaleLowerCase().includes(needle);
  });
}

/**
 * Splits indices into threads used since local midnight and older ones. A thread with no message yet
 * counts as today, the same way the recency sort treats it as newest.
 */
export function splitIndicesByDay({
  indices,
  threadIds,
  threadItems,
  now,
}: {
  indices: readonly number[];
  threadIds: readonly string[];
  threadItems: readonly { id: string; remoteId?: string | null; lastMessageAt?: Date | null }[];
  now: Date;
}): { today: number[]; earlier: number[] } {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const timeByKey = new Map<string, number>();
  for (const item of threadItems) {
    const t = item.lastMessageAt?.getTime() ?? Number.POSITIVE_INFINITY;
    timeByKey.set(item.id, t);
    if (item.remoteId != null) timeByKey.set(item.remoteId, t);
  }
  const today: number[] = [];
  const earlier: number[] = [];
  for (const index of indices) {
    const id = threadIds[index];
    const t = id === undefined ? 0 : (timeByKey.get(id) ?? 0);
    if (t >= startOfToday) {
      today.push(index);
    } else {
      earlier.push(index);
    }
  }
  return { today, earlier };
}

export function readThreadAgentName(custom: unknown): string | undefined {
  if (custom == null || typeof custom !== 'object') return undefined;
  if (!('agentName' in custom)) return undefined;
  const value = Reflect.get(custom, 'agentName');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Session mutability from thread-list custom (runtime ≥ isMutable stamp). */
export function readThreadIsMutable(custom: unknown): boolean | undefined {
  if (custom == null || typeof custom !== 'object') return undefined;
  if (!('isMutable' in custom)) return undefined;
  const value = Reflect.get(custom, 'isMutable');
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Prefer `custom.isMutable`; fall back to agentName presence for older runtimes
 * that only stamped `agentName` on named rows.
 */
export function threadListItemIsMutable(custom: unknown): boolean {
  return readThreadIsMutable(custom) ?? readThreadAgentName(custom) == null;
}

/**
 * Fast-path `switchToThread` for mutable history rows only when Edit chrome is
 * safe to keep. Blank drafts (no agentName/agentId) may share one shell; an
 * Edit-bound shell must remount via `openHistorySession` when leaving its
 * pending session so Update does not keep the previous agentName over another
 * draft's runtime spec.
 */
export function canReuseMutableShell({
  sessionMutable,
  shellMutable,
  shellAgentName,
  shellAgentId,
  remoteId,
  pendingSessionId,
}: {
  sessionMutable: boolean;
  shellMutable: boolean;
  shellAgentName?: string;
  shellAgentId?: string;
  remoteId?: string | null;
  pendingSessionId?: string;
}): boolean {
  if (!sessionMutable || !shellMutable) return false;
  const editBound = (shellAgentName != null && shellAgentName !== '') || (shellAgentId != null && shellAgentId !== '');
  if (!editBound) return true;
  return remoteId != null && remoteId === pendingSessionId;
}
