/**
 * Activation pinning: resolve a saved agent's setup into the snapshot a goal
 * runs with, and tell whether the saved agent still matches it.
 *
 * The agent store keeps no loadable version history, so the pin is a versioned
 * snapshot stored with the goal (spec section 10), stamped with a digest of the
 * exact setup resolved. The snapshot holds the setup the owner reviewed: model,
 * instructions, tool and connector selection, and each skill's content digest.
 * It never holds credentials; connector sign-ins stay in the connector store
 * and are rechecked when a cycle runs.
 */
import type { AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import { createHash } from 'node:crypto';
import type { AgentRecord } from '../../db/agentStore';
import type { ISkillStore } from '../../db/skillStore';
import type { PinnedAgentSetup, PinnedSkill } from './goalStorePort';

/** A skill the setup names is not in the skill store, so the setup cannot be pinned as reviewed. */
export class GoalSetupResolutionError extends Error {
  readonly skill_name: string;

  constructor(skillName: string, options?: ErrorOptions) {
    super(`The setup uses a skill that is not on this machine: ${skillName}`, options);
    this.name = 'GoalSetupResolutionError';
    this.skill_name = skillName;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted at every depth, so equal setups hash equally however they were built. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify hands back undefined for undefined, functions, and symbols; those spell as null here.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return 'null';
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  }
  if (!isRecord(value)) {
    // Only records reach this point; the guard narrows the type without a cast.
    return 'null';
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The digest an activation binds: the agent's identity plus its full setup and skill digests. */
export function setupDigestOf(input: { agent_id: string; spec: AgentSpec; skills: readonly PinnedSkill[] }): string {
  return sha256Hex(
    canonicalJson({
      agent_id: input.agent_id,
      spec: input.spec,
      skills: input.skills.map(skill => ({ name: skill.name, preload: skill.preload, digest: skill.digest })),
    }),
  );
}

/**
 * Resolve the setup of a saved agent into its pinned snapshot. Skill digests come
 * from the skill store's current content, so a skill edited after activation
 * digests differently and the change is seen.
 */
export async function resolvePinnedSetup(input: {
  agent: AgentRecord;
  skillStore: Pick<ISkillStore, 'listSkills'>;
  tenant_id: string;
  now: Date;
}): Promise<PinnedAgentSetup> {
  const spec = input.agent.manifest;
  const refs = spec.skills ?? [];
  const records =
    refs.length === 0
      ? []
      : await input.skillStore.listSkills({
          tenant_id: input.tenant_id,
          names: refs.map(ref => ref.name),
        });
  const skills: PinnedSkill[] = refs.map(ref => {
    const record = records.find(candidate => candidate.name === ref.name);
    if (record === undefined) {
      throw new GoalSetupResolutionError(ref.name);
    }
    return { name: ref.name, preload: ref.preload, digest: sha256Hex(canonicalJson(record.manifest)) };
  });
  return {
    agent_id: input.agent.id,
    agent_name: input.agent.name,
    // The agent store has no version counter; its own last-saved stamp is the version the pin names.
    agent_version: input.agent.updated_at,
    spec,
    skills,
    digest: setupDigestOf({ agent_id: input.agent.id, spec, skills }),
    pinned_at: input.now.toISOString(),
  };
}

/** True when the setup resolved now is not the setup the pin holds. */
export function pinnedSetupChanged(input: { pinned: PinnedAgentSetup; current: PinnedAgentSetup }): boolean {
  return input.pinned.digest !== input.current.digest;
}
