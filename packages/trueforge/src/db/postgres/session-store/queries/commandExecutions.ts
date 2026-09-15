import type {
  AppendCommandExecutionResultInput,
  AppendCommandExecutionStartedInput,
  CommandExecutionRecord,
  GetCommandExecutionInput,
  RecoverRunningCommandExecutionsInput,
  RenewCommandExecutionLeaseInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { SessionStoreInvariantError } from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import {
  ToolResultDispositionSchema,
  createToolResponseV2,
  newEventId,
} from '@truefoundry/trueforge-core/core/events/schema';
import type { Kysely, Selectable } from 'kysely';
import { json } from '../../sqlExpressions';
import type { CommandExecutionTable, Database } from '../../types';
import { assertTurnRunning } from './turns';

function toRecord(row: Selectable<CommandExecutionTable>): CommandExecutionRecord {
  if (row.status !== 'running' && row.status !== 'terminal') {
    throw new SessionStoreInvariantError(`invalid command execution status ${row.status}`);
  }
  return {
    session_id: row.session_id,
    turn_id: row.turn_id,
    thread_id: row.thread_id,
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    repository_id: row.repository_id,
    repository_revision: row.repository_revision,
    command_id: row.command_id,
    command: row.command,
    cwd: row.cwd,
    timeout_ms: row.timeout_ms,
    status: row.status,
    disposition: row.disposition === null ? null : ToolResultDispositionSchema.parse(row.disposition),
    owner_id: row.owner_id,
    lease_id: row.lease_id,
    lease_expires_at: row.lease_expires_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

export async function appendCommandExecutionStarted(
  db: Kysely<Database>,
  input: AppendCommandExecutionStartedInput,
): Promise<void> {
  await db.transaction().execute(async trx => {
    await assertTurnRunning(trx, input);
    const execution = input.event.command_execution;
    await trx
      .insertInto('command_execution')
      .values({
        session_id: input.session_id,
        turn_id: input.turn_id,
        thread_id: input.event.thread_id,
        tool_call_id: input.event.tool_call_id,
        tool_name: input.event.tool_name,
        repository_id: execution.repository_id,
        repository_revision: execution.repository_revision,
        command_id: execution.command_id,
        command: execution.command,
        cwd: execution.cwd,
        timeout_ms: execution.timeout_ms,
        status: 'running',
        disposition: null,
        owner_id: input.ownership.owner_id,
        lease_id: input.ownership.lease_id,
        lease_expires_at: input.ownership.lease_expires_at,
        started_at: new Date(input.event.created_at),
        completed_at: null,
      })
      .execute();
    await trx
      .insertInto('session_event')
      .values({
        session_id: input.session_id,
        turn_id: input.turn_id,
        event_id: input.event.id,
        event: json(input.event),
        created_at: new Date(input.event.created_at),
      })
      .execute();
  });
}

export async function appendCommandExecutionResult(
  db: Kysely<Database>,
  input: AppendCommandExecutionResultInput,
): Promise<void> {
  await db.transaction().execute(async trx => {
    await assertTurnRunning(trx, input);
    const updated = await trx
      .updateTable('command_execution')
      .set({
        status: 'terminal',
        disposition: input.event.disposition,
        completed_at: new Date(input.event.created_at),
      })
      .where('session_id', '=', input.session_id)
      .where('turn_id', '=', input.turn_id)
      .where('thread_id', '=', input.event.thread_id)
      .where('tool_call_id', '=', input.event.tool_call_id)
      .where('lease_id', '=', input.lease_id)
      .where('status', '=', 'running')
      .returning('tool_call_id')
      .executeTakeFirst();
    if (updated === undefined) {
      throw new SessionStoreInvariantError(`running command execution ${input.event.tool_call_id} not found`);
    }
    await trx
      .insertInto('session_event')
      .values({
        session_id: input.session_id,
        turn_id: input.turn_id,
        event_id: input.event.id,
        event: json(input.event),
        created_at: new Date(input.event.created_at),
      })
      .execute();
  });
}

export async function getCommandExecution(
  db: Kysely<Database>,
  input: GetCommandExecutionInput,
): Promise<CommandExecutionRecord | undefined> {
  const row = await db
    .selectFrom('command_execution')
    .selectAll()
    .where('session_id', '=', input.session_id)
    .where('turn_id', '=', input.turn_id)
    .where('thread_id', '=', input.thread_id)
    .where('tool_call_id', '=', input.tool_call_id)
    .executeTakeFirst();
  return row === undefined ? undefined : toRecord(row);
}

export async function renewCommandExecutionLease(
  db: Kysely<Database>,
  input: RenewCommandExecutionLeaseInput,
): Promise<boolean> {
  const renewed = await db
    .updateTable('command_execution')
    .set({ lease_expires_at: input.lease_expires_at })
    .where('session_id', '=', input.session_id)
    .where('turn_id', '=', input.turn_id)
    .where('thread_id', '=', input.thread_id)
    .where('tool_call_id', '=', input.tool_call_id)
    .where('lease_id', '=', input.lease_id)
    .where('status', '=', 'running')
    .returning('lease_id')
    .executeTakeFirst();
  return renewed !== undefined;
}

export async function listRunningCommandExecutionOwnerIds(db: Kysely<Database>): Promise<string[]> {
  const rows = await db
    .selectFrom('command_execution')
    .select('owner_id')
    .distinct()
    .where('status', '=', 'running')
    .orderBy('owner_id', 'asc')
    .execute();
  return rows.map(row => row.owner_id);
}

function outcomeUnknownEvent(row: Selectable<CommandExecutionTable>, completedAt: Date) {
  return createToolResponseV2({
    id: newEventId(),
    thread_id: row.thread_id,
    tool_call_id: row.tool_call_id,
    created_at: completedAt.toISOString(),
    raw_content: JSON.stringify({
      error: 'The registered command owner stopped before a terminal provider result was persisted.',
    }),
    model_content: null,
    screen: null,
    disposition: 'outcome_unknown',
    remediation: {
      reason_code: 'execution_interrupted',
      message: 'Inspect the repository state before deciding whether the command is safe to retry.',
      suggested_action: 'inspect_state',
    },
    admission_provenance: { source: 'automatic' },
    memoized: false,
    repeat_count: 0,
  }).event;
}

export async function recoverRunningCommandExecutions(
  db: Kysely<Database>,
  input: RecoverRunningCommandExecutionsInput,
): Promise<number> {
  if (input.owner_ids !== null && input.owner_ids.length === 0) {
    return 0;
  }
  return db.transaction().execute(async trx => {
    let candidates = trx.selectFrom('command_execution').selectAll().where('status', '=', 'running');
    if (input.owner_ids !== null) {
      candidates = candidates.where('owner_id', 'in', input.owner_ids);
    }
    if (input.require_expired_lease) {
      candidates = candidates.where('lease_expires_at', '<=', input.completed_at);
    }
    const rows = await candidates.forUpdate().skipLocked().execute();
    if (rows.length === 0) {
      return 0;
    }
    let fencedUpdate = trx
      .updateTable('command_execution')
      .set({ status: 'terminal', disposition: 'outcome_unknown', completed_at: input.completed_at })
      .where(eb =>
        eb.or(
          rows.map(row =>
            eb.and([eb('lease_id', '=', row.lease_id), eb('lease_expires_at', '=', row.lease_expires_at)]),
          ),
        ),
      )
      .where('status', '=', 'running');
    if (input.require_expired_lease) {
      fencedUpdate = fencedUpdate.where('lease_expires_at', '<=', input.completed_at);
    }
    const won = await fencedUpdate.returningAll().execute();
    if (won.length === 0) {
      return 0;
    }
    const events = won.map(row => ({ row, event: outcomeUnknownEvent(row, input.completed_at) }));
    await trx
      .insertInto('session_event')
      .values(
        events.map(({ row, event }) => ({
          session_id: row.session_id,
          turn_id: row.turn_id,
          event_id: event.id,
          event: json(event),
          created_at: input.completed_at,
        })),
      )
      .execute();
    return won.length;
  });
}
