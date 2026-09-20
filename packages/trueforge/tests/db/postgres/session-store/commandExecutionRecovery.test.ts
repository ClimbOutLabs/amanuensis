import { MAIN_THREAD_ID } from '@truefoundry/trueforge-core/agent-session/models/TurnRecord';
import { EventType } from '@truefoundry/trueforge-core/agent-session/schemas/events';
import { createToolResponseV2, newEventId } from '@truefoundry/trueforge-core/core/events/schema';
import { createClient, type RedisClientType } from 'redis';
import { heartbeatKey } from '../../../../../trueforge-core/src/request-reply';

import { makeAgentSpec, makeCreateTurnInput } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { recoverAbandonedCommandExecutions } from '../../../../src/runtime/commandExecutionRecovery';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const redisUrl = process.env['COMMAND_EXECUTION_TEST_REDIS_URL'];
const describeRealStores =
  process.env['PG_STORE_TESTS_ENABLED'] === '1' && redisUrl !== undefined && redisUrl !== '' ? describe : describe.skip;

describeRealStores('command execution recovery across Postgres and Redis replicas', () => {
  let env: PostgresTestDatabase;
  let redisA: RedisClientType;
  let redisB: RedisClientType;
  const sessionId = 'recovery-session';
  const turnId = 'recovery-turn';

  beforeAll(async () => {
    const created = await createPostgresTestDatabase();
    if (created === undefined || redisUrl === undefined) throw new Error('real store test environment unavailable');
    env = created;
    redisA = createClient({ url: redisUrl });
    redisB = createClient({ url: redisUrl });
    await Promise.all([redisA.connect(), redisB.connect()]);
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([redisA?.quit(), redisB?.quit()]);
    await env?.teardown();
  });

  beforeEach(async () => {
    await redisA.flushDb();
    const store = new PostgresSessionStore(env.db);
    await store.createSession({
      tenant_id: 'tenant-a',
      session_id: sessionId,
      created_by_subject: { subject_id: 'user-a', subject_type: 'user', subject_display_name: 'user-a' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
  });

  async function start(
    store: PostgresSessionStore,
    input: { ownerId: string; leaseId: string; toolCallId: string; leaseExpiresAt: Date },
  ): Promise<void> {
    await store.appendCommandExecutionStarted({
      session_id: sessionId,
      turn_id: turnId,
      ownership: {
        owner_id: input.ownerId,
        lease_id: input.leaseId,
        lease_expires_at: input.leaseExpiresAt,
      },
      event: {
        type: EventType.TOOL_EXECUTION_STARTED,
        id: newEventId(),
        thread_id: MAIN_THREAD_ID,
        tool_call_id: input.toolCallId,
        tool_name: 'sandbox__run_registered_command',
        created_at: new Date().toISOString(),
        command_execution: {
          repository_id: 'repo-a',
          repository_revision: 1,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace/repo',
          timeout_ms: 60_000,
        },
      },
    });
  }

  async function finalize(store: PostgresSessionStore, input: { leaseId: string; toolCallId: string }): Promise<void> {
    await store.appendCommandExecutionResult({
      session_id: sessionId,
      turn_id: turnId,
      lease_id: input.leaseId,
      event: createToolResponseV2({
        id: newEventId(),
        thread_id: MAIN_THREAD_ID,
        tool_call_id: input.toolCallId,
        created_at: new Date().toISOString(),
        raw_content: 'verified',
        model_content: null,
        screen: null,
        disposition: 'executed_ok',
        remediation: undefined,
        admission_provenance: { source: 'automatic' },
        memoized: false,
        repeat_count: 0,
      }).event,
    });
  }

  it('uses Redis liveness plus the SQL lease fence without mutating on failed checks', async () => {
    const replicaA = new PostgresSessionStore(env.db);
    const replicaB = new PostgresSessionStore(env.db);
    const now = new Date();

    await start(replicaA, {
      ownerId: 'replica-a',
      leaseId: 'lease-future',
      toolCallId: 'future',
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(
      recoverAbandonedCommandExecutions({
        store: replicaB,
        isExecutorAlive: async ownerId => (await redisB.exists(heartbeatKey(ownerId))) > 0,
        completedAt: now,
      }),
    ).resolves.toEqual({ recovered: 0, staleOwnerIds: ['replica-a'] });
    await finalize(replicaA, { leaseId: 'lease-future', toolCallId: 'future' });
    await expect(
      replicaB.getCommandExecution({
        session_id: sessionId,
        turn_id: turnId,
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'future',
      }),
    ).resolves.toMatchObject({ status: 'terminal', disposition: 'executed_ok' });

    await start(replicaA, {
      ownerId: 'replica-a',
      leaseId: 'lease-live-expired',
      toolCallId: 'live-expired',
      leaseExpiresAt: new Date(now.getTime() - 1_000),
    });
    await redisA.set(heartbeatKey('replica-a'), 'alive', { EX: 30 });
    await expect(
      recoverAbandonedCommandExecutions({
        store: replicaB,
        isExecutorAlive: async ownerId => (await redisB.exists(heartbeatKey(ownerId))) > 0,
        completedAt: now,
      }),
    ).resolves.toEqual({ recovered: 0, staleOwnerIds: [] });
    await finalize(replicaA, { leaseId: 'lease-live-expired', toolCallId: 'live-expired' });

    await start(replicaA, {
      ownerId: 'replica-failed-check',
      leaseId: 'lease-failed-check',
      toolCallId: 'failed-check',
      leaseExpiresAt: new Date(now.getTime() - 1_000),
    });
    await expect(
      recoverAbandonedCommandExecutions({
        store: replicaB,
        isExecutorAlive: async ownerId => {
          await redisB.exists(heartbeatKey(ownerId));
          throw new Error('Redis liveness unavailable');
        },
        completedAt: now,
      }),
    ).rejects.toThrow('Redis liveness unavailable');
    await expect(
      replicaA.getCommandExecution({
        session_id: sessionId,
        turn_id: turnId,
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'failed-check',
      }),
    ).resolves.toMatchObject({ status: 'running', disposition: null });

    await expect(
      recoverAbandonedCommandExecutions({
        store: replicaB,
        isExecutorAlive: async ownerId => (await redisB.exists(heartbeatKey(ownerId))) > 0,
        completedAt: now,
      }),
    ).resolves.toEqual({ recovered: 1, staleOwnerIds: ['replica-failed-check'] });
    const events = await replicaA.listTurnEvents({
      session_id: sessionId,
      turn_id: turnId,
      limit: 20,
      page_token: undefined,
      order: 'asc',
    });
    expect(
      events.data.filter(event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === 'failed-check'),
    ).toEqual([expect.objectContaining({ disposition: 'outcome_unknown' })]);
  });
});
