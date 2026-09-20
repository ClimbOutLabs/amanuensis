import { sql } from 'kysely';

import { mintImplementationPlanGrant } from '../../../../../trueforge-core/src/core/mcp/implementationPlanGrant';
import { runStoreContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/storeContractSuite';
import { makeAgentSpec, makeCreateTurnInput } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import type { SessionCustom, TurnCustom } from '../../../../src/db/sessionCustom';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { appendEventsToDoneTurn } from '../../../../src/db/sqlite/session-store/queries/events';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { runCompletedTurnEventStoreContractSuite } from '../../completedTurnEventStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSessionStore (ISessionStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runStoreContractSuite<SessionCustom, TurnCustom, SqliteSessionStore>(
    () => new SqliteSessionStore(env.db),
    async (_store, input) => {
      await env.db
        .updateTable('session')
        .set({ repository_id: input.repository_id, workspace_cwd: input.workspace_cwd })
        .where('tenant_id', '=', input.tenant_id)
        .where('session_id', '=', input.session_id)
        .execute();
    },
  );

  runCompletedTurnEventStoreContractSuite({
    createStore: () => new SqliteSessionStore(env.db),
    appendWidened: input => appendEventsToDoneTurn(env.db, input),
  });

  it('stores and reloads approval grants as SQLite JSONB', async () => {
    const store = new SqliteSessionStore(env.db);
    await store.createSession({
      tenant_id: 'tenant',
      session_id: 'session',
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    const grant = '["v1","mcp","github","create_issue"]';
    await store.createTurn(
      makeCreateTurnInput({
        sessionId: 'session',
        turnId: 'turn',
        approval_grants: [grant],
      }),
    );

    const row = await env.db
      .selectFrom('session')
      .select(sql<string>`typeof(approval_grants)`.as('storage_type'))
      .where('session_id', '=', 'session')
      .executeTakeFirstOrThrow();

    expect(row.storage_type).toBe('blob');
    await expect(store.getSession({ tenant_id: 'tenant', session_id: 'session' })).resolves.toMatchObject({
      approval_grants: [grant],
    });
  });

  it('reloads owner-scoped implementation-plan grants from durable SQLite JSONB', async () => {
    const store = new SqliteSessionStore(env.db);
    await store.createSession({
      tenant_id: 'tenant',
      session_id: 'session',
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    await env.db
      .updateTable('session')
      .set({ repository_id: 'repo-sqlite', workspace_cwd: '/repo' })
      .where('session_id', '=', 'session')
      .execute();
    const grant = mintImplementationPlanGrant({
      tenant_id: 'tenant',
      created_by: 'user',
      session_id: 'session',
      workspace_cwd: '/repo',
      checkout_id: `sha256:${'1'.repeat(64)}`,
      plan: {
        repository_id: 'repo-sqlite',
        repository_revision: 2,
        branch: 'codex/sqlite-plan',
        head_sha: '0123456789abcdef',
        file_globs: ['src/**/*.ts'],
        approach: 'Persist the plan grant.',
        verify_command_ids: ['verify'],
      },
    });
    await store.createTurn(makeCreateTurnInput({ sessionId: 'session', turnId: 'turn' }));
    await store.persistImplementationPlanGrant({ grant, turn_id: 'turn' });

    const row = await env.db
      .selectFrom('implementation_plan_grant')
      .select(sql<string>`typeof(grant)`.as('storage_type'))
      .where('session_id', '=', 'session')
      .executeTakeFirstOrThrow();
    const restartedStore = new SqliteSessionStore(env.db);

    expect(row.storage_type).toBe('blob');
    await expect(
      restartedStore.listImplementationPlanGrants({
        tenant_id: 'tenant',
        created_by: 'user',
        session_id: 'session',
      }),
    ).resolves.toEqual([grant]);
  });

  it('invalidates a grant after the session rebinds to another checkout of the same repository', async () => {
    const store = new SqliteSessionStore(env.db);
    await store.createSession({
      tenant_id: 'tenant',
      session_id: 'rebound-session',
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    await env.db
      .updateTable('session')
      .set({ repository_id: 'repo-sqlite', workspace_cwd: '/repo-a' })
      .where('session_id', '=', 'rebound-session')
      .execute();
    await store.createTurn(makeCreateTurnInput({ sessionId: 'rebound-session', turnId: 'running-turn' }));
    const grant = mintImplementationPlanGrant({
      tenant_id: 'tenant',
      created_by: 'user',
      session_id: 'rebound-session',
      workspace_cwd: '/repo-a',
      checkout_id: `sha256:${'1'.repeat(64)}`,
      plan: {
        repository_id: 'repo-sqlite',
        repository_revision: 2,
        branch: 'codex/sqlite-plan',
        head_sha: '0123456789abcdef',
        file_globs: ['src/**/*.ts'],
        approach: 'Bind this grant to checkout A.',
        verify_command_ids: ['verify'],
      },
    });
    await store.persistImplementationPlanGrant({ grant, turn_id: 'running-turn' });

    await env.db
      .updateTable('session')
      .set({ workspace_cwd: '/repo-b' })
      .where('session_id', '=', 'rebound-session')
      .execute();
    const reboundDb = createSqliteDb(env.databaseFile);
    const reboundHost = new SqliteSessionStore(reboundDb);
    try {
      const owner = { tenant_id: 'tenant', created_by: 'user', session_id: 'rebound-session' };
      await expect(reboundHost.listImplementationPlanGrants(owner)).resolves.toEqual([]);
      await expect(
        reboundHost.beginImplementationPlanDispatch({
          ...owner,
          turn_id: 'running-turn',
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'rebound-dispatch',
        }),
      ).resolves.toEqual({ status: 'blocked' });
    } finally {
      await reboundDb.destroy();
    }
  });

  it('serializes both revoke/dispatch orderings across separate SQLite store instances', async () => {
    const replicaDb = createSqliteDb(env.databaseFile);
    try {
      const dispatchHostStore = new SqliteSessionStore(env.db);
      const revokeHostStore = new SqliteSessionStore(replicaDb);
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
      await env.db
        .updateTable('session')
        .set({ repository_id: 'repo-sqlite', workspace_cwd: '/repo' })
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
          repository_id: 'repo-sqlite',
          repository_revision: 2,
          branch: 'codex/sqlite-plan',
          head_sha: '0123456789abcdef',
          file_globs: ['src/**/*.ts'],
          approach: 'Fence dispatch against cross-replica revocation.',
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
      await expect(
        revokeHostStore.beginImplementationPlanDispatch({
          ...owner,
          turn_id: 'running-turn',
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'revoked-dispatch',
        }),
      ).resolves.toEqual({ status: 'blocked' });
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
    } finally {
      await replicaDb.destroy();
    }
  });

  it('preserves the durable checklist across a store restart', async () => {
    const store = new SqliteSessionStore(env.db);
    await store.createSession({
      tenant_id: 'restart-tenant',
      session_id: 'restart-session',
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    await store.replaceTaskChecklist({
      tenant_id: 'restart-tenant',
      session_id: 'restart-session',
      expected_revision: 0,
      items: [{ id: 'next', text: 'Continue after restart', done: false }],
    });

    await env.db.destroy();
    env.db = createSqliteDb(env.filename);
    const restarted = new SqliteSessionStore(env.db);
    await expect(
      restarted.getTaskChecklist({ tenant_id: 'restart-tenant', session_id: 'restart-session' }),
    ).resolves.toEqual({
      revision: 1,
      items: [{ id: 'next', text: 'Continue after restart', done: false }],
    });
    await env.db.destroy();
  });
});
