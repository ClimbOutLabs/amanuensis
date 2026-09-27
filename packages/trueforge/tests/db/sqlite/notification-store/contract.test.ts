import { SqliteNotificationStore } from '../../../../src/db/sqlite/notification-store/SqliteNotificationStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const SUBJECT = { subject_id: 'tester', subject_type: 'user', subject_display_name: 'tester' } as const;

describe('SqliteNotificationStore', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  it('creates and retrieves a notification', async () => {
    const store = new SqliteNotificationStore(env.db);
    const created = await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'Reminder: Stand up',
      body: 'Stand up in 10 minutes',
      created_by_subject: SUBJECT,
    });
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe('reminder');
    expect(created.read_at).toBeNull();

    const fetched = await store.getNotification({ tenant_id: 'default', id: created.id });
    expect(fetched?.id).toBe(created.id);
  });

  it('lists unread first then newest first', async () => {
    const store = new SqliteNotificationStore(env.db);
    const first = await store.createNotification({
      tenant_id: 'default',
      kind: 'reminder',
      title: 'First',
      body: 'body',
      created_by_subject: SUBJECT,
    });
    const second = await store.createNotification({
      tenant_id: 'default',
      kind: 'briefing',
      title: 'Second',
      body: 'body',
      created_by_subject: SUBJECT,
    });
    await store.markNotificationRead({ tenant_id: 'default', id: first.id });

    const { data } = await store.listNotifications({ tenant_id: 'default', limit: 10 });
    expect(data[0].id).toBe(second.id);
    expect(data[1].id).toBe(first.id);
  });

  it('marks read and deletes idempotently', async () => {
    const store = new SqliteNotificationStore(env.db);
    const created = await store.createNotification({
      tenant_id: 'default',
      kind: 'schedule_complete',
      title: 'Done',
      body: 'body',
      created_by_subject: SUBJECT,
    });

    const read = await store.markNotificationRead({ tenant_id: 'default', id: created.id });
    expect(read?.read_at).not.toBeNull();

    const deleted = await store.deleteNotification({ tenant_id: 'default', id: created.id });
    expect(deleted).toBe(true);
    const deletedAgain = await store.deleteNotification({ tenant_id: 'default', id: created.id });
    expect(deletedAgain).toBe(false);
  });
});
