import type { Skill as SkillMount } from '@truefoundry/trueforge-core/core';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { SkillVersion } from '../../../schemas/skill';
import { resolveGitTurnSkills, validateGitAgentSkills } from '../../gitSkillMounts';
import {
  SkillNameConflictError,
  type AgentSkillsInput,
  type CreateSkillInput,
  type GetSkillInput,
  type ISkillStore,
  type ListSkillsInput,
  type SetSkillNetworkApprovalInput,
  type SetSkillNetworkCodePinInput,
  type SetSkillNetworkHostDecisionInput,
  type SkillRecord,
  type UpsertSkillInput,
} from '../../skillStore';
import { isUniqueViolation } from '../client';
import { json, now } from '../sqlExpressions';
import type { Database, SkillTable } from '../types';

function toRecord(row: Selectable<SkillTable>): SkillRecord {
  return {
    tenant_id: row.tenant_id,
    name: row.name,
    manifest: row.manifest,
    network_approval: row.network_approval,
    network_approval_code_sha: row.network_approval_code_sha,
    network_allowed_hosts: row.network_allowed_hosts,
    network_denied_hosts: row.network_denied_hosts,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class PostgresSkillStore implements ISkillStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async listSkills(input: ListSkillsInput, transaction?: Transaction<Database>): Promise<SkillRecord[]> {
    if (input.names?.length === 0) {
      return [];
    }
    const db = transaction ?? this.#db;
    let query = db.selectFrom('skill').selectAll().where('tenant_id', '=', input.tenant_id);
    if (input.names !== undefined) {
      query = query.where('name', 'in', [...input.names]);
    }
    const rows = await query.orderBy('name').execute();
    return rows.map(toRecord);
  }

  async createSkill(input: CreateSkillInput, transaction?: Transaction<Database>): Promise<SkillRecord> {
    const db = transaction ?? this.#db;
    try {
      const row = await db
        .insertInto('skill')
        .values({
          tenant_id: input.tenant_id,
          name: input.name,
          manifest: json(input.manifest),
          network_approval: null,
          network_approval_code_sha: null,
          network_allowed_hosts: json([]),
          network_denied_hosts: json([]),
          created_at: now(),
          updated_at: now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SkillNameConflictError({ tenant_id: input.tenant_id, name: input.name }, { cause: error });
      }
      throw error;
    }
  }

  async upsertSkill(input: UpsertSkillInput, transaction?: Transaction<Database>): Promise<SkillRecord> {
    const db = transaction ?? this.#db;
    const row = await db
      .insertInto('skill')
      .values({
        tenant_id: input.tenant_id,
        name: input.name,
        manifest: json(input.manifest),
        network_approval: null,
        network_approval_code_sha: null,
        network_allowed_hosts: json([]),
        network_denied_hosts: json([]),
        created_at: now(),
        updated_at: now(),
      })
      .onConflict(oc =>
        oc.columns(['tenant_id', 'name']).doUpdateSet({
          manifest: json(input.manifest),
          updated_at: now(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async setSkillNetworkApproval(
    input: SetSkillNetworkApprovalInput,
    transaction?: Transaction<Database>,
  ): Promise<SkillRecord | undefined> {
    const db = transaction ?? this.#db;
    if (input.hosts !== null) {
      const row = await db
        .updateTable('skill')
        .set({
          network_approval: json([...input.hosts]),
          network_approval_code_sha: input.code_sha,
          updated_at: now(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('name', '=', input.name)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    }
    // Removing the approval does not unbind the grants that remain: the pin stays while
    // per-site allowances stand, and clears when none do.
    const current = await db
      .selectFrom('skill')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (current === undefined) {
      return undefined;
    }
    const row = await db
      .updateTable('skill')
      .set({
        network_approval: null,
        network_approval_code_sha: current.network_allowed_hosts.length > 0 ? current.network_approval_code_sha : null,
        updated_at: now(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async setSkillNetworkHostDecision(
    input: SetSkillNetworkHostDecisionInput,
    transaction?: Transaction<Database>,
  ): Promise<SkillRecord | undefined> {
    const db = transaction ?? this.#db;
    const current = await db
      .selectFrom('skill')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (current === undefined) {
      return undefined;
    }
    const allowed = new Set(current.network_allowed_hosts);
    const denied = new Set(current.network_denied_hosts);
    if (input.decision === 'allowed') {
      allowed.add(input.host);
      denied.delete(input.host);
    } else if (input.decision === 'denied') {
      denied.add(input.host);
      allowed.delete(input.host);
    } else {
      allowed.delete(input.host);
      denied.delete(input.host);
    }
    // With no approval and no allowance left, nothing remains for the pin to bind.
    const clearPin = current.network_approval === null && allowed.size === 0;
    const row = await db
      .updateTable('skill')
      .set({
        network_allowed_hosts: json([...allowed].sort()),
        network_denied_hosts: json([...denied].sort()),
        network_approval_code_sha: clearPin ? null : current.network_approval_code_sha,
        updated_at: now(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async setSkillNetworkCodePin(
    input: SetSkillNetworkCodePinInput,
    transaction?: Transaction<Database>,
  ): Promise<SkillRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('skill')
      .set({
        network_approval_code_sha: input.code_sha,
        updated_at: now(),
      })
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async deleteSkill(input: GetSkillInput, transaction?: Transaction<Database>): Promise<boolean> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('skill')
      .where('tenant_id', '=', input.tenant_id)
      .where('name', '=', input.name)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  listSkillVersions(input: { name: string }): Promise<SkillVersion[]> {
    void input;
    return Promise.resolve([]);
  }

  validateAgentSkills(input: AgentSkillsInput, transaction?: Transaction<Database>): Promise<void> {
    void transaction;
    return validateGitAgentSkills(this, input);
  }

  resolveTurnSkills(input: AgentSkillsInput): Promise<SkillMount[]> {
    return resolveGitTurnSkills(this, input);
  }
}
