import type { PersonOwner } from '../../db/personOwner';
import type { IScheduleStore } from '../../db/scheduleStore';

/**
 * The time zone a person's day is read in before they ever save Reach me: the one their schedules use, since the
 * assistant set those up in the person's own time, else the one their own calendar is kept in. UTC only when neither
 * says, and the Reach me page offers the browser's time zone the first time it is opened.
 */
export function personTimezoneFor({
  scheduleStore,
  calendarTimezone,
}: {
  scheduleStore: Pick<IScheduleStore<unknown>, 'listSchedules'>;
  calendarTimezone: (owner: PersonOwner) => Promise<string | undefined>;
}): (owner: PersonOwner) => Promise<string> {
  return async owner => {
    const { data } = await scheduleStore.listSchedules({
      tenant_id: owner.tenant_id,
      limit: 1,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: { created_by_subject_id: owner.created_by, agent_ids: [] },
    });
    return data[0]?.manifest.timezone ?? (await calendarTimezone(owner).catch(() => undefined)) ?? 'UTC';
  };
}
