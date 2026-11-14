/**
 * Backend-agnostic behavioural contract for ITelegramStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ITelegramStore, SaveTelegramConnectionInput } from '../../src/db/telegramStore';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };

const SUBJECT = { subject_id: 'alice', subject_type: 'owner', subject_display_name: 'Alice' };

function bot(owner: { tenant_id: string; created_by: string }, token = '123:token'): SaveTelegramConnectionInput {
  return {
    ...owner,
    created_by_subject: SUBJECT,
    bot_token: token,
    bot_id: '4242',
    bot_name: 'Test Bot',
    bot_username: 'test_bot',
    transport: 'polling',
    webhook_secret: null,
  };
}

export function runTelegramStoreContractSuite(getStore: () => ITelegramStore): void {
  it('saves a connection that reads back whole, and only for its owner', async () => {
    const store = getStore();
    const saved = await store.saveConnection(bot(ALICE));
    expect(saved.bot_name).toBe('Test Bot');
    expect(saved.paired_telegram_user_id).toBeNull();
    await expect(store.getConnection(ALICE)).resolves.toEqual(saved);
    await expect(store.getConnection(BOB)).resolves.toBeUndefined();
    await expect(store.getConnectionById({ id: saved.id })).resolves.toEqual(saved);
    await expect(store.listConnections()).resolves.toEqual([saved]);
  });

  it('pairs through a stored code and clears the code once paired', async () => {
    const store = getStore();
    await store.saveConnection(bot(ALICE));
    await store.startPairing({
      ...ALICE,
      code: '123456',
      expires_at: new Date(Date.now() + 60_000),
      telegram_user_id: '555',
      chat_id: '777',
      display_name: 'Alice A',
    });
    const waiting = await store.getConnection(ALICE);
    expect(waiting?.pairing_code).toBe('123456');
    expect(waiting?.pairing_telegram_user_id).toBe('555');
    expect(waiting?.pairing_display_name).toBe('Alice A');
    await expect(store.confirmPairing({ ...ALICE, code: '123456' })).resolves.toBe(true);
    const paired = await store.getConnection(ALICE);
    expect(paired?.paired_telegram_user_id).toBe('555');
    expect(paired?.paired_chat_id).toBe('777');
    expect(paired?.pairing_code).toBeNull();
    expect(paired?.pairing_display_name).toBeNull();
  });

  it('a code a newer /start replaced pairs nobody, and the newer pairing still waits', async () => {
    const store = getStore();
    await store.saveConnection(bot(ALICE));
    await store.startPairing({
      ...ALICE,
      code: '111111',
      expires_at: new Date(Date.now() + 60_000),
      telegram_user_id: '555',
      chat_id: '777',
      display_name: 'Alice A',
    });
    await store.startPairing({
      ...ALICE,
      code: '222222',
      expires_at: new Date(Date.now() + 60_000),
      telegram_user_id: '999',
      chat_id: '888',
      display_name: 'Mallory M',
    });
    await expect(store.confirmPairing({ ...ALICE, code: '111111' })).resolves.toBe(false);
    const waiting = await store.getConnection(ALICE);
    expect(waiting?.paired_telegram_user_id).toBeNull();
    expect(waiting?.pairing_telegram_user_id).toBe('999');
    expect(waiting?.pairing_code).toBe('222222');
  });

  it('claims each update once, in order, per connection', async () => {
    const store = getStore();
    const saved = await store.saveConnection(bot(ALICE));
    await expect(store.claimUpdate({ connection_id: saved.id, update_id: '10' })).resolves.toBe(true);
    await expect(store.claimUpdate({ connection_id: saved.id, update_id: '10' })).resolves.toBe(false);
    await expect(store.claimUpdate({ connection_id: saved.id, update_id: '9' })).resolves.toBe(false);
    await expect(store.claimUpdate({ connection_id: saved.id, update_id: '11' })).resolves.toBe(true);
    await expect(store.claimUpdate({ connection_id: 'no-such-connection', update_id: '12' })).resolves.toBe(false);
    const connection = await store.getConnection(ALICE);
    expect(connection?.last_update_id).toBe('11');
  });

  it('replacing the bot starts unpaired and drops what was waiting', async () => {
    const store = getStore();
    const first = await store.saveConnection(bot(ALICE));
    await store.startPairing({
      ...ALICE,
      code: '123456',
      expires_at: new Date(Date.now() + 60_000),
      telegram_user_id: '555',
      chat_id: '777',
      display_name: 'Alice A',
    });
    await store.confirmPairing({ ...ALICE, code: '123456' });
    await store.addPendingReply({
      ...ALICE,
      connection_id: first.id,
      session_id: 's1',
      turn_id: 'turn-1',
      chat_id: '777',
    });
    const second = await store.saveConnection(bot(ALICE, '999:other'));
    expect(second.id).not.toBe(first.id);
    expect(second.paired_telegram_user_id).toBeNull();
    await expect(store.listPendingReplies({ limit: 10 })).resolves.toEqual([]);
  });

  it('keeps one pending reply per turn and clears it by id', async () => {
    const store = getStore();
    const saved = await store.saveConnection(bot(ALICE));
    const input = { ...ALICE, connection_id: saved.id, session_id: 's1', turn_id: 'turn-1', chat_id: '777' };
    await store.addPendingReply(input);
    await store.addPendingReply(input);
    const rows = await store.listPendingReplies({ limit: 10 });
    expect(rows).toHaveLength(1);
    await store.deletePendingReply({ id: rows[0]?.id ?? '' });
    await expect(store.listPendingReplies({ limit: 10 })).resolves.toEqual([]);
  });

  it('stores a pending approval and reads it back by the id its buttons carry', async () => {
    const store = getStore();
    const saved = await store.saveConnection(bot(ALICE));
    const pending = await store.addPendingApproval({
      ...ALICE,
      connection_id: saved.id,
      session_id: 's1',
      turn_id: 'turn-1',
      thread_id: 'main',
      tool_call_id: 'call-1',
      chat_id: '777',
      prompt: 'Send the email?',
      expires_at: null,
    });
    await expect(store.getPendingApproval({ id: pending.id })).resolves.toEqual(pending);
    await store.deletePendingApproval({ id: pending.id });
    await expect(store.getPendingApproval({ id: pending.id })).resolves.toBeUndefined();
  });

  it('remembers the poll offset and the session id', async () => {
    const store = getStore();
    await store.saveConnection(bot(ALICE));
    await store.setPollOffset({ ...ALICE, poll_offset: '42' });
    await store.setSessionId({ ...ALICE, session_id: 'session-9' });
    const connection = await store.getConnection(ALICE);
    expect(connection?.poll_offset).toBe('42');
    expect(connection?.session_id).toBe('session-9');
  });

  it('finds a webhook connection by its secret', async () => {
    const store = getStore();
    const saved = await store.saveConnection({ ...bot(ALICE), transport: 'webhook', webhook_secret: 's3cret' });
    await expect(store.getConnectionByWebhookSecret({ webhook_secret: 's3cret' })).resolves.toEqual(saved);
    await expect(store.getConnectionByWebhookSecret({ webhook_secret: 'nope' })).resolves.toBeUndefined();
  });

  it('deleting the connection removes it and everything waiting on it', async () => {
    const store = getStore();
    const saved = await store.saveConnection(bot(ALICE));
    await store.addPendingReply({
      ...ALICE,
      connection_id: saved.id,
      session_id: 's1',
      turn_id: 'turn-1',
      chat_id: '777',
    });
    await expect(store.deleteConnection(ALICE)).resolves.toBe(true);
    await expect(store.deleteConnection(ALICE)).resolves.toBe(false);
    await expect(store.getConnection(ALICE)).resolves.toBeUndefined();
    await expect(store.listPendingReplies({ limit: 10 })).resolves.toEqual([]);
  });
}
