import type {
  BeginImplementationPlanDispatchInput,
  BeginImplementationPlanDispatchResult,
  CompleteImplementationPlanDispatchInput,
  ImplementationPlanTurnOwner,
  ListImplementationPlanGrantsInput,
  PersistImplementationPlanGrantInput,
  RevokeImplementationPlanGrantInput,
  RevokeImplementationPlanGrantResult,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  ImplementationPlanGrantLifecycleError,
  SessionStoreInvariantError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import {
  validateImplementationPlanGrant,
  type ImplementationPlanGrant,
} from '@truefoundry/trueforge-core/core/mcp/implementationPlanGrant';
import { sql, type Kysely } from 'kysely';
import { json } from '../../sqlExpressions';
import type { Database } from '../../types';

interface ImplementationPlanSessionBinding {
  last_turn_id: string | null;
  repository_id: string | null;
  workspace_cwd: string | null;
}

function grantMatchesSessionBinding(
  grant: ImplementationPlanGrant,
  lifecycle: ImplementationPlanSessionBinding,
): boolean {
  return (
    lifecycle.repository_id !== null &&
    lifecycle.workspace_cwd !== null &&
    lifecycle.repository_id === grant.plan.repository_id &&
    lifecycle.workspace_cwd === grant.workspace_cwd
  );
}

async function implementationPlanSessionBinding(
  db: Kysely<Database>,
  input: ListImplementationPlanGrantsInput,
  lock: boolean,
): Promise<ImplementationPlanSessionBinding | undefined> {
  let ownerQuery = db
    .selectFrom('session')
    .select(['last_turn_id', 'repository_id', 'workspace_cwd'])
    .where('tenant_id', '=', input.tenant_id)
    .where(sql`created_by_subject->>'subject_id'`, '=', input.created_by)
    .where('session_id', '=', input.session_id);
  if (lock) {
    ownerQuery = ownerQuery.forUpdate();
  }
  const owner = await ownerQuery.executeTakeFirst();
  return owner;
}

async function implementationPlanRunningTurn(
  db: Kysely<Database>,
  input: ImplementationPlanTurnOwner,
  lock: boolean,
): Promise<ImplementationPlanSessionBinding | undefined> {
  const owner = await implementationPlanSessionBinding(db, input, lock);
  if (owner === undefined) {
    return undefined;
  }
  let runningQuery = db
    .selectFrom('turn')
    .select('turn_id')
    .where('session_id', '=', input.session_id)
    .where('turn_id', '=', input.turn_id)
    .where(sql<boolean>`state->>'status' = 'running'`);
  if (lock) {
    runningQuery = runningQuery.forUpdate();
  }
  const running = await runningQuery.executeTakeFirst();
  if (owner.last_turn_id !== input.turn_id || running === undefined) {
    throw new ImplementationPlanGrantLifecycleError(input.turn_id);
  }
  return owner;
}

export async function listImplementationPlanGrants(
  db: Kysely<Database>,
  input: ListImplementationPlanGrantsInput,
): Promise<ImplementationPlanGrant[]> {
  const lifecycle = await implementationPlanSessionBinding(db, input, false);
  if (lifecycle === undefined) {
    return [];
  }
  const rows = await db
    .selectFrom('implementation_plan_grant as g')
    .innerJoin('session as s', 's.session_id', 'g.session_id')
    .select(['g.grant_id', 'g.workspace_cwd', 'g.checkout_id', 'g.grant'])
    .where('g.tenant_id', '=', input.tenant_id)
    .where('g.created_by', '=', input.created_by)
    .where('g.session_id', '=', input.session_id)
    .where('s.tenant_id', '=', input.tenant_id)
    .where(sql`s.created_by_subject->>'subject_id'`, '=', input.created_by)
    .where('g.revoked_at', 'is', null)
    .orderBy('g.grant_id', 'asc')
    .execute();

  const grants: ImplementationPlanGrant[] = [];
  for (const row of rows) {
    const grant = validateImplementationPlanGrant(row.grant);
    if (
      grant?.tenant_id === input.tenant_id &&
      grant.created_by === input.created_by &&
      grant.session_id === input.session_id &&
      grant.grant_id === row.grant_id &&
      grant.workspace_cwd === row.workspace_cwd &&
      grant.checkout_id === row.checkout_id &&
      grantMatchesSessionBinding(grant, lifecycle)
    ) {
      grants.push(grant);
    }
  }
  return grants;
}

export async function persistImplementationPlanGrant(
  db: Kysely<Database>,
  input: PersistImplementationPlanGrantInput,
): Promise<void> {
  const grant = validateImplementationPlanGrant(input.grant);
  if (grant === undefined) {
    throw new SessionStoreInvariantError('Implementation-plan grant owner or integrity does not match its session');
  }
  await db.transaction().execute(async transaction => {
    const lifecycle = await implementationPlanRunningTurn(
      transaction,
      {
        tenant_id: grant.tenant_id,
        created_by: grant.created_by,
        session_id: grant.session_id,
        turn_id: input.turn_id,
      },
      true,
    );
    if (lifecycle === undefined || !grantMatchesSessionBinding(grant, lifecycle)) {
      throw new SessionStoreInvariantError('Implementation-plan grant owner or integrity does not match its session');
    }
    await transaction
      .insertInto('implementation_plan_grant')
      .values({
        tenant_id: grant.tenant_id,
        created_by: grant.created_by,
        session_id: grant.session_id,
        grant_id: grant.grant_id,
        workspace_cwd: grant.workspace_cwd,
        checkout_id: grant.checkout_id,
        grant: json(grant),
        created_at: new Date(),
        revoked_at: null,
      })
      .onConflict(conflict =>
        conflict.columns(['session_id', 'grant_id']).doUpdateSet({
          tenant_id: grant.tenant_id,
          created_by: grant.created_by,
          workspace_cwd: grant.workspace_cwd,
          checkout_id: grant.checkout_id,
          grant: json(grant),
          created_at: new Date(),
          revoked_at: null,
        }),
      )
      .execute();
  });
}

export async function revokeImplementationPlanGrant(
  db: Kysely<Database>,
  input: RevokeImplementationPlanGrantInput,
): Promise<RevokeImplementationPlanGrantResult> {
  return db.transaction().execute(async transaction => {
    const lifecycle = await implementationPlanSessionBinding(transaction, input, true);
    if (lifecycle === undefined) {
      return { status: 'absent' };
    }
    const row = await transaction
      .selectFrom('implementation_plan_grant')
      .select(['tenant_id', 'created_by', 'workspace_cwd', 'checkout_id', 'grant'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('session_id', '=', input.session_id)
      .where('grant_id', '=', input.grant_id)
      .forUpdate()
      .executeTakeFirst();
    const grant = validateImplementationPlanGrant(row?.grant);
    if (
      row === undefined ||
      grant === undefined ||
      row.tenant_id !== input.tenant_id ||
      row.created_by !== input.created_by ||
      row.workspace_cwd !== grant.workspace_cwd ||
      row.checkout_id !== grant.checkout_id ||
      grant.tenant_id !== input.tenant_id ||
      grant.created_by !== input.created_by ||
      grant.session_id !== input.session_id ||
      grant.grant_id !== input.grant_id ||
      !grantMatchesSessionBinding(grant, lifecycle)
    ) {
      return { status: 'absent' };
    }
    await transaction
      .updateTable('implementation_plan_grant')
      .set({ revoked_at: new Date() })
      .where('session_id', '=', input.session_id)
      .where('grant_id', '=', input.grant_id)
      .execute();
    const pending = await transaction
      .selectFrom('implementation_plan_dispatch')
      .select('dispatch_id')
      .where('session_id', '=', input.session_id)
      .where('grant_id', '=', input.grant_id)
      .where('state', '=', 'dispatching')
      .executeTakeFirst();
    return { status: pending === undefined ? 'revoked' : 'pending' };
  });
}

export async function beginImplementationPlanDispatch(
  db: Kysely<Database>,
  input: BeginImplementationPlanDispatchInput,
): Promise<BeginImplementationPlanDispatchResult> {
  return db.transaction().execute(async transaction => {
    const lifecycle = await implementationPlanRunningTurn(transaction, input, true);
    if (lifecycle === undefined) {
      return { status: 'blocked' };
    }
    const row = await transaction
      .selectFrom('implementation_plan_grant')
      .select(['tenant_id', 'created_by', 'workspace_cwd', 'checkout_id', 'revoked_at', 'grant'])
      .where('session_id', '=', input.session_id)
      .where('grant_id', '=', input.grant_id)
      .forUpdate()
      .executeTakeFirst();
    const grant = validateImplementationPlanGrant(row?.grant);
    if (row === undefined || grant === undefined) {
      return { status: 'blocked' };
    }
    if (
      row.tenant_id !== input.tenant_id ||
      row.created_by !== input.created_by ||
      row.revoked_at !== null ||
      row.workspace_cwd !== grant.workspace_cwd ||
      row.checkout_id !== input.checkout_id ||
      grant.tenant_id !== input.tenant_id ||
      grant.created_by !== input.created_by ||
      grant.session_id !== input.session_id ||
      grant.grant_id !== input.grant_id ||
      !grantMatchesSessionBinding(grant, lifecycle) ||
      grant.checkout_id !== input.checkout_id
    ) {
      return { status: 'blocked' };
    }
    const inserted = await transaction
      .insertInto('implementation_plan_dispatch')
      .values({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        session_id: input.session_id,
        turn_id: input.turn_id,
        grant_id: input.grant_id,
        workspace_cwd: grant.workspace_cwd,
        checkout_id: input.checkout_id,
        dispatch_id: input.dispatch_id,
        state: 'dispatching',
        created_at: new Date(),
        completed_at: null,
      })
      .onConflict(conflict => conflict.columns(['session_id', 'turn_id', 'dispatch_id']).doNothing())
      .returning('dispatch_id')
      .executeTakeFirst();
    return { status: inserted === undefined ? 'blocked' : 'admitted' };
  });
}

export async function completeImplementationPlanDispatch(
  db: Kysely<Database>,
  input: CompleteImplementationPlanDispatchInput,
): Promise<void> {
  const updated = await db
    .updateTable('implementation_plan_dispatch')
    .set({ state: 'completed', completed_at: new Date() })
    .where('tenant_id', '=', input.tenant_id)
    .where('created_by', '=', input.created_by)
    .where('session_id', '=', input.session_id)
    .where('turn_id', '=', input.turn_id)
    .where('grant_id', '=', input.grant_id)
    .where('dispatch_id', '=', input.dispatch_id)
    .where('state', '=', 'dispatching')
    .returning('dispatch_id')
    .executeTakeFirst();
  if (updated !== undefined) {
    return;
  }
  const completed = await db
    .selectFrom('implementation_plan_dispatch')
    .select('dispatch_id')
    .where('tenant_id', '=', input.tenant_id)
    .where('created_by', '=', input.created_by)
    .where('session_id', '=', input.session_id)
    .where('turn_id', '=', input.turn_id)
    .where('grant_id', '=', input.grant_id)
    .where('dispatch_id', '=', input.dispatch_id)
    .where('state', '=', 'completed')
    .executeTakeFirst();
  if (completed === undefined) {
    throw new SessionStoreInvariantError('Implementation-plan dispatch reservation is missing');
  }
}
