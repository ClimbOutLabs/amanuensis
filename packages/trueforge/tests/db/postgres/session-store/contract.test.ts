import { sql } from 'kysely';

import { mintImplementationPlanGrant } from '../../../../../trueforge-core/src/core/mcp/implementationPlanGrant';
import { runStoreContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/storeContractSuite';
import { makeAgentSpec, makeCreateTurnInput } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
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
          session
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
});
