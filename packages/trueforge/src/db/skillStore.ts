/**
 * DB-backed configured skills: one row per skill per tenant,
 * identity as columns plus a Zod-validated `SkillManifest` jsonb document.
 * Implementations: PostgresSkillStore and SqliteSkillStore.
 */
import type { Skill as AgentSkillRef } from '@truefoundry/trueforge-core/agent-session';
import type { Skill as SkillMount } from '@truefoundry/trueforge-core/core';
import type { SkillManifest, SkillVersion } from '../schemas/skill';

export interface SkillRecord {
  tenant_id: string;
  /**
   * Store identity: git ResourceName in standalone, registry version FQN in TrueFoundry.
   * Same string as AgentSpec `skills[].name`, list filters, and AvailableSkill `name`.
   */
  name: string;
  manifest: SkillManifest;
  /**
   * The exact site list the person approved for this skill's network access, or null when they
   * have not approved (or approval was removed). Stored beside the manifest, never inside it:
   * editing the skill must not silently grant or widen access.
   */
  network_approval: readonly string[] | null;
  /**
   * Sites the person allowed one by one for this skill, from a network card or Settings. Each
   * site stands on its own: allowing one never changes the declared list or its approval.
   */
  network_allowed_hosts: readonly string[];
  /**
   * Sites the person turned down for this skill, from a network card or Settings. A denied site
   * is never granted and raises no further card until the person clears it in Settings.
   */
  network_denied_hosts: readonly string[];
  /** ISO-8601 UTC instant. */
  created_at: string;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

export interface GetSkillInput {
  tenant_id: string;
  name: string;
}

export interface ListSkillsInput {
  tenant_id: string;
  /** `undefined` lists all; empty returns `[]` without querying; otherwise `WHERE name IN (...)`. */
  names: readonly string[] | undefined;
}

export interface CreateSkillInput {
  tenant_id: string;
  name: string;
  manifest: SkillManifest;
}

/** Same shape as create for now; kept as a distinct name for the upsert path. */
export type UpsertSkillInput = CreateSkillInput;

export interface SetSkillNetworkApprovalInput {
  tenant_id: string;
  name: string;
  /** The approved site list, or null to remove the approval. */
  hosts: readonly string[] | null;
}

export interface SetSkillNetworkHostDecisionInput {
  tenant_id: string;
  name: string;
  /** The one site the decision is about. */
  host: string;
  /**
   * `allowed` allows the site on its own, `denied` turns it down, and `none` clears either
   * earlier decision. A site holds one decision at a time: a new one replaces the old.
   */
  decision: 'allowed' | 'denied' | 'none';
}

/** AgentSpec `skills` refs for validate and resolve. */
export interface AgentSkillsInput {
  tenant_id: string;
  skills: readonly AgentSkillRef[];
}

/** Unique `(tenant_id, name)` violation on create. */
export class SkillNameConflictError extends Error {
  readonly tenant_id: string;
  readonly skill_name: string;

  constructor({ tenant_id, name }: { tenant_id: string; name: string }, options?: ErrorOptions) {
    super(`Skill name already exists: ${name}`, options);
    this.name = 'SkillNameConflictError';
    this.tenant_id = tenant_id;
    this.skill_name = name;
  }
}

export interface ISkillStore<TTransaction = never> {
  listSkills(input: ListSkillsInput, transaction?: TTransaction): Promise<SkillRecord[]>;
  /** Inserts a new skill. Throws SkillNameConflictError on name clash. */
  createSkill(input: CreateSkillInput, transaction?: TTransaction): Promise<SkillRecord>;
  /** Single-row write: creates the skill or replaces the whole manifest. */
  upsertSkill(input: UpsertSkillInput, transaction?: TTransaction): Promise<SkillRecord>;
  /** Deletes a skill. Returns true if a row was deleted, false if none matched. */
  deleteSkill(input: GetSkillInput, transaction?: TTransaction): Promise<boolean>;
  /**
   * Stores or clears the person's network approval for one skill. Returns the updated record,
   * or undefined when no skill with that name exists.
   */
  setSkillNetworkApproval(
    input: SetSkillNetworkApprovalInput,
    transaction?: TTransaction,
  ): Promise<SkillRecord | undefined>;
  /**
   * Stores or clears the person's decision on one site for one skill. Returns the updated
   * record, or undefined when no skill with that name exists.
   */
  setSkillNetworkHostDecision(
    input: SetSkillNetworkHostDecisionInput,
    transaction?: TTransaction,
  ): Promise<SkillRecord | undefined>;
  listSkillVersions(input: { name: string }): Promise<SkillVersion[]>;
  /** Admit AgentSpec skill refs (git store or TrueFoundry SFY resolve with caller token). */
  validateAgentSkills(input: AgentSkillsInput, transaction?: TTransaction): Promise<void>;
  /** Expand AgentSpec skill refs to sandbox mounts (git store or TrueFoundry SFY resolve with API key). */
  resolveTurnSkills(input: AgentSkillsInput): Promise<SkillMount[]>;
}
