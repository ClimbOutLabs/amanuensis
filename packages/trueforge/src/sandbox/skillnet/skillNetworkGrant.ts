import type { ISkillStore } from '../../db/skillStore';
import { effectiveSkillNetworkHosts, parseGitSkill } from '../../schemas/skill';
import type { SkillNetworkTokenRegistry } from './skillNetworkTokens';

/**
 * The skill network grant for one chat, read fresh from the skill records on every call: the
 * union of the sites each mounted skill both declares and has approved. Reading the records
 * every time is what makes removing an approval in Settings take effect on the next command.
 * When nothing is approved, any earlier grant for the chat is revoked and undefined comes back.
 */
export async function resolveSkillNetworkGrant(input: {
  store: ISkillStore;
  registry: SkillNetworkTokenRegistry;
  tenant_id: string;
  created_by: string;
  session_id: string;
  skillNames: readonly string[];
}): Promise<{ token: string; hosts: readonly string[] } | undefined> {
  if (input.skillNames.length === 0) {
    return undefined;
  }
  const records = await input.store.listSkills({
    tenant_id: input.tenant_id,
    names: input.skillNames,
  });
  const hosts = new Set<string>();
  for (const record of records) {
    const manifest = parseGitSkill(record.manifest);
    const effective = effectiveSkillNetworkHosts({
      declared: manifest?.network_hosts,
      approved: record.network_approval,
    });
    if (effective !== null) {
      for (const host of effective) {
        hosts.add(host);
      }
    }
  }
  if (hosts.size === 0) {
    input.registry.revokeSession(input.session_id);
    return undefined;
  }
  const sorted = [...hosts].sort();
  const token = input.registry.issue({
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    session_id: input.session_id,
    hosts: sorted,
  });
  return { token, hosts: sorted };
}
