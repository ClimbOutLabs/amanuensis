import { sql, type Kysely } from 'kysely';

/**
 * Goals and everything a goal owns: plan steps, evidence, events, cycles,
 * actions, the live cycle claim, and persisted wake-ups. Child rows cascade
 * from the goal. The one exception is goal_fencing_counter, the tombstone
 * holding the highest fencing token issued per goal id: it has no foreign
 * key and is never deleted, so tokens stay monotonic across a delete and
 * recreate. Mirrors db/postgres/migrations/20261118_000001_goals.ts.
 *
 * SQLite differences: JSON documents are TEXT, timestamps are ISO TEXT,
 * tables are STRICT. The migration owns its own transaction because Kysely's
 * Migrator does not wrap SQLite migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE goal (
        goal_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        pinned_agent_id TEXT,
        pinned_agent_version TEXT,
        pinned_agent_snapshot TEXT,
        title TEXT NOT NULL,
        outcome TEXT NOT NULL,
        success_criteria TEXT NOT NULL,
        target_at TEXT,
        timezone TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'completed', 'ended')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        linked_space_id TEXT,
        execution_policy TEXT NOT NULL,
        notification_policy TEXT NOT NULL,
        next_check_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (goal_id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX goal_owner_idx ON goal (tenant_id, created_by, lifecycle)`.execute(trx);
    await sql`
      CREATE TABLE goal_step (
        step_id TEXT NOT NULL,
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        status TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        evidence_ids TEXT NOT NULL,
        action_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (step_id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX goal_step_goal_idx ON goal_step (goal_id)`.execute(trx);
    await sql`
      CREATE TABLE goal_evidence (
        evidence_id TEXT NOT NULL,
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_revision TEXT,
        content_hash TEXT,
        observed_at TEXT NOT NULL,
        claimed_event_at TEXT,
        freshness TEXT NOT NULL,
        admission TEXT NOT NULL,
        extraction_method TEXT NOT NULL,
        PRIMARY KEY (evidence_id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX goal_evidence_goal_idx ON goal_evidence (goal_id, observed_at)`.execute(trx);
    await sql`
      CREATE TABLE goal_event (
        event_id TEXT NOT NULL,
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (event_id),
        UNIQUE (goal_id, sequence)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE goal_cycle (
        cycle_id TEXT NOT NULL,
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
        trigger_ids TEXT NOT NULL,
        lease TEXT,
        budgets TEXT NOT NULL,
        usage TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        outcome_detail TEXT,
        next_check_at TEXT,
        PRIMARY KEY (cycle_id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX goal_cycle_goal_idx ON goal_cycle (goal_id, started_at)`.execute(trx);
    await sql`
      CREATE TABLE goal_action (
        action_id TEXT NOT NULL,
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        cycle_id TEXT,
        expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
        preconditions TEXT NOT NULL,
        tool_call_ref TEXT,
        approval_ref TEXT,
        execution_state TEXT NOT NULL,
        receipt_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (action_id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX goal_action_goal_idx ON goal_action (goal_id, created_at)`.execute(trx);
    await sql`CREATE INDEX goal_action_state_idx ON goal_action (goal_id, execution_state)`.execute(trx);
    await sql`
      CREATE TABLE goal_claim (
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        worker_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (goal_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE goal_fencing_counter (
        goal_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        PRIMARY KEY (goal_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE goal_wakeup (
        wakeup_id TEXT NOT NULL,
        goal_id TEXT NOT NULL REFERENCES goal (goal_id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        event_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        available_at TEXT NOT NULL,
        claimed_by TEXT,
        claim_expires_at TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (wakeup_id),
        UNIQUE (goal_id, event_key)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX goal_wakeup_due_idx ON goal_wakeup (available_at) WHERE delivered_at IS NULL`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE goal_wakeup`.execute(trx);
    await sql`DROP TABLE goal_fencing_counter`.execute(trx);
    await sql`DROP TABLE goal_claim`.execute(trx);
    await sql`DROP TABLE goal_action`.execute(trx);
    await sql`DROP TABLE goal_cycle`.execute(trx);
    await sql`DROP TABLE goal_event`.execute(trx);
    await sql`DROP TABLE goal_evidence`.execute(trx);
    await sql`DROP TABLE goal_step`.execute(trx);
    await sql`DROP TABLE goal`.execute(trx);
  });
}
