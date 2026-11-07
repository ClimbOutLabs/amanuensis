import type { PersonOwner } from '../../db/personOwner';
import type { IScheduleStore } from '../../db/scheduleStore';

/** How long the time zone a person's calendar is kept in is remembered before it is asked for again. */
const CALENDAR_ZONE_KEPT_MS = 6 * 3_600_000;

/**
 * The time zone a person's day is read in before they ever save Reach me: the one their schedules use, since the
 * assistant set those up in the person's own time, else the one their own calendar is kept in. UTC only when neither
 * says, and the Reach me page offers the browser's time zone the first time it is opened.
 */
export function personTimezoneFor({
  scheduleStore,
  calendarTimezone,
  now = () => new Date(),
}: {
  scheduleStore: Pick<IScheduleStore<unknown>, 'listSchedules'>;
  calendarTimezone: (owner: PersonOwner) => Promise<string | undefined>;
  now?: () => Date;
}): (owner: PersonOwner) => Promise<string> {
  // Every pass asks again for people who never saved Reach me, so the calendar's answer is kept a while.
  const remembered = new Map<string, { zone: string | undefined; until: number }>();
  const calendarZone = async (owner: PersonOwner): Promise<string | undefined> => {
    const key = `${owner.tenant_id}\u0000${owner.created_by}`;
    const kept = remembered.get(key);
    if (kept !== undefined && kept.until > now().getTime()) {
      return kept.zone;
    }
    const zone = await calendarTimezone(owner);
    remembered.set(key, { zone, until: now().getTime() + CALENDAR_ZONE_KEPT_MS });
    return zone;
  };
  return async owner => {
    const { data } = await scheduleStore.listSchedules({
      tenant_id: owner.tenant_id,
      limit: 1,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: { created_by_subject_id: owner.created_by, agent_ids: [] },
    });
    return data[0]?.manifest.timezone ?? (await calendarZone(owner).catch(() => undefined)) ?? 'UTC';
  };
}
