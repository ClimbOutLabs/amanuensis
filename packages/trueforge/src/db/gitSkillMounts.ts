import type { Skill as SkillMount } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import { effectiveSkillNetworkHosts, parseGitSkill } from '../schemas/skill';
import type { AgentSkillsInput, ISkillStore } from './skillStore';

/** Admit configured git skills; reject preload. */
export async function validateGitAgentSkills(
  store: Pick<ISkillStore, 'listSkills'>,
  input: AgentSkillsInput,
): Promise<void> {
  const { tenant_id, skills } = input;
  if (skills.length === 0) {
    return;
  }
  for (const skill of skills) {
    if (skill.preload) {
      throw new HTTPException(422, {
        message: `Skill "${skill.name}": preload is not supported for git skills`,
      });
    }
  }
  const names = skills.map(skill => skill.name);
  const byName = new Map((await store.listSkills({ tenant_id, names })).map(record => [record.name, record]));
  for (const skill of skills) {
    const record = byName.get(skill.name);
    if (record === undefined) {
      throw new HTTPException(422, {
        message: `Unknown skill "${skill.name}" — not configured`,
      });
    }
    if (record.manifest.type !== 'git') {
      throw new HTTPException(422, {
        message: `Skill "${skill.name}" is not a git skill`,
      });
    }
  }
}

/** Expand configured git skills to sandbox mounts. */
export async function resolveGitTurnSkills(
  store: Pick<ISkillStore, 'listSkills'>,
  input: AgentSkillsInput,
): Promise<SkillMount[]> {
  const { tenant_id, skills } = input;
  if (skills.length === 0) {
    return [];
  }
  const names = skills.map(skill => skill.name);
  const records = await store.listSkills({ tenant_id, names });
  const byName = new Map(records.map(record => [record.name, record]));
  const resolved: SkillMount[] = [];
  for (const skill of skills) {
    const record = byName.get(skill.name);
    if (record === undefined) {
      throw new HTTPException(422, {
        message: `Unknown skill "${skill.name}" — not configured`,
      });
    }
    const git = parseGitSkill(record.manifest);
    if (git === undefined) {
      throw new HTTPException(422, {
        message: `Skill "${skill.name}" is not a git skill`,
      });
    }
    // While a network approval is in force, the mount fetches the exact code the approval
    // covers: the stored pin, never the ref, so the code that was checked is the code that
    // runs. Without an approval in force the manifest ref is used, as before.
    const approvalInForce =
      effectiveSkillNetworkHosts({
        declared: git.network_hosts,
        approved: record.network_approval,
        denied: record.network_denied_hosts,
      }) !== null;
    resolved.push({
      type: 'git',
      name: git.name,
      description: git.description,
      url: git.url,
      path: git.path ?? '',
      ref: approvalInForce && record.network_approval_code_sha !== null ? record.network_approval_code_sha : git.ref,
    });
  }
  return resolved;
}
