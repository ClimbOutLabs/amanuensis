import type { INotificationStore } from '../../src/db/notificationStore';

const SUBJECT_A = { subject_id: 'tester-a', subject_type: 'user', subject_display_name: 'tester-a' } as const;
const SUBJECT_B = { subject_id: 'tester-b', subject_type: 'user', subject_display_name: 'tester-b' } as const;

export function runNotificationStoreContractSuite(getStore: () => INotificationStore<unknown>): void {
  it('creates and retrieves a notification', async () => {
    const store = getStore();
    const created = await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'Reminder: Stand up',
      body: 'Stand up in 10 minutes',
      schedule_id: 'sched-1',
      schedule_run_id: 'run-1',
      created_by_subject: SUBJECT_A,
    });
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe('reminder');
    expect(created.title).toBe('Reminder: Stand up');
    expect(created.body).toBe('Stand up in 10 minutes');
    expect(created.schedule_id).toBe('sched-1');
    expect(created.schedule_run_id).toBe('run-1');
    expect(created.created_by_subject).toEqual(SUBJECT_A);
    expect(created.read_at).toBeNull();
    expect(created.created_at).toMatch(/Z$/);

    const fetched = await store.getNotification({ tenant_id: 'default', id: created.id });
    expect(fetched?.id).toBe(created.id);
    expect(await store.getNotification({ tenant_id: 'default', id: 'missing' })).toBeUndefined();
    // Tenant scoping: the same id is invisible in another tenant.
    expect(await store.getNotification({ tenant_id: 'other', id: created.id })).toBeUndefined();
  });

  it('lists unread first then newest first, scoped by subject', async () => {
    const store = getStore();
    const first = await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'First',
      body: 'body',
      created_by_subject: SUBJECT_A,
    });
    const second = await store.createNotification({
      tenant_id: 'default',
      kind: 'briefing',
      title: 'Second',
      body: 'body',
      created_by_subject: SUBJECT_A,
    });
    await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'Other subject',
      body: 'body',
      created_by_subject: SUBJECT_B,
    });
    await store.markNotificationRead({ tenant_id: 'default', id: first.id });

    const { data } = await store.listNotifications({
      tenant_id: 'default',
      limit: 10,
      created_by_subject_id: SUBJECT_A.subject_id,
    });
    expect(data.map(n => n.id)).toEqual([second.id, first.id]);

    const scoped = await store.listNotifications({
      tenant_id: 'default',
      limit: 10,
      created_by_subject_id: SUBJECT_B.subject_id,
    });
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0].title).toBe('Other subject');
  });

  it('filters by schedule run id', async () => {
    const store = getStore();
    const first = await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'First',
      body: 'body',
      schedule_id: 'sched-1',
      schedule_run_id: 'run-1',
      created_by_subject: SUBJECT_A,
    });
    await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'Second',
      body: 'body',
      schedule_id: 'sched-1',
      schedule_run_id: 'run-2',
      created_by_subject: SUBJECT_A,
    });

    const { data } = await store.listNotifications({
      tenant_id: 'default',
      limit: 10,
      schedule_run_id: 'run-1',
    });
    expect(data.map(n => n.id)).toEqual([first.id]);
  });

  it('marks read and deletes idempotently', async () => {
    const store = getStore();
    const created = await store.createNotification({
      tenant_id: 'default',
      kind: 'schedule_complete',
      title: 'Done',
      body: 'body',
      created_by_subject: SUBJECT_A,
    });

    const read = await store.markNotificationRead({ tenant_id: 'default', id: created.id });
    expect(read?.read_at).not.toBeNull();
    expect(read?.read_at).toMatch(/Z$/);
    expect(await store.markNotificationRead({ tenant_id: 'default', id: 'missing' })).toBeUndefined();

    const deleted = await store.deleteNotification({ tenant_id: 'default', id: created.id });
    expect(deleted).toBe(true);
    const deletedAgain = await store.deleteNotification({ tenant_id: 'default', id: created.id });
    expect(deletedAgain).toBe(false);
  });
}
