import { useCallback, useMemo } from 'react';

/**
 * Caps for the reward ladder. Every rung asks the ledger before it plays, so
 * no screen can over-reward. The ledger lives in localStorage, keyed by local
 * day and week; it never leaves the browser.
 */

const STORAGE_KEY = 'aui-reward-ledger';
const TEAR_WINDOW_MS = 60_000;
const HIGHLIGHTS_PER_BRIEF = 3;

/** What the screen shows right now. A reward never plays while anything here is true. */
export type RewardContext = {
  /** Aman is working. */
  busy: boolean;
  /** Something waits on the person, such as an approval. */
  waitingOnPerson: boolean;
  /** The screen shows an error. */
  hasError: boolean;
  /** A schedule failed today. Blocks the all-clear only. */
  scheduleFailedToday: boolean;
};

/** One reward a screen may want to play. */
export type RewardRequest =
  /** A finished line: an item completed by the person or Aman. */
  | { kind: 'tick' }
  /** A line that matters in a brief. At most three per brief. */
  | { kind: 'highlight'; briefId: string }
  /** An approval the person gave. At most one tear per minute. */
  | { kind: 'tear' }
  /** The day's all-clear: the count of things waiting went to zero. Once a day. */
  | { kind: 'allClear' }
  /** The first brief of the week. Once a week, and also counts as the day's all-clear. */
  | { kind: 'firstBrief' }
  /** A milestone such as 10, 25, 50 or 100 handled replies. Each key plays once. */
  | { kind: 'milestone'; key: string }
  /** A handwritten note. Once a week, never two days in a row. */
  | { kind: 'note' };

export type RewardLedger = {
  /** Local day of the last all-clear or first brief. */
  lastClearDay: string | null;
  /** Local week (its Monday) of the last first brief. */
  lastFirstBriefWeek: string | null;
  /** Milestone keys that have played. */
  milestones: string[];
  /** The brief the highlight count belongs to, and how many it has used. */
  highlightBriefId: string | null;
  highlightCount: number;
  /** Epoch milliseconds of the last tear. */
  lastTearAt: number | null;
  /** Local day of the last note, and its week. */
  lastNoteDay: string | null;
  lastNoteWeek: string | null;
};

export const EMPTY_REWARD_LEDGER: RewardLedger = {
  lastClearDay: null,
  lastFirstBriefWeek: null,
  milestones: [],
  highlightBriefId: null,
  highlightCount: 0,
  lastTearAt: null,
  lastNoteDay: null,
  lastNoteWeek: null,
};

/** Local calendar day as YYYY-MM-DD. */
export function localDayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/** The local Monday of this week, as a day key. Weeks run Monday to Sunday. */
export function localWeekKey(now: Date): string {
  const sinceMonday = (now.getDay() + 6) % 7;
  return localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday));
}

function previousDayKey(now: Date): string {
  return localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}

function isBlocked(context: RewardContext): boolean {
  return context.busy || context.waitingOnPerson || context.hasError;
}

/**
 * Whether `request` may play now. Pure: reads the ledger and the screen, writes nothing.
 * Tear, highlight and note are checked by their caps; all of them stop while
 * Aman is working, something waits on the person, or the screen shows an error.
 */
export function canPlayReward({
  ledger,
  request,
  context,
  now,
}: {
  ledger: RewardLedger;
  request: RewardRequest;
  context: RewardContext;
  now: Date;
}): boolean {
  if (isBlocked(context)) return false;
  const today = localDayKey(now);
  switch (request.kind) {
    case 'tick':
      return true;
    case 'highlight': {
      if (ledger.highlightBriefId !== request.briefId) return true;
      return ledger.highlightCount < HIGHLIGHTS_PER_BRIEF;
    }
    case 'tear':
      return ledger.lastTearAt === null || now.getTime() - ledger.lastTearAt >= TEAR_WINDOW_MS;
    case 'allClear':
      return !context.scheduleFailedToday && ledger.lastClearDay !== today;
    case 'firstBrief':
      return (
        !context.scheduleFailedToday && ledger.lastClearDay !== today && ledger.lastFirstBriefWeek !== localWeekKey(now)
      );
    case 'milestone':
      return !ledger.milestones.includes(request.key);
    case 'note': {
      if (ledger.lastNoteWeek === localWeekKey(now)) return false;
      return ledger.lastNoteDay !== today && ledger.lastNoteDay !== previousDayKey(now);
    }
  }
}

/** The ledger after `request` has played. Call only once `canPlayReward` said yes. */
export function recordReward({
  ledger,
  request,
  now,
}: {
  ledger: RewardLedger;
  request: RewardRequest;
  now: Date;
}): RewardLedger {
  const today = localDayKey(now);
  switch (request.kind) {
    case 'tick':
      return ledger;
    case 'highlight': {
      const sameBrief = ledger.highlightBriefId === request.briefId;
      return {
        ...ledger,
        highlightBriefId: request.briefId,
        highlightCount: sameBrief ? ledger.highlightCount + 1 : 1,
      };
    }
    case 'tear':
      return { ...ledger, lastTearAt: now.getTime() };
    case 'allClear':
      return { ...ledger, lastClearDay: today };
    case 'firstBrief':
      return { ...ledger, lastClearDay: today, lastFirstBriefWeek: localWeekKey(now) };
    case 'milestone':
      return { ...ledger, milestones: [...ledger.milestones, request.key] };
    case 'note':
      return { ...ledger, lastNoteDay: today, lastNoteWeek: localWeekKey(now) };
  }
}

function readLedger(): RewardLedger {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return EMPTY_REWARD_LEDGER;
    const parsed: unknown = JSON.parse(raw);
    return isRewardLedger(parsed) ? parsed : EMPTY_REWARD_LEDGER;
  } catch {
    return EMPTY_REWARD_LEDGER;
  }
}

function writeLedger(ledger: RewardLedger): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    /* Storage can be blocked; the caps then reset per page load, which is acceptable for decoration. */
  }
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isRewardLedger(value: unknown): value is RewardLedger {
  if (typeof value !== 'object' || value === null) return false;
  const field = (name: string): unknown => Reflect.get(value, name);
  const milestones = field('milestones');
  return (
    isStringOrNull(field('lastClearDay')) &&
    isStringOrNull(field('lastFirstBriefWeek')) &&
    Array.isArray(milestones) &&
    milestones.every(key => typeof key === 'string') &&
    isStringOrNull(field('highlightBriefId')) &&
    typeof field('highlightCount') === 'number' &&
    isNumberOrNull(field('lastTearAt')) &&
    isStringOrNull(field('lastNoteDay')) &&
    isStringOrNull(field('lastNoteWeek'))
  );
}

/**
 * Reads and writes the ledger. `tryPlay` answers whether a reward may play and,
 * when it may, records it. Call it once per reward, at the moment it starts.
 */
export function useRewardLedger(): {
  tryPlay: (options: { request: RewardRequest; context: RewardContext; now?: Date }) => boolean;
} {
  const tryPlay = useCallback(
    ({ request, context, now = new Date() }: { request: RewardRequest; context: RewardContext; now?: Date }) => {
      const ledger = readLedger();
      if (!canPlayReward({ ledger, request, context, now })) return false;
      writeLedger(recordReward({ ledger, request, now }));
      return true;
    },
    [],
  );
  return useMemo(() => ({ tryPlay }), [tryPlay]);
}

export type HighlightCandidates = {
  /** The first approval waiting on the person, from the approval the composer or rail points at. */
  firstWaitingApprovalId: string | null;
  /** The next appointment on the brief, by its stop. */
  nextAppointmentId: string | null;
};

/**
 * The one card per screen that takes the gold fill and edge. The first waiting
 * approval wins; else the next appointment; else none.
 */
export function pickHighlightedCard({ firstWaitingApprovalId, nextAppointmentId }: HighlightCandidates): string | null {
  return firstWaitingApprovalId ?? nextAppointmentId ?? null;
}

/** The id of the card that carries `.aui-ticket--selected` on this screen, or null. */
export function useHighlightedCard(candidates: HighlightCandidates): string | null {
  const { firstWaitingApprovalId, nextAppointmentId } = candidates;
  return useMemo(
    () => pickHighlightedCard({ firstWaitingApprovalId, nextAppointmentId }),
    [firstWaitingApprovalId, nextAppointmentId],
  );
}
