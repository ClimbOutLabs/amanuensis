import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * Goals and everything a goal owns: plan steps, evidence, events, cycles,
 * actions, the live cycle claim, and persisted wake-ups. Child rows cascade
 * from the goal. The one exception is goal_fencing_counter, the tombstone
 * holding the highest fencing token issued per goal id: it has no foreign
 * key and is never deleted, so tokens stay monotonic across a delete and
 * recreate. Mirrors db/sqlite/migrations/20261118_000001_goals.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('goal')
      .addColumn('goal_id', 'text', col => col.notNull())
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('persona_id', 'text', col => col.notNull())
      .addColumn('pinned_agent_id', 'text')
      .addColumn('pinned_agent_version', 'text')
      .addColumn('pinned_agent_snapshot', 'text')
      .addColumn('title', 'text', col => col.notNull())
      .addColumn('outcome', 'text', col => col.notNull())
      .addColumn('success_criteria', 'text', col => col.notNull())
      .addColumn('target_at', 'timestamptz')
      .addColumn('timezone', 'text')
      .addColumn('lifecycle', 'text', col => col.notNull())
      .addColumn('revision', 'integer', col => col.notNull())
      .addColumn('linked_space_id', 'text')
      .addColumn('execution_policy', 'text', col => col.notNull())
      .addColumn('notification_policy', 'text', col => col.notNull())
      .addColumn('next_check_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('goal_pkey', ['goal_id'])
      .addCheckConstraint('goal_lifecycle_check', sql`lifecycle IN ('draft', 'active', 'paused', 'completed', 'ended')`)
      .addCheckConstraint('goal_revision_check', sql`revision >= 1`)
      .execute();
    await trx.schema
      .createIndex('goal_owner_idx')
      .on('goal')
      .columns(['tenant_id', 'created_by', 'lifecycle'])
      .execute();
    await trx.schema
      .createTable('goal_step')
      .addColumn('step_id', 'text', col => col.notNull())
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('description', 'text', col => col.notNull())
      .addColumn('depends_on', 'text', col => col.notNull())
      .addColumn('status', 'text', col => col.notNull())
      .addColumn('acceptance_criteria', 'text', col => col.notNull())
      .addColumn('evidence_ids', 'text', col => col.notNull())
      .addColumn('action_id', 'text')
      .addColumn('revision', 'integer', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('goal_step_pkey', ['step_id'])
      .addCheckConstraint('goal_step_revision_check', sql`revision >= 1`)
      .execute();
    await trx.schema.createIndex('goal_step_goal_idx').on('goal_step').column('goal_id').execute();
    await trx.schema
      .createTable('goal_evidence')
      .addColumn('evidence_id', 'text', col => col.notNull())
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('source_kind', 'text', col => col.notNull())
      .addColumn('source_ref', 'text', col => col.notNull())
      .addColumn('source_revision', 'text')
      .addColumn('content_hash', 'text')
      .addColumn('observed_at', 'timestamptz', col => col.notNull())
      .addColumn('claimed_event_at', 'timestamptz')
      .addColumn('freshness', 'text', col => col.notNull())
      .addColumn('admission', 'text', col => col.notNull())
      .addColumn('extraction_method', 'text', col => col.notNull())
      .addPrimaryKeyConstraint('goal_evidence_pkey', ['evidence_id'])
      .execute();
    await trx.schema
      .createIndex('goal_evidence_goal_idx')
      .on('goal_evidence')
      .columns(['goal_id', 'observed_at'])
      .execute();
    await trx.schema
      .createTable('goal_event')
      .addColumn('event_id', 'text', col => col.notNull())
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('sequence', 'integer', col => col.notNull())
      .addColumn('event_type', 'text', col => col.notNull())
      .addColumn('actor', 'text', col => col.notNull())
      .addColumn('payload', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('goal_event_pkey', ['event_id'])
      .addUniqueConstraint('goal_event_sequence_uq', ['goal_id', 'sequence'])
      .addCheckConstraint('goal_event_sequence_check', sql`sequence >= 1`)
      .execute();
    await trx.schema
      .createTable('goal_cycle')
      .addColumn('cycle_id', 'text', col => col.notNull())
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('input_revision', 'integer', col => col.notNull())
      .addColumn('trigger_ids', 'text', col => col.notNull())
      .addColumn('lease', 'text')
      .addColumn('budgets', 'text', col => col.notNull())
      .addColumn('usage', 'text', col => col.notNull())
      .addColumn('started_at', 'timestamptz', col => col.notNull())
      .addColumn('finished_at', 'timestamptz')
      .addColumn('outcome', 'text')
      .addColumn('outcome_detail', 'text')
      .addColumn('next_check_at', 'timestamptz')
      .addPrimaryKeyConstraint('goal_cycle_pkey', ['cycle_id'])
      .addCheckConstraint('goal_cycle_input_revision_check', sql`input_revision >= 1`)
      .execute();
    await trx.schema.createIndex('goal_cycle_goal_idx').on('goal_cycle').columns(['goal_id', 'started_at']).execute();
    await trx.schema
      .createTable('goal_action')
      .addColumn('action_id', 'text', col => col.notNull())
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('cycle_id', 'text')
      .addColumn('expected_revision', 'integer', col => col.notNull())
      .addColumn('preconditions', 'text', col => col.notNull())
      .addColumn('tool_call_ref', 'text')
      .addColumn('approval_ref', 'text')
      .addColumn('execution_state', 'text', col => col.notNull())
      .addColumn('receipt_ref', 'text')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('goal_action_pkey', ['action_id'])
      .addCheckConstraint('goal_action_expected_revision_check', sql`expected_revision >= 1`)
      .execute();
    await trx.schema.createIndex('goal_action_goal_idx').on('goal_action').columns(['goal_id', 'created_at']).execute();
    await trx.schema
      .createIndex('goal_action_state_idx')
      .on('goal_action')
      .columns(['goal_id', 'execution_state'])
      .execute();
    await trx.schema
      .createTable('goal_claim')
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('fencing_token', 'integer', col => col.notNull())
      .addColumn('worker_id', 'text', col => col.notNull())
      .addColumn('expires_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('goal_claim_pkey', ['goal_id'])
      .addCheckConstraint('goal_claim_fencing_token_check', sql`fencing_token >= 1`)
      .execute();
    await trx.schema
      .createTable('goal_fencing_counter')
      .addColumn('goal_id', 'text', col => col.notNull())
      .addColumn('fencing_token', 'integer', col => col.notNull())
      .addPrimaryKeyConstraint('goal_fencing_counter_pkey', ['goal_id'])
      .addCheckConstraint('goal_fencing_counter_token_check', sql`fencing_token >= 1`)
      .execute();
    await trx.schema
      .createTable('goal_wakeup')
      .addColumn('wakeup_id', 'text', col => col.notNull())
      .addColumn('goal_id', 'text', col => col.notNull().references('goal.goal_id').onDelete('cascade'))
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('event_key', 'text', col => col.notNull())
      .addColumn('kind', 'text', col => col.notNull())
      .addColumn('payload', 'text', col => col.notNull())
      .addColumn('available_at', 'timestamptz', col => col.notNull())
      .addColumn('claimed_by', 'text')
      .addColumn('claim_expires_at', 'timestamptz')
      .addColumn('delivered_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('goal_wakeup_pkey', ['wakeup_id'])
      .addUniqueConstraint('goal_wakeup_event_key_uq', ['goal_id', 'event_key'])
      .execute();
    await sql`CREATE INDEX goal_wakeup_due_idx ON goal_wakeup (available_at) WHERE delivered_at IS NULL`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('goal_wakeup').execute();
    await trx.schema.dropTable('goal_fencing_counter').execute();
    await trx.schema.dropTable('goal_claim').execute();
    await trx.schema.dropTable('goal_action').execute();
    await trx.schema.dropTable('goal_cycle').execute();
    await trx.schema.dropTable('goal_event').execute();
    await trx.schema.dropTable('goal_evidence').execute();
    await trx.schema.dropTable('goal_step').execute();
    await trx.schema.dropTable('goal').execute();
  });
}
