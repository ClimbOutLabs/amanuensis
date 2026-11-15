import { zonedInstant } from '@truefoundry/trueforge-core/core/calendar/timeRange';
import { FALLBACK_TIMEZONE, isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';

import type { ReachSettings } from '../../schemas/reach';

function zoneOf(timezone: string): string {
  return isValidTimezone(timezone) ? timezone : FALLBACK_TIMEZONE;
}

function minutesOf(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** The local calendar date of an instant, as `YYYY-MM-DD`. */
function localDate({ instant, zone }: { instant: Date; zone: string }): string {
  // en-CA writes year-month-day.
  return instant.toLocaleDateString('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

function localMinutes({ instant, zone }: { instant: Date; zone: string }): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Whether the person's quiet hours cover an instant. The window may cross midnight (21:00 to 08:00). Quiet hours
 * with the same start and end cover nothing, and turned off they never apply.
 */
export function isQuietNow({
  now,
  quiet,
  timezone,
}: {
  now: Date;
  quiet: ReachSettings['quiet_hours'];
  timezone: string;
}): boolean {
  if (!quiet.enabled) {
    return false;
  }
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) {
    return false;
  }
  const minutes = localMinutes({ instant: now, zone: zoneOf(timezone) });
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The instant the person's current day began, in their time zone. */
export function startOfLocalDay({ now, timezone }: { now: Date; timezone: string }): Date {
  const zone = zoneOf(timezone);
  return zonedInstant({ date: localDate({ instant: now, zone }), hour: 0, minute: 0, zone });
}
