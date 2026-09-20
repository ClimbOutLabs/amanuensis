import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { posix, win32 } from 'node:path';
import { ulid } from 'ulid';
import {
  MAX_VERIFY_COMMAND_TIMEOUT_MS,
  RepositoryNameConflictError,
  RepositoryRevisionConflictError,
  RepositoryWorkspaceCwdError,
  VerifyCommandTimeoutError,
  type ActivateWorkspaceVerificationReceiptInput,
  type BindSessionInput,
  type ConfirmVerifyCommandProposalInput,
  type ConsumeWorkspaceVerificationReceiptInput,
  type CreateRepositoryInput,
  type DeleteVerifyCommandInput,
  type DeleteVerifyCommandProposalInput,
  type GetRepositoryInput,
  type IRepositoryStore,
  type ObserveWorkspaceVerificationStateInput,
  type ReplaceVerifyCommandProposalsInput,
  type RepositoryOwnerInput,
  type RepositoryRecord,
  type SessionBindingRecord,
  type UnbindSessionInput,
  type VerifyCommandInput,
  type VerifyCommandMutationResult,
  type VerifyCommandProposalInput,
  type VerifyCommandProposalRecord,
  type VerifyCommandProposalSourceKind,
  type VerifyCommandPurpose,
  type VerifyCommandRecord,
  type WorkspaceVerificationLeaseInput,
} from '../../repositoryStore';
import { isUniqueViolation } from '../client';
import { now } from '../sqlExpressions';
import type {
  Database,
  RepositoryTable,
  RepositoryVerifyCommandProposalTable,
  RepositoryVerifyCommandTable,
} from '../types';

function purpose(value: string): VerifyCommandPurpose {
  switch (value) {
    case 'build':
    case 'test':
    case 'verify':
      return value;
    default:
      throw new Error(`invalid verification command purpose: ${value}`);
  }
}

function proposalSourceKind(value: string): VerifyCommandProposalSourceKind {
  if (value === 'agents_md' || value === 'package_json') {
    return value;
  }
  throw new Error(`invalid verification command proposal source: ${value}`);
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_VERIFY_COMMAND_TIMEOUT_MS) {
    throw new VerifyCommandTimeoutError(timeoutMs);
  }
}

function validateWorkspaceCwd(workspaceCwd: string): void {
  if (workspaceCwd.trim().length === 0 || (!posix.isAbsolute(workspaceCwd) && !win32.isAbsolute(workspaceCwd))) {
    throw new RepositoryWorkspaceCwdError();
  }
}

function toRepositoryRecord(row: Selectable<RepositoryTable>): RepositoryRecord {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toCommandRecord(row: Selectable<RepositoryVerifyCommandTable>): VerifyCommandRecord {
  return {
    ...row,
    purpose: purpose(row.purpose),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toProposalRecord(row: Selectable<RepositoryVerifyCommandProposalTable>): VerifyCommandProposalRecord {
  return {
    ...row,
    purpose: purpose(row.purpose),
    source_kind: proposalSourceKind(row.source_kind),
    created_at: row.created_at.toISOString(),
  };
}

function toSessionBindingRecord(row: {
  tenant_id: string;
  session_id: string;
  created_by: string;
  repository_id: string | null;
  workspace_cwd: string | null;
}): SessionBindingRecord {
  return row;
}

function assertRevision(repository: RepositoryRecord, expectedRevision: number | undefined): void {
  if (expectedRevision !== undefined && repository.revision !== expectedRevision) {
    throw new RepositoryRevisionConflictError({
      repository_id: repository.id,
      expected_revision: expectedRevision,
      actual_revision: repository.revision,
    });
  }
}

export class PostgresRepositoryStore implements IRepositoryStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async createRepository(input: CreateRepositoryInput, transaction?: Transaction<Database>): Promise<RepositoryRecord> {
    const db = transaction ?? this.#db;
    const timestamp = now();
    try {
      const row = await db
        .insertInto('repository')
        .values({ id: ulid().toLowerCase(), ...input, created_at: timestamp, updated_at: timestamp })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRepositoryRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryNameConflictError(input, { cause: error });
      }
      throw error;
    }
  }

  async getRepository(
    input: GetRepositoryInput,
    transaction?: Transaction<Database>,
  ): Promise<RepositoryRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('repository')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.repository_id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRepositoryRecord(row);
  }

  async listRepositories(
    input: RepositoryOwnerInput,
    transaction?: Transaction<Database>,
  ): Promise<RepositoryRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('repository')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toRepositoryRecord);
  }

  async bindSession(
    input: BindSessionInput,
    transaction?: Transaction<Database>,
  ): Promise<SessionBindingRecord | undefined> {
    validateWorkspaceCwd(input.workspace_cwd);
    const run = async (trx: Transaction<Database>): Promise<SessionBindingRecord | undefined> => {
      const existing = await trx
        .selectFrom('session')
        .select(['repository_id'])
        .where('tenant_id', '=', input.tenant_id)
        .where(sql`created_by_subject->>'subject_id'`, '=', input.created_by)
        .where('session_id', '=', input.session_id)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        return undefined;
      }
      const repository = await this.getRepositoryForUpdate(trx, input);
      if (repository === undefined) {
        return undefined;
      }
      assertRevision(repository, input.expected_revision);
      let query = trx
        .updateTable('session')
        .set({ repository_id: input.repository_id, workspace_cwd: input.workspace_cwd })
        .where('tenant_id', '=', input.tenant_id)
        .where(sql`created_by_subject->>'subject_id'`, '=', input.created_by)
        .where('session_id', '=', input.session_id);
      if (existing.repository_id === null) {
        query = query.where('repository_id', 'is', null);
      } else {
        query = query.where('repository_id', '=', existing.repository_id);
      }
      const row = await query
        .returning([
          'tenant_id',
          'session_id',
          sql<string>`created_by_subject->>'subject_id'`.as('created_by'),
          'repository_id',
          'workspace_cwd',
        ])
        .executeTakeFirst();
      return row === undefined ? undefined : toSessionBindingRecord(row);
    };
    return transaction ? run(transaction) : this.#db.transaction().execute(run);
  }

  async unbindSession(
    input: UnbindSessionInput,
    transaction?: Transaction<Database>,
  ): Promise<SessionBindingRecord | undefined> {
    const run = async (trx: Transaction<Database>): Promise<SessionBindingRecord | undefined> => {
      const existing = await trx
        .selectFrom('session')
        .select([
          'tenant_id',
          'session_id',
          sql<string>`created_by_subject->>'subject_id'`.as('created_by'),
          'repository_id',
          'workspace_cwd',
        ])
        .where('tenant_id', '=', input.tenant_id)
        .where(sql`created_by_subject->>'subject_id'`, '=', input.created_by)
        .where('session_id', '=', input.session_id)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        return undefined;
      }
      if (existing.repository_id !== null) {
        const repository = await this.getRepositoryForUpdate(trx, {
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          repository_id: existing.repository_id,
        });
        if (repository === undefined) {
          return undefined;
        }
        assertRevision(repository, input.expected_revision);
      }
      let query = trx
        .updateTable('session')
        .set({ repository_id: null, workspace_cwd: null })
        .where('tenant_id', '=', input.tenant_id)
        .where(sql`created_by_subject->>'subject_id'`, '=', input.created_by)
        .where('session_id', '=', input.session_id);
      if (existing.repository_id === null) {
        query = query.where('repository_id', 'is', null);
      } else {
        query = query.where('repository_id', '=', existing.repository_id);
      }
      const row = await query
        .returning([
          'tenant_id',
          'session_id',
          sql<string>`created_by_subject->>'subject_id'`.as('created_by'),
          'repository_id',
          'workspace_cwd',
        ])
        .executeTakeFirst();
      return row === undefined ? undefined : toSessionBindingRecord(row);
    };
    return transaction ? run(transaction) : this.#db.transaction().execute(run);
  }

  async listVerifyCommands(
    input: GetRepositoryInput,
    transaction?: Transaction<Database>,
  ): Promise<VerifyCommandRecord[]> {
    const db = transaction ?? this.#db;
    const repository = await this.getRepository(input, transaction);
    if (repository === undefined) {
      return [];
    }
    const rows = await db
      .selectFrom('repository_verify_command')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .orderBy('purpose')
      .orderBy('command_id')
      .execute();
    return rows.map(toCommandRecord);
  }

  async upsertVerifyCommand(
    input: VerifyCommandInput,
    transaction?: Transaction<Database>,
  ): Promise<VerifyCommandMutationResult | undefined> {
    validateTimeout(input.timeout_ms);
    const run = async (trx: Transaction<Database>): Promise<VerifyCommandMutationResult | undefined> => {
      const repository = await this.getRepositoryForUpdate(trx, input);
      if (repository === undefined) {
        return undefined;
      }
      assertRevision(repository, input.expected_revision);
      const timestamp = now();
      const row = await trx
        .insertInto('repository_verify_command')
        .values({
          repository_id: input.repository_id,
          command_id: input.command_id,
          purpose: input.purpose,
          command: input.command,
          timeout_ms: input.timeout_ms,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict(oc =>
          oc.columns(['repository_id', 'command_id']).doUpdateSet({
            purpose: input.purpose,
            command: input.command,
            timeout_ms: input.timeout_ms,
            updated_at: timestamp,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      const repository_revision = await this.bumpRevision(trx, repository);
      return { command: toCommandRecord(row), repository_revision };
    };
    return transaction ? run(transaction) : this.#db.transaction().execute(run);
  }

  async deleteVerifyCommand(input: DeleteVerifyCommandInput, transaction?: Transaction<Database>): Promise<void> {
    const run = async (trx: Transaction<Database>): Promise<void> => {
      const repository = await this.getRepositoryForUpdate(trx, input);
      if (repository === undefined) {
        return;
      }
      assertRevision(repository, input.expected_revision);
      const result = await trx
        .deleteFrom('repository_verify_command')
        .where('repository_id', '=', repository.id)
        .where('command_id', '=', input.command_id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) > 0) {
        await this.bumpRevision(trx, repository);
      }
    };
    return transaction ? run(transaction) : this.#db.transaction().execute(run);
  }

  async listVerifyCommandProposals(
    input: GetRepositoryInput,
    transaction?: Transaction<Database>,
  ): Promise<VerifyCommandProposalRecord[]> {
    const db = transaction ?? this.#db;
    const repository = await this.getRepository(input, transaction);
    if (repository === undefined) {
      return [];
    }
    const rows = await db
      .selectFrom('repository_verify_command_proposal')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toProposalRecord);
  }

  async upsertVerifyCommandProposal(
    input: VerifyCommandProposalInput,
    transaction?: Transaction<Database>,
  ): Promise<VerifyCommandProposalRecord | undefined> {
    const db = transaction ?? this.#db;
    const repository = await this.getRepository(input, transaction);
    if (repository === undefined) {
      return undefined;
    }
    const timestamp = now();
    const row = await db
      .insertInto('repository_verify_command_proposal')
      .values({
        id: input.id,
        repository_id: input.repository_id,
        purpose: input.purpose,
        command: input.command,
        source_kind: input.source_kind,
        source_path: input.source_path,
        source_fingerprint: input.source_fingerprint,
        created_at: timestamp,
      })
      .onConflict(oc =>
        oc.columns(['repository_id', 'id']).doUpdateSet({
          purpose: input.purpose,
          command: input.command,
          source_kind: input.source_kind,
          source_path: input.source_path,
          source_fingerprint: input.source_fingerprint,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toProposalRecord(row);
  }

  async replaceVerifyCommandProposals(
    input: ReplaceVerifyCommandProposalsInput,
    transaction?: Transaction<Database>,
  ): Promise<void> {
    const observed = new Set(input.observed_sources.map(source => `${source.source_kind}\u0000${source.source_path}`));
    if (input.proposals.some(proposal => !observed.has(`${proposal.source_kind}\u0000${proposal.source_path}`))) {
      throw new Error('repository command proposal did not originate from an observed source');
    }
    const run = async (trx: Transaction<Database>): Promise<void> => {
      const repository = await this.getRepositoryForUpdate(trx, input);
      if (repository === undefined) {
        return;
      }
      assertRevision(repository, input.expected_revision);
      if (input.observed_sources.length === 0) {
        await trx.deleteFrom('repository_verify_command_proposal').where('repository_id', '=', repository.id).execute();
      } else {
        await trx
          .deleteFrom('repository_verify_command_proposal')
          .where('repository_id', '=', repository.id)
          .where(eb =>
            eb.or(
              input.observed_sources.map(source =>
                eb.and([eb('source_kind', '=', source.source_kind), eb('source_path', '=', source.source_path)]),
              ),
            ),
          )
          .execute();
      }
      if (input.proposals.length === 0) {
        return;
      }
      await trx
        .insertInto('repository_verify_command_proposal')
        .values(
          input.proposals.map(proposal => ({
            ...proposal,
            repository_id: repository.id,
            created_at: now(),
          })),
        )
        .onConflict(oc =>
          oc.columns(['repository_id', 'id']).doUpdateSet(eb => ({
            purpose: eb.ref('excluded.purpose'),
            command: eb.ref('excluded.command'),
            source_kind: eb.ref('excluded.source_kind'),
            source_path: eb.ref('excluded.source_path'),
            source_fingerprint: eb.ref('excluded.source_fingerprint'),
          })),
        )
        .execute();
    };
    return transaction ? run(transaction) : this.#db.transaction().execute(run);
  }

  async deleteVerifyCommandProposal(
    input: DeleteVerifyCommandProposalInput,
    transaction?: Transaction<Database>,
  ): Promise<void> {
    const db = transaction ?? this.#db;
    const repository = await this.getRepository(input, transaction);
    if (repository === undefined) {
      return;
    }
    await db
      .deleteFrom('repository_verify_command_proposal')
      .where('repository_id', '=', repository.id)
      .where('id', '=', input.proposal_id)
      .execute();
  }

  async confirmVerifyCommandProposal(
    input: ConfirmVerifyCommandProposalInput,
    transaction?: Transaction<Database>,
  ): Promise<VerifyCommandMutationResult | undefined> {
    validateTimeout(input.timeout_ms);
    const run = async (trx: Transaction<Database>): Promise<VerifyCommandMutationResult | undefined> => {
      const repository = await this.getRepositoryForUpdate(trx, input);
      if (repository === undefined) {
        return undefined;
      }
      assertRevision(repository, input.expected_revision);
      const proposal = await trx
        .selectFrom('repository_verify_command_proposal')
        .selectAll()
        .where('repository_id', '=', repository.id)
        .where('id', '=', input.proposal_id)
        .executeTakeFirst();
      if (proposal === undefined) {
        return undefined;
      }
      const timestamp = now();
      const command = await trx
        .insertInto('repository_verify_command')
        .values({
          repository_id: repository.id,
          command_id: input.command_id,
          purpose: proposal.purpose,
          command: proposal.command,
          timeout_ms: input.timeout_ms,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict(oc =>
          oc.columns(['repository_id', 'command_id']).doUpdateSet({
            purpose: proposal.purpose,
            command: proposal.command,
            timeout_ms: input.timeout_ms,
            updated_at: timestamp,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .deleteFrom('repository_verify_command_proposal')
        .where('repository_id', '=', repository.id)
        .where('id', '=', input.proposal_id)
        .execute();
      const repository_revision = await this.bumpRevision(trx, repository);
      return { command: toCommandRecord(command), repository_revision };
    };
    return transaction ? run(transaction) : this.#db.transaction().execute(run);
  }

  async acquireLease(input: WorkspaceVerificationLeaseInput): Promise<{ mutation_epoch: number } | undefined> {
    const inserted = await this.#db
      .insertInto('repository_workspace_verification')
      .values({
        repository_id: input.repository_id,
        workspace_cwd: input.workspace_cwd,
        mutation_epoch: 0,
        lease_owner_id: input.owner_id,
        lease_id: input.lease_id,
        lease_expires_at: input.lease_expires_at,
        observation_pending: false,
        receipt_state_sha256: null,
        receipt_command: null,
        receipt_created_at: null,
        receipt_result_session_id: null,
        receipt_result_turn_id: null,
        receipt_result_thread_id: null,
        receipt_result_tool_call_id: null,
        receipt_result_event_id: null,
      })
      .onConflict(oc => oc.columns(['repository_id', 'workspace_cwd']).doNothing())
      .returning('mutation_epoch')
      .executeTakeFirst();
    if (inserted !== undefined) {
      return inserted;
    }
    return this.#db
      .updateTable('repository_workspace_verification')
      .set({
        mutation_epoch: sql<number>`CASE WHEN observation_pending THEN mutation_epoch + 1 ELSE mutation_epoch END`,
        lease_owner_id: input.owner_id,
        lease_id: input.lease_id,
        lease_expires_at: input.lease_expires_at,
        observation_pending: false,
        receipt_state_sha256: sql<string | null>`CASE WHEN observation_pending THEN NULL ELSE receipt_state_sha256 END`,
        receipt_command: sql<string | null>`CASE WHEN observation_pending THEN NULL ELSE receipt_command END`,
        receipt_created_at: sql<Date | null>`CASE WHEN observation_pending THEN NULL ELSE receipt_created_at END`,
        receipt_result_session_id: sql<
          string | null
        >`CASE WHEN observation_pending THEN NULL ELSE receipt_result_session_id END`,
        receipt_result_turn_id: sql<
          string | null
        >`CASE WHEN observation_pending THEN NULL ELSE receipt_result_turn_id END`,
        receipt_result_thread_id: sql<
          string | null
        >`CASE WHEN observation_pending THEN NULL ELSE receipt_result_thread_id END`,
        receipt_result_tool_call_id: sql<
          string | null
        >`CASE WHEN observation_pending THEN NULL ELSE receipt_result_tool_call_id END`,
        receipt_result_event_id: sql<
          string | null
        >`CASE WHEN observation_pending THEN NULL ELSE receipt_result_event_id END`,
      })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where(eb => eb.or([eb('lease_id', 'is', null), eb('lease_expires_at', '<=', now())]))
      .returning('mutation_epoch')
      .executeTakeFirst();
  }

  async renewLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id' | 'lease_expires_at'>,
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('repository_workspace_verification')
      .set({ lease_expires_at: sql<Date>`GREATEST(lease_expires_at, ${input.lease_expires_at})` })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where('lease_id', '=', input.lease_id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async releaseLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'>,
  ): Promise<void> {
    await this.#db
      .updateTable('repository_workspace_verification')
      .set({ lease_owner_id: null, lease_id: null, lease_expires_at: null })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where('lease_id', '=', input.lease_id)
      .execute();
  }

  async beginStateObservation(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'> & {
      invalidate_receipt: boolean;
    },
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('repository_workspace_verification')
      .set({
        observation_pending: true,
        ...(input.invalidate_receipt
          ? {
              receipt_state_sha256: null,
              receipt_command: null,
              receipt_created_at: null,
              receipt_result_session_id: null,
              receipt_result_turn_id: null,
              receipt_result_thread_id: null,
              receipt_result_tool_call_id: null,
              receipt_result_event_id: null,
            }
          : {}),
      })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where('lease_id', '=', input.lease_id)
      .where('lease_expires_at', '>', now())
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async observeState(input: ObserveWorkspaceVerificationStateInput): Promise<number | undefined> {
    const changed = input.after_state_sha256 === null || input.after_state_sha256 !== input.before_state_sha256;
    if (!changed) {
      return this.#db
        .updateTable('repository_workspace_verification')
        .set({ observation_pending: false })
        .where('repository_id', '=', input.repository_id)
        .where('workspace_cwd', '=', input.workspace_cwd)
        .where('lease_id', '=', input.lease_id)
        .where('observation_pending', '=', true)
        .returning('mutation_epoch')
        .executeTakeFirst()
        .then(row => row?.mutation_epoch);
    }
    return this.#db
      .updateTable('repository_workspace_verification')
      .set({
        mutation_epoch: sql<number>`mutation_epoch + 1`,
        receipt_state_sha256: null,
        receipt_command: null,
        receipt_created_at: null,
        receipt_result_session_id: null,
        receipt_result_turn_id: null,
        receipt_result_thread_id: null,
        receipt_result_tool_call_id: null,
        receipt_result_event_id: null,
        observation_pending: false,
      })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where('lease_id', '=', input.lease_id)
      .where('observation_pending', '=', true)
      .returning('mutation_epoch')
      .executeTakeFirst()
      .then(row => row?.mutation_epoch);
  }

  async activateReceipt(input: ActivateWorkspaceVerificationReceiptInput): Promise<boolean> {
    const durableResult = await this.#db
      .selectFrom('session_event as event')
      .innerJoin('thread_context_log as context', join =>
        join
          .onRef('context.session_id', '=', 'event.session_id')
          .onRef('context.turn_id', '=', 'event.turn_id')
          .on('context.thread_id', '=', input.result_thread_id),
      )
      .select(['event.session_id', 'event.turn_id'])
      .where('event.event_id', '=', input.result_event_id)
      .where(sql<boolean>`event.event ->> 'type' = 'tool.response.v2'`)
      .where(sql<boolean>`event.event ->> 'thread_id' = ${input.result_thread_id}`)
      .where(sql<boolean>`event.event ->> 'tool_call_id' = ${input.result_tool_call_id}`)
      .where(sql<boolean>`event.event ->> 'disposition' = 'executed_ok'`)
      .where(sql<boolean>`context.body ->> 'role' = 'tool'`)
      .where(sql<boolean>`context.body ->> 'tool_call_id' = ${input.result_tool_call_id}`)
      .executeTakeFirst();
    if (durableResult === undefined) {
      return false;
    }
    const result = await this.#db
      .updateTable('repository_workspace_verification')
      .set({
        receipt_state_sha256: input.state_sha256,
        receipt_command: input.command,
        receipt_created_at: input.created_at,
        receipt_result_session_id: durableResult.session_id,
        receipt_result_turn_id: durableResult.turn_id,
        receipt_result_thread_id: input.result_thread_id,
        receipt_result_tool_call_id: input.result_tool_call_id,
        receipt_result_event_id: input.result_event_id,
      })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where('lease_id', '=', input.lease_id)
      .where('lease_expires_at', '>', now())
      .where('observation_pending', '=', false)
      .where('mutation_epoch', '=', input.mutation_epoch)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async consumeReceipt(input: ConsumeWorkspaceVerificationReceiptInput): Promise<boolean> {
    const result = await this.#db
      .updateTable('repository_workspace_verification')
      .set({
        receipt_state_sha256: null,
        receipt_command: null,
        receipt_created_at: null,
        receipt_result_session_id: null,
        receipt_result_turn_id: null,
        receipt_result_thread_id: null,
        receipt_result_tool_call_id: null,
        receipt_result_event_id: null,
      })
      .where('repository_id', '=', input.repository_id)
      .where('workspace_cwd', '=', input.workspace_cwd)
      .where('lease_id', '=', input.lease_id)
      .where('lease_expires_at', '>', now())
      .where('observation_pending', '=', false)
      .where('mutation_epoch', '=', input.mutation_epoch)
      .where('receipt_state_sha256', '=', input.state_sha256)
      .where(
        sql<boolean>`EXISTS (
        SELECT 1
        FROM session_event AS event
        JOIN thread_context_log AS context
          ON context.session_id = event.session_id
         AND context.turn_id = event.turn_id
         AND context.thread_id = repository_workspace_verification.receipt_result_thread_id
        WHERE event.session_id = repository_workspace_verification.receipt_result_session_id
          AND event.turn_id = repository_workspace_verification.receipt_result_turn_id
          AND event.event_id = repository_workspace_verification.receipt_result_event_id
          AND event.event ->> 'type' = 'tool.response.v2'
          AND event.event ->> 'thread_id' = repository_workspace_verification.receipt_result_thread_id
          AND event.event ->> 'tool_call_id' = repository_workspace_verification.receipt_result_tool_call_id
          AND event.event ->> 'disposition' = 'executed_ok'
          AND context.body ->> 'role' = 'tool'
          AND context.body ->> 'tool_call_id' = repository_workspace_verification.receipt_result_tool_call_id
      )`,
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  private async getRepositoryForUpdate(
    transaction: Transaction<Database>,
    input: GetRepositoryInput,
  ): Promise<RepositoryRecord | undefined> {
    const row = await transaction
      .selectFrom('repository')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.repository_id)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toRepositoryRecord(row);
  }

  private async bumpRevision(trx: Transaction<Database>, repository: RepositoryRecord): Promise<number> {
    const result = await trx
      .updateTable('repository')
      .set({ revision: sql<number>`revision + 1`, updated_at: now() })
      .where('id', '=', repository.id)
      .where('tenant_id', '=', repository.tenant_id)
      .where('created_by', '=', repository.created_by)
      .where('revision', '=', repository.revision)
      .returning('revision')
      .executeTakeFirst();
    if (result !== undefined) {
      return result.revision;
    }
    const actual = await this.getRepository(
      {
        tenant_id: repository.tenant_id,
        created_by: repository.created_by,
        repository_id: repository.id,
      },
      trx,
    );
    throw new RepositoryRevisionConflictError({
      repository_id: repository.id,
      expected_revision: repository.revision,
      actual_revision: actual?.revision ?? repository.revision,
    });
  }
}
