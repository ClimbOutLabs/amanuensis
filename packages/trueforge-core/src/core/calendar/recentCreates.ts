/**
 * Events created in the last few minutes, per chat. A model that retries a create it already
 * made, or that the owner already approved once, would otherwise put the same event on the
 * calendar twice; when a create matches one of these (same title, same start), the approval card
 * asks first. Kept in memory only: it guards a chat's short window, not the calendar itself.
 */

/** How long a create is remembered for the already-created check: the last few minutes. */
const RECENT_CREATE_WINDOW_MS = 10 * 60_000;

interface RecentCreate {
  titleKey: string;
  startKey: string;
  at: number;
}

const recentByConversation = new Map<string, RecentCreate[]>();

function titleKeyOf(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The start a create names, as one comparable string: the date, or the instant it begins. */
export function createStartKey(input: { date: string | null; dateTime: string | null }): string {
  if (input.date !== null) {
    return `date:${input.date}`;
  }
  if (input.dateTime !== null) {
    const parsed = Date.parse(input.dateTime);
    return Number.isNaN(parsed) ? `text:${input.dateTime}` : `at:${String(parsed)}`;
  }
  return 'none';
}

function prune(conversationId: string, now: number): RecentCreate[] {
  const kept = (recentByConversation.get(conversationId) ?? []).filter(
    entry => now - entry.at <= RECENT_CREATE_WINDOW_MS,
  );
  if (kept.length === 0) {
    recentByConversation.delete(conversationId);
  } else {
    recentByConversation.set(conversationId, kept);
  }
  return kept;
}

/** Records one successful create so a repeat of it in the same chat asks first. */
export function recordRecentCalendarCreate(input: {
  conversationId: string | undefined;
  title: string;
  startKey: string;
  now?: number;
}): void {
  if (input.conversationId === undefined || input.conversationId === '') {
    return;
  }
  const now = input.now ?? Date.now();
  const entries = prune(input.conversationId, now);
  entries.push({ titleKey: titleKeyOf(input.title), startKey: input.startKey, at: now });
  recentByConversation.set(input.conversationId, entries);
}

/** Whether this chat already created an event with this title and start in the window. */
export function wasRecentlyCreated(input: {
  conversationId: string | undefined;
  title: string;
  startKey: string;
  now?: number;
}): boolean {
  if (input.conversationId === undefined || input.conversationId === '') {
    return false;
  }
  const now = input.now ?? Date.now();
  const titleKey = titleKeyOf(input.title);
  return prune(input.conversationId, now).some(
    entry => entry.titleKey === titleKey && entry.startKey === input.startKey,
  );
}

/** Test hook: forget every recorded create. */
export function clearRecentCalendarCreates(): void {
  recentByConversation.clear();
}
