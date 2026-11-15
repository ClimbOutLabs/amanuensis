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
   * The code version every persisted network grant on this skill is bound to: the commit a
   * git skill's ref named when the grant was saved, or a registry skill's version name. Set
   * when an approval is saved, or when a per-site allowance is saved on a skill with no
   * binding yet, and cleared when the last grant goes. Null when the skill holds no grants,
   * or for grants saved before pinning existed. When the skill's code moves off the pin,
   * the grants are cancelled and the network card asks again.
   */
  network_approval_code_sha: string | null;
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
  /**
   * The code version the grants are pinned to, stored when the approval is set. On removal
   * this value does not decide the pin: the pin follows the grants, staying while per-site
   * allowances remain and clearing when none remain.
   */
  code_sha: string | null;
}

export interface SetSkillNetworkCodePinInput {
  tenant_id: string;
  name: string;
  /** The code version the skill's persisted grants are bound to from now on. */
  code_sha: string;
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
   * record, or undefined when no skill with that name exists. Clearing the last per-site
   * allowance on a skill with no approval also clears the code pin: a pin binds grants,
   * and with none left there is nothing for it to bind.
   */
  setSkillNetworkHostDecision(
    input: SetSkillNetworkHostDecisionInput,
    transaction?: TTransaction,
  ): Promise<SkillRecord | undefined>;
  /**
   * Stores the code version the skill's persisted grants are bound to, without touching the
   * grants themselves: how an allowance write binds a skill that holds no approval and no
   * pin yet. Returns the updated record, or undefined when no skill with that name exists.
   */
  setSkillNetworkCodePin(
    input: SetSkillNetworkCodePinInput,
    transaction?: TTransaction,
  ): Promise<SkillRecord | undefined>;
  listSkillVersions(input: { name: string }): Promise<SkillVersion[]>;
  /** Admit AgentSpec skill refs (git store or TrueFoundry SFY resolve with caller token). */
  validateAgentSkills(input: AgentSkillsInput, transaction?: TTransaction): Promise<void>;
  /** Expand AgentSpec skill refs to sandbox mounts (git store or TrueFoundry SFY resolve with API key). */
  resolveTurnSkills(input: AgentSkillsInput): Promise<SkillMount[]>;
}
