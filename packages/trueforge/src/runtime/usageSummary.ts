/**
 * The arithmetic behind the `usage_summary` tool: which days a period covers and how a person's
 * model calls add up. Costs are the `cost_usd` the usage ledger already priced, so no price is
 * looked up or computed here.
 */
import { resolveLocalTime } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_CHAT_LIMIT = 5;
const UNTITLED_CHAT_LABEL = 'Untitled chat';
const DAY_MS = 86_400_000;

export const USAGE_SUMMARY_INPUT_SCHEMA = z
  .object({
    period: z
      .enum(['today', 'this_week', 'this_month', 'date_range'])
      .default('this_month')
      .describe('today, this_week (from Monday), this_month (from the 1st), or date_range.'),
    start_date: z.string().regex(CALENDAR_DATE_PATTERN).optional().describe('First day, YYYY-MM-DD, for date_range.'),
    end_date: z.string().regex(CALENDAR_DATE_PATTERN).optional().describe('Last day, YYYY-MM-DD, for date_range.'),
  })
  .strict();

export type UsageSummaryInput = z.infer<typeof USAGE_SUMMARY_INPUT_SCHEMA>;

/** A request the person can fix by changing its dates; the message says how. */
export class UsagePeriodError extends Error {
  constructor() {
    super('For a date range, pass start_date and end_date as YYYY-MM-DD, with start_date on or before end_date.');
    this.name = 'UsagePeriodError';
  }
}

/** One usage event as the summary needs it: the chat it belongs to, the model, the tokens and the priced cost. */
export interface UsageEntry {
  session_id: string;
  title: string | null;
  model_id: string;
  display_name: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  created_at: string;
}

/** A period resolved to whole local days; `from` is inclusive and `to` exclusive. */
export interface UsagePeriod {
  fromDate: string;
  toDate: string;
  from: Date;
  to: Date;
  timeZone: string;
}

/** The shared Token Factory cap as the budget reports it, when one is set. */
export interface UsageDailyCap {
  capTokens: number;
  usedTokens: number;
}

export interface UsageSummary {
  period: { from_date: string; to_date: string; time_zone: string };
  total: UsageGroupRow & { input_tokens: number; output_tokens: number };
  by_model: (UsageGroupRow & { model_id: string; display_name: string; input_tokens: number; output_tokens: number })[];
  by_day: (UsageGroupRow & { date: string })[];
  top_chats: (UsageGroupRow & { title: string })[];
  daily_cap: { cap_tokens: number; remaining_tokens: number; scope: 'instance' } | null;
}

/** Tokens and cost for one slice. `cost_usd` is null when the slice's tokens have no known price. */
export interface UsageGroupRow {
  total_tokens: number;
  cost_usd: number | null;
  unpriced_tokens: number;
}

/** Local midnight of a calendar date in a zone, as an instant. */
function localMidnight({ date, zone }: { date: string; zone: string }): Date {
  const [year, month, day] = date.split('-').map(Number);
  const wallClock = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  // The offset is read twice: the second read is at the corrected instant, so a DST change that day is handled.
  const firstGuess = wallClock - offsetMs({ instant: new Date(wallClock), zone });
  return new Date(wallClock - offsetMs({ instant: new Date(firstGuess), zone }));
}

function offsetMs({ instant, zone }: { instant: Date; zone: string }): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(resolveLocalTime(instant, zone).utcOffset);
  if (match === null) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -minutes : minutes) * 60_000;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isCalendarDate(date: string): boolean {
  return CALENDAR_DATE_PATTERN.test(date) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
}

/**
 * Turns a period request into whole local days in the client's zone. `this_week` starts on Monday.
 * `today`, `this_week` and `this_month` run up to today, since the person asked how things stand now.
 */
export function resolveUsagePeriod({
  input,
  now,
  timeZone,
}: {
  input: UsageSummaryInput;
  now: Date;
  timeZone: string | undefined;
}): UsagePeriod {
  const local = resolveLocalTime(now, timeZone);
  const today = local.date;
  const { fromDate, toDate } = periodDates({ input, today });
  return {
    fromDate,
    toDate,
    from: localMidnight({ date: fromDate, zone: local.zone }),
    to: localMidnight({ date: addDays(toDate, 1), zone: local.zone }),
    timeZone: local.zone,
  };
}

function periodDates({ input, today }: { input: UsageSummaryInput; today: string }): {
  fromDate: string;
  toDate: string;
} {
  switch (input.period) {
    case 'today':
      return { fromDate: today, toDate: today };
    case 'this_week': {
      const [year, month, day] = today.split('-').map(Number);
      const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
      return { fromDate: addDays(today, -((weekday + 6) % 7)), toDate: today };
    }
    case 'this_month':
      return { fromDate: `${today.slice(0, 8)}01`, toDate: today };
    case 'date_range': {
      const { start_date: start, end_date: end } = input;
      if (start === undefined || end === undefined || !isCalendarDate(start) || !isCalendarDate(end) || start > end) {
        throw new UsagePeriodError();
      }
      return { fromDate: start, toDate: end };
    }
  }
}

/** Running sums for one slice; cost is the sum of the priced events, unpriced tokens are counted apart. */
class Tally {
  input_tokens = 0;
  output_tokens = 0;
  priced_cost = 0;
  priced_events = 0;
  unpriced_tokens = 0;

  add(entry: UsageEntry): void {
    this.input_tokens += entry.input_tokens;
    this.output_tokens += entry.output_tokens;
    if (entry.cost_usd === null) {
      this.unpriced_tokens += entry.input_tokens + entry.output_tokens;
      return;
    }
    this.priced_cost += entry.cost_usd;
    this.priced_events += 1;
  }

  get total_tokens(): number {
    return this.input_tokens + this.output_tokens;
  }

  /** Null only when some tokens were used and none of them has a known price. */
  get cost_usd(): number | null {
    if (this.priced_events === 0 && this.unpriced_tokens > 0) {
      return null;
    }
    return roundUsd(this.priced_cost);
  }

  row(): UsageGroupRow {
    return { total_tokens: this.total_tokens, cost_usd: this.cost_usd, unpriced_tokens: this.unpriced_tokens };
  }
}

/** Money to six decimal places: enough for a fraction of a cent, free of float noise. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function groupBy<K>(entries: UsageEntry[], key: (entry: UsageEntry) => K): Map<K, UsageEntry[]> {
  const groups = new Map<K, UsageEntry[]>();
  for (const entry of entries) {
    const k = key(entry);
    groups.set(k, [...(groups.get(k) ?? []), entry]);
  }
  return groups;
}

function tallyOf(entries: UsageEntry[]): Tally {
  const tally = new Tally();
  for (const entry of entries) {
    tally.add(entry);
  }
  return tally;
}

/**
 * Adds a person's usage entries for a period into the totals, the split by model and by day, the
 * most expensive chats, and what is left under the daily cap.
 */
export function summarizeUsage({
  entries,
  period,
  cap,
}: {
  entries: UsageEntry[];
  period: UsagePeriod;
  cap: UsageDailyCap | undefined;
}): UsageSummary {
  const total = tallyOf(entries);
  const byModel = [...groupBy(entries, entry => entry.model_id).entries()]
    .map(([modelId, group]) => {
      const tally = tallyOf(group);
      return {
        model_id: modelId,
        display_name: group[0]?.display_name ?? modelId,
        input_tokens: tally.input_tokens,
        output_tokens: tally.output_tokens,
        ...tally.row(),
      };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model_id.localeCompare(b.model_id));
  const byDay = [
    ...groupBy(entries, entry => localDate({ instant: entry.created_at, timeZone: period.timeZone })).entries(),
  ]
    .map(([date, group]) => ({ date, ...tallyOf(group).row() }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const topChats = [...groupBy(entries, entry => entry.session_id).values()]
    .map(group => ({
      title: group[0]?.title ?? UNTITLED_CHAT_LABEL,
      ...tallyOf(group).row(),
    }))
    .sort((a, b) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1) || b.total_tokens - a.total_tokens)
    .slice(0, TOP_CHAT_LIMIT);
  return {
    period: { from_date: period.fromDate, to_date: period.toDate, time_zone: period.timeZone },
    total: { input_tokens: total.input_tokens, output_tokens: total.output_tokens, ...total.row() },
    by_model: byModel,
    by_day: byDay,
    top_chats: topChats,
    daily_cap:
      cap === undefined
        ? null
        : {
            cap_tokens: cap.capTokens,
            remaining_tokens: Math.max(cap.capTokens - cap.usedTokens, 0),
            scope: 'instance',
          },
  };
}

function localDate({ instant, timeZone }: { instant: string; timeZone: string }): string {
  return resolveLocalTime(new Date(instant), timeZone).date;
}
