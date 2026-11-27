import { sql } from 'kysely';

import { MAIN_THREAD_ID } from '../../../../../trueforge-core/src/agent-session/models/TurnRecord';
import { EventType, type PersistedTurnEvent } from '../../../../../trueforge-core/src/agent-session/schemas/events';
import { TurnAnswerConflictError } from '../../../../../trueforge-core/src/agent-session/store/SessionStoreErrors';
import { mintImplementationPlanGrant } from '../../../../../trueforge-core/src/core/mcp/implementationPlanGrant';
import { runStoreContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/storeContractSuite';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeModelMessageEvent,
} from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { appendEventsToDoneTurn } from '../../../../src/db/postgres/session-store/queries/events';
import type { SessionCustom, TurnCustom } from '../../../../src/db/sessionCustom';
import { runCompletedTurnEventStoreContractSuite } from '../../completedTurnEventStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresSessionStore (ISessionStore contract)', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  // One database per file; truncate between tests because CREATE DATABASE is slow.
  beforeEach(async () => {
    if (env !== undefined) {
      await sql`
        TRUNCATE TABLE
          thread_capability_state,
          session_event,
          thread_context_log,
          turn_thread,
          turn,
          session,
          session_folder
        RESTART IDENTITY CASCADE
      `.execute(env.db);
    }
  });

  function requireEnv(): PostgresTestDatabase {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return env;
  }

  runStoreContractSuite<SessionCustom, TurnCustom, PostgresSessionStore>(
    () => new PostgresSessionStore(requireEnv().db),
    async (_store, input) => {
      await requireEnv()
        .db.updateTable('session')
        .set({ repository_id: input.repository_id, workspace_cwd: input.workspace_cwd })
        .where('tenant_id', '=', input.tenant_id)
        .where('session_id', '=', input.session_id)
        .execute();
    },
  );

  runCompletedTurnEventStoreContractSuite({
    createStore: () => new PostgresSessionStore(requireEnv().db),
    appendWidened: input => appendEventsToDoneTurn(requireEnv().db, input),
  });

  it('serializes both revoke/dispatch orderings across separate Postgres store instances', async () => {
    const { db } = requireEnv();
    const dispatchHostStore = new PostgresSessionStore(db);
    const revokeHostStore = new PostgresSessionStore(db);
    await dispatchHostStore.createSession({
      tenant_id: 'tenant',
      session_id: 'replicated-session',
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      is_incognito: false,
      private_expires_at: null,
    });
    await db
      .updateTable('session')
      .set({ repository_id: 'repo-postgres', workspace_cwd: '/repo' })
      .where('session_id', '=', 'replicated-session')
      .execute();
    await dispatchHostStore.createTurn(
      makeCreateTurnInput({ sessionId: 'replicated-session', turnId: 'running-turn' }),
    );
    const grant = mintImplementationPlanGrant({
      tenant_id: 'tenant',
      created_by: 'user',
      session_id: 'replicated-session',
      workspace_cwd: '/repo',
      checkout_id: `sha256:${'1'.repeat(64)}`,
      plan: {
        repository_id: 'repo-postgres',
        repository_revision: 2,
        branch: 'codex/postgres-plan',
        head_sha: '0123456789abcdef',
        file_globs: ['src/**/*.ts'],
        approach: 'Fence concurrent cross-replica dispatch and revocation.',
        verify_command_ids: ['verify'],
      },
    });
    const owner = { tenant_id: 'tenant', created_by: 'user', session_id: 'replicated-session' };
    await dispatchHostStore.persistImplementationPlanGrant({ grant, turn_id: 'running-turn' });

    await expect(
      dispatchHostStore.beginImplementationPlanDispatch({
        ...owner,
        turn_id: 'running-turn',
        grant_id: grant.grant_id,
        checkout_id: grant.checkout_id,
        dispatch_id: 'replica-dispatch',
      }),
    ).resolves.toEqual({ status: 'admitted' });
    await expect(
      revokeHostStore.revokeImplementationPlanGrant({
        ...owner,
        grant_id: grant.grant_id,
      }),
    ).resolves.toEqual({ status: 'pending' });
    await dispatchHostStore.completeImplementationPlanDispatch({
      ...owner,
      turn_id: 'running-turn',
      grant_id: grant.grant_id,
      dispatch_id: 'replica-dispatch',
    });
    await expect(
      revokeHostStore.revokeImplementationPlanGrant({
        ...owner,
        grant_id: grant.grant_id,
      }),
    ).resolves.toEqual({ status: 'revoked' });

    const revokeFirstGrant = mintImplementationPlanGrant({
      ...owner,
      workspace_cwd: grant.workspace_cwd,
      checkout_id: grant.checkout_id,
      plan: {
        ...grant.plan,
        approach: 'Prove that a cross-replica revoke wins before dispatch admission.',
      },
    });
    await dispatchHostStore.persistImplementationPlanGrant({
      grant: revokeFirstGrant,
      turn_id: 'running-turn',
    });
    await expect(
      revokeHostStore.revokeImplementationPlanGrant({
        ...owner,
        grant_id: revokeFirstGrant.grant_id,
      }),
    ).resolves.toEqual({ status: 'revoked' });
    await expect(
      dispatchHostStore.beginImplementationPlanDispatch({
        ...owner,
        turn_id: 'running-turn',
        grant_id: revokeFirstGrant.grant_id,
        checkout_id: revokeFirstGrant.checkout_id,
        dispatch_id: 'revoke-first-dispatch',
      }),
    ).resolves.toEqual({ status: 'blocked' });
  });

  async function seedCommitRace(first: PostgresSessionStore) {
    await first.createSession({
      tenant_id: 'tenant',
      session_id: 'race-session',
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      is_incognito: false,
      private_expires_at: null,
    });
    await first.createTurn(makeCreateTurnInput({ sessionId: 'race-session', turnId: 'race-turn' }));
  }

  function raceAnswer(content: string) {
    return { ...makeModelMessageEvent(), content };
  }

  function commitRaceAnswer(store: PostgresSessionStore, answer: ReturnType<typeof raceAnswer>) {
    return store.commitThreadAnswer({
      session_id: 'race-session',
      turn_id: 'race-turn',
      thread_id: MAIN_THREAD_ID,
      context: [{ role: 'assistant', content: answer.content }],
      current_context_usage: null,
      completion: null,
      tool_call_memo: undefined,
      task_state: undefined,
      events: [answer],
    });
  }

  async function raceStoredFinals(store: PostgresSessionStore): Promise<PersistedTurnEvent[]> {
    const { data } = await store.listTurnEvents({
      session_id: 'race-session',
      turn_id: 'race-turn',
      limit: 50,
      page_token: undefined,
      order: undefined,
    });
    return data.filter(event => event.type === EventType.MODEL_MESSAGE);
  }

  it('two store instances racing different finals on one turn: exactly one commits', async () => {
    const { db } = requireEnv();
    const first = new PostgresSessionStore(db);
    const second = new PostgresSessionStore(db);
    await seedCommitRace(first);
    const answerA = raceAnswer('answer from the first committer');
    const answerB = raceAnswer('answer from the second committer');

    // Both commits are issued before either settles, so the two instances
    // are inside commitThreadAnswer at the same time on separate pooled
    // connections. The turn row lock serializes them, and the second reads
    // the committed final.
    const outcomes = await Promise.allSettled([commitRaceAnswer(first, answerA), commitRaceAnswer(second, answerB)]);

    const firstWon = outcomes[0]?.status === 'fulfilled';
    const secondWon = outcomes[1]?.status === 'fulfilled';
    expect(firstWon !== secondWon).toBe(true);
    const winner = firstWon ? answerA : answerB;
    const loser = firstWon ? outcomes[1] : outcomes[0];
    if (loser?.status !== 'rejected') {
      throw new Error('expected the losing commit to reject');
    }
    expect(loser.reason).toBeInstanceOf(TurnAnswerConflictError);
    expect(await raceStoredFinals(first)).toEqual([winner]);
    const turn = await first.getTurn({ session_id: 'race-session', turn_id: 'race-turn' });
    expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([{ role: 'assistant', content: winner.content }]);
  });

  it('two store instances racing the identical commit on one turn: both succeed, one stored answer', async () => {
    const { db } = requireEnv();
    const first = new PostgresSessionStore(db);
    const second = new PostgresSessionStore(db);
    await seedCommitRace(first);
    const answer = raceAnswer('the one accepted answer');

    // Same overlap as above: both instances are inside commitThreadAnswer
    // at the same time, carrying the same answer event. The second reads
    // the committed final and replays it as success instead of dying on
    // the session_event primary key.
    const outcomes = await Promise.allSettled([commitRaceAnswer(first, answer), commitRaceAnswer(second, answer)]);

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await raceStoredFinals(first)).toEqual([answer]);
    const turn = await first.getTurn({ session_id: 'race-session', turn_id: 'race-turn' });
    expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([
      { role: 'assistant', content: 'the one accepted answer' },
    ]);
  });
});
