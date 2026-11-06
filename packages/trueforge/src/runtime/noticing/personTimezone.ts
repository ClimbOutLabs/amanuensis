import type { NoticingOwner } from '../../db/noticingStore';
import type { IScheduleStore } from '../../db/scheduleStore';

/**
 * The time zone a person's day is read in before they ever save Reach me: the one their schedules use, since the
 * assistant set those up in the person's own time. Anyone with no schedule gets UTC.
 */
export function scheduleTimezoneFor({
  scheduleStore,
}: {
  scheduleStore: Pick<IScheduleStore<unknown>, 'listSchedules'>;
}): (owner: NoticingOwner) => Promise<string> {
  return async owner => {
    const { data } = await scheduleStore.listSchedules({
      tenant_id: owner.tenant_id,
      limit: 1,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: { created_by_subject_id: owner.created_by, agent_ids: [] },
    });
    return data[0]?.manifest.timezone ?? 'UTC';
  };
}
