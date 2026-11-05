import type { IScheduleStore, ScheduleRecord } from '../../../../src/db/scheduleStore';
import { scheduleTimezoneFor } from '../../../../src/runtime/noticing/personTimezone';
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

describe('scheduleTimezoneFor', () => {
  it('uses the time zone of the person’s own schedules, and UTC when they have none', async () => {
    const listSchedules = jest.fn<
      ReturnType<IScheduleStore<unknown>['listSchedules']>,
      Parameters<IScheduleStore<unknown>['listSchedules']>
    >(() => Promise.resolve({ data: [schedule('Pacific/Auckland')], pagination: { limit: 1 } }));
    await expect(scheduleTimezoneFor({ scheduleStore: { listSchedules } })(OWNER)).resolves.toBe('Pacific/Auckland');
    expect(listSchedules.mock.calls[0]?.[0]).toMatchObject({
      tenant_id: 'default',
      created_by_or_agent_ids: { created_by_subject_id: 'owner-1', agent_ids: [] },
    });

    listSchedules.mockResolvedValueOnce({ data: [], pagination: { limit: 1 } });
    await expect(scheduleTimezoneFor({ scheduleStore: { listSchedules } })(OWNER)).resolves.toBe('UTC');
  });
});
