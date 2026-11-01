/**
 * Cron evaluation for schedules.
 *
 * `cron-parser` is used for computation only; it owns no timers. Expressions are
 * evaluated in the schedule's IANA zone. On a spring-forward gap, a time that
 * does not exist (e.g. 02:30) maps onto the landing hour (03:30); fall-back
 * repeats are not double-fired for a fixed hour. Callers that care about the
 * exact UTC instant should prefer `timezone: "UTC"`.
 */
import { CronExpressionParser } from 'cron-parser';
import { InvalidCronError, SCHEDULE_MIN_INTERVAL_SECONDS, type ScheduleManifest } from '../schemas/schedule';

/** How many consecutive triggers to sample when measuring the tightest gap. */
const INTERVAL_PROBE_TRIGGERS = 5;

/**
 * Next trigger time strictly after `from`, in `timezone`.
 *
 * Throws {@link InvalidCronError} when the expression parses structurally
 * but cannot produce a trigger time — e.g. `0 0 30 2 *`, February 30th.
 */
export function nextTriggerAfter(input: { cron: string; timezone: string; from: Date }): Date {
  const { cron, timezone, from } = input;
  try {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: from,
      tz: timezone,
    });
    return interval.next().toDate();
  } catch (error) {
    throw new InvalidCronError(`Cron expression "${cron}" has no next trigger time in ${timezone}`, { cause: error });
  }
}

/**
 * Tightest gap the expression can produce, in seconds, measured over the next
 * {@link INTERVAL_PROBE_TRIGGERS} triggers.
 *
 * Sampling rather than analysis: a cron field can be irregular (`0 9,9 * * *`,
 * `*\/7 * * * *`), and DST transitions can make some real gaps shorter than the
 * nominal one. Probing the actual sequence is both simpler and more honest than
 * reasoning about the fields.
 */
export function minIntervalSeconds(input: { cron: string; timezone: string }, from: Date = new Date()): number {
  const interval = CronExpressionParser.parse(input.cron, {
    currentDate: from,
    tz: input.timezone,
  });

  let previous = interval.next().toDate();
  let tightest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < INTERVAL_PROBE_TRIGGERS; i++) {
    const current = interval.next().toDate();
    tightest = Math.min(tightest, (current.getTime() - previous.getTime()) / 1000);
    previous = current;
  }
  return tightest;
}

/**
 * When a schedule's next run is due, counted from `from`. A one-time schedule is due at its own time,
 * even if that time has already passed (a late dispatch still runs it once).
 */
export function firstRunAfter(input: {
  manifest: Pick<ScheduleManifest, 'cron' | 'run_at' | 'timezone'>;
  from: Date;
}): Date {
  const { manifest, from } = input;
  if (manifest.run_at !== null) {
    return new Date(manifest.run_at);
  }
  if (manifest.cron === null) {
    throw new InvalidCronError('This schedule has no time. Give it a repeating time or a single run time.');
  }
  return nextTriggerAfter({ cron: manifest.cron, timezone: manifest.timezone, from });
}

export function validateManifest(
  manifest: Pick<ScheduleManifest, 'cron' | 'run_at' | 'timezone' | 'status'>,
  from: Date = new Date(),
): void {
  if (manifest.run_at !== null) {
    // The hourly minimum is for repeating schedules only. A finished or paused one-time schedule may keep its old time.
    if (manifest.status === 'active' && new Date(manifest.run_at).getTime() <= from.getTime()) {
      throw new InvalidCronError('That time has already passed. Pick a time in the future and try again.');
    }
    return;
  }
  if (manifest.cron === null) {
    throw new InvalidCronError('This schedule has no time. Give it a repeating time or a single run time.');
  }
  const { cron } = manifest;
  // Reject if the cron has no upcoming trigger time (impossible / exhausted calendar).
  // 5-field cron has no year, so a valid expression always recurs — no one-shot check.
  try {
    nextTriggerAfter({ cron, timezone: manifest.timezone, from });
  } catch (error) {
    throw new InvalidCronError(`Cron expression "${cron}" has no next trigger time in ${manifest.timezone}`, {
      cause: error,
    });
  }

  // Reject expressions that trigger < SCHEDULE_MIN_INTERVAL_SECONDS seconds apart.
  let tightest: number;
  try {
    tightest = minIntervalSeconds({ cron, timezone: manifest.timezone }, from);
  } catch (error) {
    throw new InvalidCronError(`Cron expression "${cron}" has no next trigger time in ${manifest.timezone}`, {
      cause: error,
    });
  }

  if (tightest < SCHEDULE_MIN_INTERVAL_SECONDS) {
    throw new InvalidCronError(
      `Cron expression "${cron}" triggers every ${String(tightest)}s; the minimum interval is ${String(
        SCHEDULE_MIN_INTERVAL_SECONDS,
      )}s`,
    );
  }
}
