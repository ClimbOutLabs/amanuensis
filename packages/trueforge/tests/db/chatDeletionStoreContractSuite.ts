/**
 * Backend-agnostic contract for IChatDeletionStore: a deleted chat leaves no row or blob behind
 * except its token counts, and the receipts of what it did (approval tokens, the action audit)
 * stay. Each test starts from empty tables.
 */
import { MAIN_THREAD_ID } from '@truefoundry/trueforge-core/agent-session';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import type { ApprovalTokenStore } from '@truefoundry/trueforge-core/core';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnDoneEvent,
} from '../../../trueforge-core/tests/agent-session/testHelpers';
import type { IChatDeletionStore } from '../../src/db/chatDeletionStore';
import type { IChatImageStore } from '../../src/db/chatImageStore';
import type { ICompletedTurnEventStore } from '../../src/db/completedTurnEvents';
import type { ISentinelAuditStore } from '../../src/db/sentinelAuditStore';
import type { SessionCustom, TurnCustom } from '../../src/db/sessionCustom';
import type { ITurnArtifactStore } from '../../src/db/turnArtifactStore';
import { MODEL_USAGE_EVENT_TYPE, type ModelUsagePersistedEvent } from '../../src/schemas/modelUsageEvents';

/** Tables, on both backends, whose rows belong to one chat and must go when it is deleted. */
export const CHAT_OWNED_TABLES = [
  'session',
  'turn',
  'turn_thread',
  'thread_context_log',
  'thread_capability_state',
  'session_event',
  'chat_image',
  'chat_search_document',
  'turn_artifact',
] as const;

export interface ChatDeletionStoreContractFixtures {
  sessions: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  deletion: IChatDeletionStore;
  artifacts: ITurnArtifactStore;
  images: IChatImageStore;
  approvalTokens: ApprovalTokenStore;
  audit: ISentinelAuditStore;
  /** CHAT_OWNED_TABLES plus any the backend alone has. */
  chatOwnedTables: readonly string[];
  countChatRows: (input: { table: string; session_id: string }) => Promise<number>;
  countBlobs: () => Promise<number>;
  countApprovalTokens: () => Promise<number>;
}

const TENANT = 'default';
const OWNER = 'user-a';
const HOUR_MS = 60 * 60 * 1000;

async function createChat({
  fixtures,
  sessionId,
  privateExpiresAt,
}: {
  fixtures: ChatDeletionStoreContractFixtures;
  sessionId: string;
  privateExpiresAt: Date | null;
}): Promise<void> {
  await fixtures.sessions.createSession({
    tenant_id: TENANT,
    session_id: sessionId,
    created_by_subject: { subject_id: OWNER, subject_type: 'user', subject_display_name: OWNER },
    external_id: null,
    source: null,
    metadata: {},
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
    is_incognito: privateExpiresAt !== null,
    private_expires_at: privateExpiresAt,
  });
}

function usageEvent({ id, inputTokens }: { id: string; inputTokens: number }): ModelUsagePersistedEvent {
  return {
    type: MODEL_USAGE_EVENT_TYPE,
    id,
    created_at: new Date().toISOString(),
    role: 'chat',
    model_name: 'anthropic/claude',
    model_id: 'claude-test',
    display_name: 'Claude Test',
    provider: 'anthropic',
    calls: 1,
    reported_calls: 1,
    input_tokens: inputTokens,
    output_tokens: 7,
    cost_usd: 0.25,
  };
}

/** One finished turn with thread context, a usage event, a picture, a search row and a saved file. */
async function fillChat({
  fixtures,
  sessionId,
  fileBytes,
}: {
  fixtures: ChatDeletionStoreContractFixtures;
  sessionId: string;
  fileBytes: string;
}): Promise<void> {
  const turnId = `${sessionId}-turn`;
  await fixtures.sessions.createTurn(
    makeCreateTurnInput({
      sessionId,
      turnId,
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [{ role: 'user', content: 'the private question' }],
          current_context_usage: null,
        },
      ],
      capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: { 'tfy.test': { value: 1 } } }],
    }),
  );
  const state = makeDoneTurnState();
  await fixtures.sessions.updateTurnState({
    session_id: sessionId,
    turn_id: turnId,
    state,
    turn_done_event: makeTurnDoneEvent(state),
  });
  await fixtures.sessions.appendEventsToDoneTurn({
    session_id: sessionId,
    turn_id: turnId,
    events: [usageEvent({ id: `${sessionId}-usage`, inputTokens: 40 })],
  });
  await fixtures.sessions.indexChatMessages({
    tenant_id: TENANT,
    session_id: sessionId,
    turn_id: turnId,
    persona_id: null,
    documents: [{ message_id: 'm1', role: 'user', text: 'the private question', created_at: new Date() }],
  });
  await fixtures.images.putImage({
    tenant_id: TENANT,
    created_by: OWNER,
    session_id: sessionId,
    turn_id: turnId,
    image_id: sessionId.padEnd(32, '0').slice(0, 32),
    source_key: 'upload:0',
    origin: 'local',
    mime: 'image/png',
    width: 1,
    height: 1,
    data: Buffer.from('invented-png'),
    user_max_bytes: 1024 * 1024,
  });
  await fixtures.artifacts.recordStoredArtifact({
    tenant_id: TENANT,
    session_id: sessionId,
    turn_id: turnId,
    path: '/tmp/notes.txt',
    name: 'notes.txt',
    data: Buffer.from(fileBytes),
    mime: 'text/plain',
  });
}

async function chatRowCounts({
  fixtures,
  sessionId,
}: {
  fixtures: ChatDeletionStoreContractFixtures;
  sessionId: string;
}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of fixtures.chatOwnedTables) {
    counts.set(table, await fixtures.countChatRows({ table, session_id: sessionId }));
  }
  return counts;
}

export function runChatDeletionStoreContractSuite(getFixtures: () => ChatDeletionStoreContractFixtures): void {
  it('deletes every row and file of the chat, and keeps its token counts', async () => {
    const fixtures = getFixtures();
    await createChat({ fixtures, sessionId: 'gone', privateExpiresAt: new Date(Date.now() + HOUR_MS) });
    await fillChat({ fixtures, sessionId: 'gone', fileBytes: 'only in the private chat' });

    const before = await chatRowCounts({ fixtures, sessionId: 'gone' });
    for (const table of fixtures.chatOwnedTables) {
      expect({ table, seeded: (before.get(table) ?? 0) > 0 }).toEqual({ table, seeded: true });
    }
    expect(await fixtures.countBlobs()).toBe(1);

    expect(await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: 'gone', expired_by: undefined })).toBe(
      true,
    );

    const after = await chatRowCounts({ fixtures, sessionId: 'gone' });
    for (const table of fixtures.chatOwnedTables) {
      expect({ table, rows: after.get(table) }).toEqual({ table, rows: 0 });
    }
    expect(await fixtures.countBlobs()).toBe(0);

    const usage = await fixtures.deletion.listDeletedChatModelUsage({
      tenant_id: TENANT,
      created_by_subject_id: OWNER,
      from: new Date(Date.now() - HOUR_MS),
      to: new Date(Date.now() + HOUR_MS),
    });
    expect(
      usage.map(record => ({
        event_id: record.event_id,
        model_id: record.model_id,
        display_name: record.display_name,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        cost_usd: record.cost_usd,
      })),
    ).toEqual([
      {
        event_id: 'gone-usage',
        model_id: 'claude-test',
        display_name: 'Claude Test',
        input_tokens: 40,
        output_tokens: 7,
        cost_usd: 0.25,
      },
    ]);
    expect(usage.every(record => !Number.isNaN(Date.parse(record.created_at)))).toBe(true);
  });

  it('keeps the approval tokens and the action audit of a deleted chat', async () => {
    const fixtures = getFixtures();
    await createChat({ fixtures, sessionId: 'gone', privateExpiresAt: new Date(Date.now() + HOUR_MS) });
    await fixtures.approvalTokens.mint({
      tenant_id: TENANT,
      created_by: OWNER,
      expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
      action_id: 'send-email',
      canonical_params: { to: 'friend@example.com' },
    });
    await fixtures.audit.record({
      tenant_id: TENANT,
      created_by: OWNER,
      conversation_id: 'gone',
      tier: 3,
      tool_name: 'send_email',
      description: 'Sent an email to a friend',
      outcome: 'approved',
      auto_deny_reason: null,
    });

    await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: 'gone', expired_by: undefined });

    expect(await fixtures.countApprovalTokens()).toBe(1);
    const audit = await fixtures.audit.listOwned({ tenant_id: TENANT, created_by: OWNER, limit: 10, offset: 0 });
    expect(audit).toEqual([
      expect.objectContaining({ conversation_id: 'gone', tool_name: 'send_email', outcome: 'approved' }),
    ]);
  });

  it('leaves other chats, and a file another chat also saved, in place', async () => {
    const fixtures = getFixtures();
    await createChat({ fixtures, sessionId: 'gone', privateExpiresAt: null });
    await createChat({ fixtures, sessionId: 'kept', privateExpiresAt: null });
    await fillChat({ fixtures, sessionId: 'gone', fileBytes: 'shared bytes' });
    await fillChat({ fixtures, sessionId: 'kept', fileBytes: 'shared bytes' });

    await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: 'gone', expired_by: undefined });

    const kept = await chatRowCounts({ fixtures, sessionId: 'kept' });
    for (const table of fixtures.chatOwnedTables) {
      expect({ table, kept: (kept.get(table) ?? 0) > 0 }).toEqual({ table, kept: true });
    }
    expect(await fixtures.countBlobs()).toBe(1);
  });

  it('returns false for a chat that does not exist, or in another tenant', async () => {
    const fixtures = getFixtures();
    await createChat({ fixtures, sessionId: 'kept', privateExpiresAt: null });

    expect(await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: 'nope', expired_by: undefined })).toBe(
      false,
    );
    expect(await fixtures.deletion.deleteChat({ tenant_id: 'other', session_id: 'kept', expired_by: undefined })).toBe(
      false,
    );
    expect(await fixtures.countChatRows({ table: 'session', session_id: 'kept' })).toBe(1);
  });

  it('with expired_by, deletes only a private chat whose time is up', async () => {
    const fixtures = getFixtures();
    const now = new Date();
    await createChat({ fixtures, sessionId: 'expired', privateExpiresAt: new Date(now.getTime() - HOUR_MS) });
    await createChat({ fixtures, sessionId: 'still-open', privateExpiresAt: new Date(now.getTime() + HOUR_MS) });
    await createChat({ fixtures, sessionId: 'normal', privateExpiresAt: null });

    for (const sessionId of ['still-open', 'normal']) {
      expect(await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: sessionId, expired_by: now })).toBe(
        false,
      );
      expect(await fixtures.countChatRows({ table: 'session', session_id: sessionId })).toBe(1);
    }
    expect(await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: 'expired', expired_by: now })).toBe(
      true,
    );
    expect(await fixtures.countChatRows({ table: 'session', session_id: 'expired' })).toBe(0);
  });

  it('deletes every private chat, expired or not, and its files, and leaves normal chats', async () => {
    const fixtures = getFixtures();
    const now = new Date();
    await createChat({ fixtures, sessionId: 'expired', privateExpiresAt: new Date(now.getTime() - HOUR_MS) });
    await createChat({ fixtures, sessionId: 'still-open', privateExpiresAt: new Date(now.getTime() + HOUR_MS) });
    await createChat({ fixtures, sessionId: 'normal', privateExpiresAt: null });
    await fillChat({ fixtures, sessionId: 'still-open', fileBytes: 'private file' });

    expect(await fixtures.deletion.deletePrivateChats()).toBe(2);
    for (const table of fixtures.chatOwnedTables) {
      expect(await fixtures.countChatRows({ table, session_id: 'still-open' })).toBe(0);
    }
    expect(await fixtures.countBlobs()).toBe(0);
    expect(await fixtures.countChatRows({ table: 'session', session_id: 'expired' })).toBe(0);
    expect(await fixtures.countChatRows({ table: 'session', session_id: 'normal' })).toBe(1);
  });

  it('removes files saved for a chat that no longer exists, and only those', async () => {
    const fixtures = getFixtures();
    await createChat({ fixtures, sessionId: 'kept', privateExpiresAt: null });
    await fixtures.artifacts.recordStoredArtifact({
      tenant_id: TENANT,
      session_id: 'kept',
      turn_id: 't1',
      path: '/tmp/kept.txt',
      name: 'kept.txt',
      data: Buffer.from('kept bytes'),
      mime: 'text/plain',
    });
    await fixtures.artifacts.recordStoredArtifact({
      tenant_id: TENANT,
      session_id: 'already-deleted',
      turn_id: 't1',
      path: '/tmp/late.txt',
      name: 'late.txt',
      data: Buffer.from('saved after the delete'),
      mime: 'text/plain',
    });

    expect(await fixtures.deletion.deleteOrphanedArtifacts()).toBe(1);
    expect(await fixtures.countChatRows({ table: 'turn_artifact', session_id: 'already-deleted' })).toBe(0);
    expect(await fixtures.countChatRows({ table: 'turn_artifact', session_id: 'kept' })).toBe(1);
    expect(await fixtures.countBlobs()).toBe(1);
    expect(await fixtures.deletion.deleteOrphanedArtifacts()).toBe(0);
  });

  it('lists kept counts for one person in the time window, oldest first', async () => {
    const fixtures = getFixtures();
    for (const sessionId of ['first', 'second']) {
      await createChat({ fixtures, sessionId, privateExpiresAt: null });
      await fillChat({ fixtures, sessionId, fileBytes: sessionId });
      await fixtures.deletion.deleteChat({ tenant_id: TENANT, session_id: sessionId, expired_by: undefined });
    }
    const window = { from: new Date(Date.now() - HOUR_MS), to: new Date(Date.now() + HOUR_MS) };

    const mine = await fixtures.deletion.listDeletedChatModelUsage({
      tenant_id: TENANT,
      created_by_subject_id: OWNER,
      ...window,
    });
    expect(mine.map(row => row.event_id)).toEqual(['first-usage', 'second-usage']);
    expect(
      await fixtures.deletion.listDeletedChatModelUsage({
        tenant_id: TENANT,
        created_by_subject_id: 'user-b',
        ...window,
      }),
    ).toEqual([]);
    expect(
      await fixtures.deletion.listDeletedChatModelUsage({
        tenant_id: TENANT,
        created_by_subject_id: OWNER,
        from: window.to,
        to: new Date(window.to.getTime() + HOUR_MS),
      }),
    ).toEqual([]);
  });
}
