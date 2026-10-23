import type { MemoryVaultEntry } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

/** Where a memory is kept: your own memories, a persona's, or a shared topic. */
export type MemoryOwner = 'you' | 'shared' | 'persona';

export type ExplorerMemory = MemoryVaultEntry & { owner: MemoryOwner };

/** `persona:<name>` narrows to one persona's memories. */
export type OwnerFilter = 'everyone' | 'you' | 'shared' | `persona:${string}`;

export type SavedFilter = 'any' | 'today' | 'week' | 'month' | 'range';

const PERSONA_PREFIX = 'persona:';

/** Reads an owner-filter select value; anything unrecognised means everyone. */
export function ownerFilterFromValue(value: string): OwnerFilter {
  if (value === 'you' || value === 'shared') return value;
  if (value.startsWith(PERSONA_PREFIX)) return `${PERSONA_PREFIX}${value.slice(PERSONA_PREFIX.length)}`;
  return 'everyone';
}

export type MemoryFilters = {
  query: string;
  owner: OwnerFilter;
  saved: SavedFilter;
  /** Local calendar day, `YYYY-MM-DD`, or empty for no lower bound. Used only by the `range` filter. */
  from: string;
  /** Local calendar day, `YYYY-MM-DD`, or empty for no upper bound. Used only by the `range` filter. */
  to: string;
  changedRecently: boolean;
};

export const DEFAULT_MEMORY_FILTERS: MemoryFilters = {
  query: '',
  owner: 'everyone',
  saved: 'any',
  from: '',
  to: '',
  changedRecently: false,
};

/** "Recently changed" and "This week" both look back this many days, today included. */
export const RECENT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Local midnight for a `YYYY-MM-DD` value, or null when the value is not a real day. */
function parseLocalDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The half-open time window `[start, end)` a saved-when filter allows, or null for no limit. */
function savedWindow(options: { filters: MemoryFilters; now: Date }): { start: number; end: number } | null {
  const { filters, now } = options;
  const today = startOfDay(now);
  switch (filters.saved) {
    case 'any':
      return null;
    case 'today':
      return { start: today.getTime(), end: addDays(today, 1).getTime() };
    case 'week':
      return { start: addDays(today, 1 - RECENT_DAYS).getTime(), end: addDays(today, 1).getTime() };
    case 'month':
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
      };
    case 'range': {
      const from = parseLocalDay(filters.from);
      const to = parseLocalDay(filters.to);
      return {
        start: from?.getTime() ?? -Infinity,
        end: to === null ? Infinity : addDays(to, 1).getTime(),
      };
    }
  }
}

function ownerMatches(memory: ExplorerMemory, owner: OwnerFilter): boolean {
  if (owner === 'everyone') return true;
  if (owner === 'you' || owner === 'shared') return memory.owner === owner;
  return memory.owner === 'persona' && owner === `${PERSONA_PREFIX}${memory.persona ?? ''}`;
}

/** Memories that match every active filter, newest first. Input order is kept when it is already newest first. */
export function filterMemories(options: {
  memories: ExplorerMemory[];
  filters: MemoryFilters;
  now: Date;
}): ExplorerMemory[] {
  const { memories, filters, now } = options;
  const needle = filters.query.trim().toLowerCase();
  const window = savedWindow({ filters, now });
  const recentStart = addDays(startOfDay(now), 1 - RECENT_DAYS).getTime();

  return memories.filter(memory => {
    if (needle !== '' && !memory.text.toLowerCase().includes(needle)) return false;
    if (!ownerMatches(memory, filters.owner)) return false;
    const time = Date.parse(memory.timestamp);
    if (window !== null && !(time >= window.start && time < window.end)) return false;
    if (filters.changedRecently && !(time >= recentStart)) return false;
    return true;
  });
}

/** Newest first; a timestamp that does not parse sorts last. */
export function sortNewestFirst(memories: ExplorerMemory[]): ExplorerMemory[] {
  const time = (memory: ExplorerMemory) => {
    const parsed = Date.parse(memory.timestamp);
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  return [...memories].sort((a, b) => time(b) - time(a));
}

/** The heading for a memory's day: Today, Yesterday, Last week, or the month and year. */
export function dateGroupLabel(options: { timestamp: string; now: Date }): string {
  const time = Date.parse(options.timestamp);
  if (Number.isNaN(time)) return 'Earlier';
  const days = Math.round((startOfDay(options.now).getTime() - startOfDay(new Date(time)).getTime()) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= RECENT_DAYS) return 'Last week';
  return new Date(time).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** Groups memories that are already sorted newest first; each group keeps that order. */
export function groupMemoriesByDate(options: {
  memories: ExplorerMemory[];
  now: Date;
}): Array<{ label: string; memories: ExplorerMemory[] }> {
  const groups: Array<{ label: string; memories: ExplorerMemory[] }> = [];
  for (const memory of options.memories) {
    const label = dateGroupLabel({ timestamp: memory.timestamp, now: options.now });
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) {
      last.memories.push(memory);
    } else {
      groups.push({ label, memories: [memory] });
    }
  }
  return groups;
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function formatCount(count: number): string {
  return NUMBER_FORMAT.format(count);
}

/** "Juniper remembers 1,240 things about you. 86 belong to specialists." */
export function memoryCountCopy(options: { total: number; personas: number; assistant: string }): string {
  const thing = options.total === 1 ? 'thing' : 'things';
  let specialists: string;
  if (options.personas === 0) specialists = 'None belong to specialists.';
  else if (options.personas === 1) specialists = '1 belongs to a specialist.';
  else specialists = `${formatCount(options.personas)} belong to specialists.`;
  return `${options.assistant} remembers ${formatCount(options.total)} ${thing} about you. ${specialists}`;
}

export function forgetConfirmCopy({ count, assistant }: { count: number; assistant: string }): string {
  const noun = count === 1 ? 'memory' : 'memories';
  return `Forget ${formatCount(count)} ${noun}? ${assistant} won't use them again.`;
}

export function forgottenCopy(count: number): string {
  return count === 1 ? 'Forgot 1 memory.' : `Forgot ${formatCount(count)} memories.`;
}
