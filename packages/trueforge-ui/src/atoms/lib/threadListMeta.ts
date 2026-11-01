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

/** Chats whose title contains the query, ignoring case. A blank query keeps every chat. */
export function filterChatsByTitle<T extends { title: string }>({
  chats,
  query,
}: {
  chats: readonly T[];
  query: string;
}): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...chats];
  return chats.filter(chat => chat.title.toLocaleLowerCase().includes(needle));
}

/** Chats shown in one group before its "Show more" row, and how many more each press adds. */
export const RECENT_CHATS_PAGE_SIZE = 5;

/**
 * Sorts the chats for the Chats column. A chat in a folder lives only in its folder; the rest split
 * into Today (since local midnight) and Earlier. Folders come newest-use first, and folders with no
 * chat keep the order they were given. Within a group chats keep the order they were given.
 */
export function groupRecentChats<T extends { time: number; folderId: string | undefined }>({
  chats,
  folderIds,
  now,
}: {
  chats: readonly T[];
  /** Folder ids in the order to show them when their newest use ties. */
  folderIds: readonly string[];
  now: Date;
}): { folders: { folderId: string; chats: T[] }[]; today: T[]; earlier: T[] } {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const byFolder = new Map<string, T[]>();
  const today: T[] = [];
  const earlier: T[] = [];
  for (const chat of chats) {
    if (chat.folderId !== undefined) {
      byFolder.set(chat.folderId, [...(byFolder.get(chat.folderId) ?? []), chat]);
    } else if (chat.time >= startOfToday) {
      today.push(chat);
    } else {
      earlier.push(chat);
    }
  }
  const newestUse = (list: readonly T[]) =>
    list.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...list.map(chat => chat.time));
  const folderOrder = folderIds
    .map((folderId, order) => ({ folderId, order, list: byFolder.get(folderId) ?? [] }))
    .sort((a, b) => newestUse(b.list) - newestUse(a.list) || a.order - b.order);
  return {
    folders: folderOrder.map(({ folderId, list }) => ({ folderId, chats: list })),
    today,
    earlier,
  };
}

/**
 * The rows a group shows: its first `limit` chats, plus the open chat even when it falls past them,
 * in their original order.
 */
export function visibleChats<T extends { key: string }>({
  chats,
  limit,
  openKey,
}: {
  chats: readonly T[];
  limit: number;
  openKey: string | undefined;
}): T[] {
  return chats.filter((chat, position) => position < limit || chat.key === openKey);
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
