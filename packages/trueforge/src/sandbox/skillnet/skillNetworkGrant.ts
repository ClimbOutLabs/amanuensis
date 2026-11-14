import type { ISkillStore } from '../../db/skillStore';
import { grantedSkillNetworkHosts, isSkillNetworkHostName, parseGitSkill } from '../../schemas/skill';
import type { SkillNetworkTokenRegistry } from './skillNetworkTokens';

/** Why a network card is being asked: the skill's first use, or a site it reached for without declaring. */
export type SkillNetworkCardReason = 'first_use' | 'undeclared_host';

/** One card the runtime should raise: the skill, the sites it asks for, and why it is asked. */
export interface SkillNetworkCardRequest {
  skill_name: string;
  hosts: readonly string[];
  reason: SkillNetworkCardReason;
}

/**
 * The skill network grant for one chat, read fresh from the skill records on every call: the
 * union of the sites each mounted skill may reach, from the declared list when its approval is
 * in force, the sites allowed one by one, and this chat's allow-once sites, with denied sites
 * always left out. Reading the records every time is what makes removing an approval in
 * Settings take effect on the next command. When nothing is granted, any earlier grant for the
 * chat is revoked and undefined comes back.
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
    const granted = grantedSkillNetworkHosts({
      declared: manifest?.network_hosts,
      approved: record.network_approval,
      allowed: record.network_allowed_hosts,
      denied: record.network_denied_hosts,
      session: input.registry.sessionHosts({ session_id: input.session_id, skill_name: record.name }),
    });
    for (const host of granted) {
      hosts.add(host);
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

/**
 * The network cards one chat is owed, read fresh from the skill records: one first-use card for
 * each mounted skill whose declared list is not in force, and one card for each site the
 * gateway refused for a mounted skill. Sites the person already turned down for that skill
 * raise no card, and sites already granted raise none either. First-use cards are handed out
 * once per chat until an answer lands; refused sites are drained as they are read, so each is
 * handed out once. A chat whose turn never runs a command never drains, so nothing is raised
 * for a skill the person is not using.
 */
export async function drainSkillNetworkCards(input: {
  store: ISkillStore;
  registry: SkillNetworkTokenRegistry;
  tenant_id: string;
  session_id: string;
  skillNames: readonly string[];
}): Promise<readonly SkillNetworkCardRequest[]> {
  if (input.skillNames.length === 0) {
    return [];
  }
  const records = await input.store.listSkills({
    tenant_id: input.tenant_id,
    names: input.skillNames,
  });
  const cards: SkillNetworkCardRequest[] = [];
  for (const record of records) {
    const manifest = parseGitSkill(record.manifest);
    const declared = manifest?.network_hosts ?? [];
    if (declared.length === 0) {
      continue;
    }
    const granted = new Set(
      grantedSkillNetworkHosts({
        declared,
        approved: record.network_approval,
        allowed: record.network_allowed_hosts,
        denied: record.network_denied_hosts,
        session: input.registry.sessionHosts({ session_id: input.session_id, skill_name: record.name }),
      }),
    );
    const denied = new Set(record.network_denied_hosts);
    const missing = declared.filter(host => !granted.has(host) && !denied.has(host));
    if (missing.length > 0 && !input.registry.cardRaised({ session_id: input.session_id, skill_name: record.name })) {
      input.registry.markCardRaised({ session_id: input.session_id, skill_name: record.name });
      cards.push({ skill_name: record.name, hosts: missing, reason: 'first_use' });
    }
  }
  const refused = input.registry.drainRefusals({ session_id: input.session_id });
  if (refused.length > 0) {
    // A refused site is charged to the first mounted skill, in the order the chat mounted them,
    // that declares sites and has neither granted nor denied it: the gateway sees only the union
    // of the chat's grants, so it cannot tell which mounted skill reached for the site. A refused
    // host that is not a site name at all (a bare address, say) raises no card: no answer could
    // ever allow it, so there is nothing to ask about.
    for (const host of refused) {
      if (!isSkillNetworkHostName(host)) {
        continue;
      }
      for (const record of records) {
        const manifest = parseGitSkill(record.manifest);
        const declared = manifest?.network_hosts ?? [];
        if (declared.length === 0 || record.network_denied_hosts.includes(host)) {
          continue;
        }
        const granted = grantedSkillNetworkHosts({
          declared,
          approved: record.network_approval,
          allowed: record.network_allowed_hosts,
          denied: record.network_denied_hosts,
          session: input.registry.sessionHosts({ session_id: input.session_id, skill_name: record.name }),
        });
        if (granted.includes(host)) {
          continue;
        }
        cards.push({ skill_name: record.name, hosts: [host], reason: 'undeclared_host' });
        break;
      }
    }
  }
  return cards;
}

/**
 * Records the person's answer to a network card. Allow adds the sites to this chat only;
 * always allow stores them on the skill (a first-use answer stores the sites the card asked
 * for, together with the declared sites already approved or allowed one by one, and never a
 * turned-down site); deny stores the sites as turned down for the skill, which also ends
 * their first-use card. Every answer clears the raised mark, so a later change can raise a
 * card again. A host that is not a site name is dropped before anything is stored: an answer
 * can never create a grant for a bare address, and nothing lands in the records that Settings
 * would then be unable to show or clear.
 */
export async function recordSkillNetworkAnswer(input: {
  store: ISkillStore;
  registry: SkillNetworkTokenRegistry;
  tenant_id: string;
  created_by: string;
  session_id: string;
  skill_name: string;
  hosts: readonly string[];
  reason: SkillNetworkCardReason;
  answer: 'allow_once' | 'always_allow' | 'deny';
}): Promise<void> {
  input.registry.clearCardRaised({ session_id: input.session_id, skill_name: input.skill_name });
  const hosts = input.hosts.filter(host => isSkillNetworkHostName(host));
  if (input.answer === 'allow_once') {
    if (hosts.length > 0) {
      input.registry.addSessionHosts({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        session_id: input.session_id,
        skill_name: input.skill_name,
        hosts,
      });
    }
    return;
  }
  if (input.answer === 'deny') {
    for (const host of hosts) {
      await input.store.setSkillNetworkHostDecision({
        tenant_id: input.tenant_id,
        name: input.skill_name,
        host,
        decision: 'denied',
      });
    }
    return;
  }
  if (input.reason === 'first_use') {
    const records = await input.store.listSkills({ tenant_id: input.tenant_id, names: [input.skill_name] });
    const record = records[0];
    const declared = record === undefined ? [] : (parseGitSkill(record.manifest)?.network_hosts ?? []);
    // The stored approval names only sites a card or an earlier decision named: the sites this
    // card asked for, plus the declared sites already approved or allowed one by one. A
    // turned-down site is never written in, so clearing its denial later cannot grant it
    // without a card; a site the declaration gained after the card was raised is not named
    // either, so it waits for its own card.
    const denied = new Set(record?.network_denied_hosts ?? []);
    const named = new Set<string>([...(record?.network_approval ?? []), ...(record?.network_allowed_hosts ?? [])]);
    const approved = new Set<string>();
    for (const host of hosts) {
      if (!denied.has(host)) {
        approved.add(host);
      }
    }
    for (const host of declared) {
      if (named.has(host) && !denied.has(host)) {
        approved.add(host);
      }
    }
    await input.store.setSkillNetworkApproval({
      tenant_id: input.tenant_id,
      name: input.skill_name,
      hosts: [...approved],
    });
    return;
  }
  for (const host of hosts) {
    await input.store.setSkillNetworkHostDecision({
      tenant_id: input.tenant_id,
      name: input.skill_name,
      host,
      decision: 'allowed',
    });
  }
}
