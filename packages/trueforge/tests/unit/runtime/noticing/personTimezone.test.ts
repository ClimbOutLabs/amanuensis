import type { IScheduleStore, ScheduleRecord } from '../../../../src/db/scheduleStore';
import { personTimezoneFor } from '../../../../src/runtime/noticing/personTimezone';
import { ScheduleManifestSchema } from '../../../../src/schemas/schedule';

const OWNER = { tenant_id: 'default', created_by: 'owner-1' };

function schedule(timezone: string): ScheduleRecord {
  return {
    id: 'sch-1',
    tenant_id: 'default',
    agent_id: 'agent-1',
    agent_name: 'assistant',
    name: 'water-plants',
    persona_id: null,
    manifest: ScheduleManifestSchema.parse({
      task: 'Water the plants',
      run_at: '2026-11-06T09:00:00+13:00',
      timezone,
      kind: 'reminder',
    }),
    status: 'active',
    created_by_subject: { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' },
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

describe('personTimezoneFor', () => {
  it('uses the person’s schedules first, then their own calendar’s time zone, and UTC only when neither says', async () => {
    const listSchedules = jest.fn<
      ReturnType<IScheduleStore<unknown>['listSchedules']>,
      Parameters<IScheduleStore<unknown>['listSchedules']>
    >(() => Promise.resolve({ data: [schedule('Pacific/Auckland')], pagination: { limit: 1 } }));
    const calendarTimezone = jest.fn((): Promise<string | undefined> => Promise.resolve('Europe/Paris'));
    let at = new Date('2026-11-06T00:00:00.000Z');
    const later = () => {
      at = new Date(at.getTime() + 7 * 3_600_000);
    };
    const timezoneFor = personTimezoneFor({ scheduleStore: { listSchedules }, calendarTimezone, now: () => at });

    await expect(timezoneFor(OWNER)).resolves.toBe('Pacific/Auckland');
    expect(listSchedules.mock.calls[0]?.[0]).toMatchObject({
      tenant_id: 'default',
      created_by_or_agent_ids: { created_by_subject_id: 'owner-1', agent_ids: [] },
    });
    expect(calendarTimezone).not.toHaveBeenCalled();

    listSchedules.mockResolvedValue({ data: [], pagination: { limit: 1 } });
    await expect(timezoneFor(OWNER)).resolves.toBe('Europe/Paris');
    expect(calendarTimezone).toHaveBeenCalledWith(OWNER);

    later();
    calendarTimezone.mockResolvedValue(undefined);
    await expect(timezoneFor(OWNER)).resolves.toBe('UTC');
    later();
    calendarTimezone.mockRejectedValue(new Error('Google is not reachable'));
    await expect(timezoneFor(OWNER)).resolves.toBe('UTC');
  });

  it('asks the calendar again only after a few hours', async () => {
    const listSchedules = jest.fn<
      ReturnType<IScheduleStore<unknown>['listSchedules']>,
      Parameters<IScheduleStore<unknown>['listSchedules']>
    >(() => Promise.resolve({ data: [], pagination: { limit: 1 } }));
    const calendarTimezone = jest.fn((): Promise<string | undefined> => Promise.resolve('Europe/Paris'));
    let at = new Date('2026-11-06T00:00:00.000Z');
    const timezoneFor = personTimezoneFor({ scheduleStore: { listSchedules }, calendarTimezone, now: () => at });

    await expect(timezoneFor(OWNER)).resolves.toBe('Europe/Paris');
    calendarTimezone.mockResolvedValue('Asia/Tokyo');
    await expect(timezoneFor(OWNER)).resolves.toBe('Europe/Paris');
    await expect(timezoneFor({ tenant_id: 'default', created_by: 'owner-2' })).resolves.toBe('Asia/Tokyo');
    expect(calendarTimezone).toHaveBeenCalledTimes(2);

    at = new Date(at.getTime() + 6 * 3_600_000 + 1);
    await expect(timezoneFor(OWNER)).resolves.toBe('Asia/Tokyo');
  });
});
