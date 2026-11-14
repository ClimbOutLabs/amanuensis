import { resolveGitSkillObjectId } from '@truefoundry/trueforge-core/core';
import type { ISkillStore, SkillRecord } from '../../db/skillStore';
import {
  grantedSkillNetworkHosts,
  isSkillNetworkHostName,
  parseGitSkill,
  parseTrueFoundryRegistrySkill,
  type SkillManifest,
} from '../../schemas/skill';
import type { SkillNetworkTokenRegistry } from './skillNetworkTokens';

/**
 * Why a network card is being asked: the skill's first use, a site it reached for without
 * declaring, or its code changed since the person approved it.
 */
export type SkillNetworkCardReason = 'first_use' | 'undeclared_host' | 'code_changed';

/** One card the runtime should raise: the skill, the sites it asks for, and why it is asked. */
export interface SkillNetworkCardRequest {
  skill_name: string;
  hosts: readonly string[];
  reason: SkillNetworkCardReason;
  /** The code version the asked approval would cover, or null when no pin is in force. */
  code_pin: string | null;
}

/** Reads the commit a git skill's ref names today; the seam tests use to move a branch. */
export type SkillCodeResolver = (input: { url: string; ref: string }) => Promise<string>;

/** The one resolver: the host-side git resolution the sandbox skill copy already runs. */
const defaultSkillCodeResolver: SkillCodeResolver = input =>
  resolveGitSkillObjectId({ skill: { url: input.url, ref: input.ref }, deps: {} });

/** What a person is told when a skill's code version cannot be read at approval time. */
export const SKILL_CODE_PIN_REFUSAL =
  "Aman could not read this skill's code version. Check the skill's address and try again.";

/** An approval was refused because the skill's code version could not be read. */
export class SkillCodePinRefusedError extends Error {
  constructor(options?: ErrorOptions) {
    super(SKILL_CODE_PIN_REFUSAL, options);
    this.name = 'SkillCodePinRefusedError';
  }
}

/**
 * The pin an approval of this skill stores: for a git skill, the commit its ref names right
 * now, read with the sandbox copy's own resolver; for a registry skill, its version name,
 * which already names one exact version. A git ref that cannot be resolved refuses the
 * approval, so no approval ever covers code nobody could identify.
 */
export async function resolveSkillCodePin(input: {
  manifest: SkillManifest;
  resolve?: SkillCodeResolver | undefined;
}): Promise<string | null> {
  const git = parseGitSkill(input.manifest);
  if (git === undefined) {
    return parseTrueFoundryRegistrySkill(input.manifest)?.name ?? null;
  }
  try {
    return await (input.resolve ?? defaultSkillCodeResolver)({ url: git.url, ref: git.ref });
  } catch (error) {
    throw new SkillCodePinRefusedError({ cause: error });
  }
}

/**
 * Resolutions are cached per chat for a few minutes: the grant is read on every command, and
 * a branch ref must not cost a network round-trip each time. A branch that moves is seen at
 * most this much later.
 */
const CODE_RESOLUTION_TTL_MS = 3 * 60 * 1000;
const codeResolutionCache = new Map<string, { skill_name: string; code_sha: string; expires_at_ms: number }>();

/**
 * Drops every chat's cached code version for one skill. Called wherever a pin is stored:
 * the pin is read fresh, so a stale cached version would make the next check see the
 * fresh approval as moved code and cancel it.
 */
export function forgetCachedSkillCode(input: { skill_name: string }): void {
  for (const [key, entry] of codeResolutionCache) {
    if (entry.skill_name === input.skill_name) {
      codeResolutionCache.delete(key);
    }
  }
}

async function resolveCodeShaCached(input: {
  session_id: string;
  skill_name: string;
  url: string;
  ref: string;
  resolve: SkillCodeResolver;
}): Promise<string> {
  const key = JSON.stringify([input.session_id, input.skill_name, input.url, input.ref]);
  const hit = codeResolutionCache.get(key);
  if (hit !== undefined && hit.expires_at_ms > Date.now()) {
    return hit.code_sha;
  }
  const code_sha = await input.resolve({ url: input.url, ref: input.ref });
  codeResolutionCache.set(key, {
    skill_name: input.skill_name,
    code_sha,
    expires_at_ms: Date.now() + CODE_RESOLUTION_TTL_MS,
  });
  return code_sha;
}

/**
 * This chat's allow-once sites for one skill that still count: the ones allowed under the
 * code version the skill is at now. Sites allowed for code that has since changed are left
 * out, so an allow-once never outlives the code it was given for.
 */
function sessionHostsAtPin(input: {
  registry: SkillNetworkTokenRegistry;
  session_id: string;
  skill_name: string;
  code_sha: string | null;
}): readonly string[] {
  return (
    input.registry.sessionHostsWithPin({
      session_id: input.session_id,
      skill_name: input.skill_name,
      code_sha: input.code_sha,
    })?.hosts ?? []
  );
}

/**
 * Cancels every persisted grant a skill holds because its code moved off the pin: the
 * approval goes, the per-site allowances given under the old code go with it, this chat's
 * allow-once sites are dropped, and a note is left so the runtime raises the code-changed
 * card naming the version the code moved to and the sites that were cleared. Turned-down
 * sites are the person's latest word on them and stay.
 */
async function cancelGrantsForMovedCode(input: {
  store: ISkillStore;
  registry: SkillNetworkTokenRegistry;
  tenant_id: string;
  session_id: string;
  record: SkillRecord;
  code_sha: string;
}): Promise<void> {
  await input.store.setSkillNetworkApproval({
    tenant_id: input.tenant_id,
    name: input.record.name,
    hosts: null,
    code_sha: null,
  });
  for (const host of input.record.network_allowed_hosts) {
    await input.store.setSkillNetworkHostDecision({
      tenant_id: input.tenant_id,
      name: input.record.name,
      host,
      decision: 'none',
    });
  }
  input.registry.clearSessionHosts({ session_id: input.session_id, skill_name: input.record.name });
  input.registry.noteCodeChanged({
    session_id: input.session_id,
    skill_name: input.record.name,
    code_sha: input.code_sha,
    hosts: input.record.network_allowed_hosts,
  });
}

/**
 * The skill network grant for one chat, read fresh from the skill records on every call: the
 * union of the sites each mounted skill may reach, from the declared list when its approval is
 * in force, the sites allowed one by one, and this chat's allow-once sites, with denied sites
 * always left out. Reading the records every time is what makes removing an approval in
 * Settings take effect on the next command. When nothing is granted, any earlier grant for the
 * chat is revoked and undefined comes back.
 *
 * Every persisted grant a skill holds, the approval and the per-site allowances alike, is
 * bound to the stored code pin, and the grant is checked against the code as it stands now
 * (for a git skill, the commit its ref names, cached per chat; for a registry skill, the
 * version name on its record): when the code has moved, the skill grants nothing, its
 * approval and allowances are cleared, and a note is left so the runtime raises the
 * code-changed card. Grants saved before pinning carry no pin and stay in force unpinned
 * until they are saved again. When a git skill's code cannot be read at all, a pinned
 * skill grants nothing this time and its grants are left standing, so a brief outage
 * cancels nothing.
 */
export async function resolveSkillNetworkGrant(input: {
  store: ISkillStore;
  registry: SkillNetworkTokenRegistry;
  tenant_id: string;
  created_by: string;
  session_id: string;
  skillNames: readonly string[];
  resolveCodeSha?: SkillCodeResolver | undefined;
}): Promise<{ token: string; hosts: readonly string[] } | undefined> {
  if (input.skillNames.length === 0) {
    return undefined;
  }
  const records = await input.store.listSkills({
    tenant_id: input.tenant_id,
    names: input.skillNames,
  });
  const resolve = input.resolveCodeSha ?? defaultSkillCodeResolver;
  const hosts = new Set<string>();
  for (const record of records) {
    const git = parseGitSkill(record.manifest);
    const registrySkill = git === undefined ? parseTrueFoundryRegistrySkill(record.manifest) : undefined;
    // The code version the skill is treated as being at for this read: the pin in force, or
    // the version its code is at now when a check ran.
    let codeShaNow: string | null = record.network_approval_code_sha;
    const pin = record.network_approval_code_sha;
    const hasPersistedGrant = record.network_approval !== null || record.network_allowed_hosts.length > 0;
    if (registrySkill !== undefined && pin !== null && hasPersistedGrant) {
      // A registry skill's version is read from its own record, so this check is exact and
      // costs no lookup: an upsert that changed the version moved the record off the pin.
      codeShaNow = registrySkill.name;
      if (registrySkill.name !== pin) {
        await cancelGrantsForMovedCode({
          store: input.store,
          registry: input.registry,
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          record,
          code_sha: registrySkill.name,
        });
        continue;
      }
    }
    if (git !== undefined) {
      const sessionEntries = input.registry.sessionHostEntries({
        session_id: input.session_id,
        skill_name: record.name,
      });
      const sessionPinned = sessionEntries.some(entry => entry.code_sha !== null);
      // The check runs when a pin binds anything: the stored pin over the persisted
      // grants, or the stamp on this chat's allow-once sites.
      if (pin !== null || sessionPinned) {
        const resolved = await resolveCodeShaCached({
          session_id: input.session_id,
          skill_name: record.name,
          url: git.url,
          ref: git.ref,
          resolve,
        }).catch(() => null);
        if (resolved === null) {
          // The code could not be read: a skill under a pin grants nothing this time, and
          // nothing is cancelled, so a brief outage costs one command, not the grants.
          if (pin !== null) {
            continue;
          }
        } else {
          codeShaNow = resolved;
          if (pin !== null && hasPersistedGrant && resolved !== pin) {
            // The code moved off the pin: every grant given under the old code is
            // cancelled, and the card asks again.
            await cancelGrantsForMovedCode({
              store: input.store,
              registry: input.registry,
              tenant_id: input.tenant_id,
              session_id: input.session_id,
              record,
              code_sha: resolved,
            });
            continue;
          }
        }
      }
    }
    const granted = grantedSkillNetworkHosts({
      declared: git?.network_hosts,
      approved: record.network_approval,
      allowed: record.network_allowed_hosts,
      denied: record.network_denied_hosts,
      session: sessionHostsAtPin({
        registry: input.registry,
        session_id: input.session_id,
        skill_name: record.name,
        code_sha: codeShaNow,
      }),
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
 * gateway refused for a mounted skill. When the grant check found the skill's code had moved
 * off its pin, the first-use card is the code-changed card instead, carrying the version the
 * code moved to and naming the per-site allowances the move cleared alongside the declared
 * sites still missing, so one answer can restore either kind of grant; a skill with no
 * declared list still owes that card when the move cleared allowances it held. Sites the
 * person already turned down for that skill raise no card, and sites already granted raise
 * none either. First-use cards are handed out once per chat until an answer lands; refused
 * sites are drained as they are read, so each is handed out once. A chat whose turn never
 * runs a command never drains, so nothing is raised for a skill the person is not using.
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
    const granted = new Set(
      grantedSkillNetworkHosts({
        declared,
        approved: record.network_approval,
        allowed: record.network_allowed_hosts,
        denied: record.network_denied_hosts,
        session: sessionHostsAtPin({
          registry: input.registry,
          session_id: input.session_id,
          skill_name: record.name,
          code_sha: record.network_approval_code_sha,
        }),
      }),
    );
    const denied = new Set(record.network_denied_hosts);
    const missing = declared.filter(host => !granted.has(host) && !denied.has(host));
    const changedNote = input.registry.codeChangedNote({
      session_id: input.session_id,
      skill_name: record.name,
    });
    if (changedNote !== undefined) {
      const hosts = [...new Set([...missing, ...changedNote.hosts])].filter(
        host => !granted.has(host) && !denied.has(host),
      );
      if (hosts.length === 0) {
        // Nothing is owed; a code-changed note left over from before a fresh approval is done.
        input.registry.clearCodeChanged({ session_id: input.session_id, skill_name: record.name });
        continue;
      }
      if (!input.registry.cardRaised({ session_id: input.session_id, skill_name: record.name })) {
        input.registry.markCardRaised({ session_id: input.session_id, skill_name: record.name });
        cards.push({ skill_name: record.name, hosts, reason: 'code_changed', code_pin: changedNote.code_sha });
      }
      continue;
    }
    if (declared.length === 0) {
      continue;
    }
    if (missing.length === 0) {
      continue;
    }
    if (!input.registry.cardRaised({ session_id: input.session_id, skill_name: record.name })) {
      input.registry.markCardRaised({ session_id: input.session_id, skill_name: record.name });
      cards.push({ skill_name: record.name, hosts: missing, reason: 'first_use', code_pin: null });
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
          session: sessionHostsAtPin({
            registry: input.registry,
            session_id: input.session_id,
            skill_name: record.name,
            code_sha: record.network_approval_code_sha,
          }),
        });
        if (granted.includes(host)) {
          continue;
        }
        cards.push({ skill_name: record.name, hosts: [host], reason: 'undeclared_host', code_pin: null });
        break;
      }
    }
  }
  return cards;
}

/**
 * Records the person's answer to a network card. Allow adds the sites to this chat only,
 * under the code version the skill is at now; always allow stores them on the skill, pinned to
 * the code as it stands (a first-use or code-changed answer stores the sites the card asked
 * for, together with the declared sites already approved or allowed one by one, and never a
 * turned-down site, like approving the list in Settings). An answer that allows a site the
 * skill never declared stores it one by one, and stores the pin with it when the skill has
 * none yet, so allowances are bound to the code the same way approvals are. Deny stores the
 * sites as turned down for the skill, which also ends their first-use card. Every answer
 * clears the raised mark, so a later change can raise a card again. Storing an answer is
 * refused, recording nothing, when the skill's code version cannot be read. A host that is not
 * a site name is dropped before anything is stored: an answer can never create a grant for a
 * bare address, and nothing lands in the records that Settings would then be unable to show
 * or clear.
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
  resolveCodeSha?: SkillCodeResolver | undefined;
}): Promise<void> {
  const hosts = input.hosts.filter(host => isSkillNetworkHostName(host));
  if (input.answer === 'always_allow' && input.reason !== 'undeclared_host') {
    // Approving pins the approval to the code as it stands now, so the pin is read before
    // anything is recorded: a code version that cannot be read refuses the whole answer.
    const records = await input.store.listSkills({ tenant_id: input.tenant_id, names: [input.skill_name] });
    const record = records[0];
    if (record !== undefined) {
      const resolvedPin = await resolveSkillCodePin({ manifest: record.manifest, resolve: input.resolveCodeSha });
      if (resolvedPin === null) {
        // A stored manifest is a git skill or a registry skill, and both name a code
        // version; a manifest that names none cannot be pinned, so the answer is refused.
        throw new SkillCodePinRefusedError();
      }
      const code_sha: string = resolvedPin;
      const declared = parseGitSkill(record.manifest)?.network_hosts ?? [];
      const declaredSet = new Set(declared);
      // The stored approval names only sites a card or an earlier decision named: the sites this
      // card asked for, plus the declared sites already approved or allowed one by one. A
      // turned-down site is never written in, so clearing its denial later cannot grant it
      // without a card; a site the declaration gained after the card was raised is not named
      // either, so it waits for its own card. A code-changed card also names the per-site
      // allowances the code change cleared, which the skill never declared: those are stored
      // one by one again, not folded into the approval, so each kind of grant comes back as
      // the kind it was.
      const denied = new Set(record.network_denied_hosts);
      const named = new Set<string>([...(record.network_approval ?? []), ...record.network_allowed_hosts]);
      const approved = new Set<string>();
      const restored: string[] = [];
      for (const host of hosts) {
        if (denied.has(host)) {
          continue;
        }
        if (input.reason === 'code_changed' && !declaredSet.has(host)) {
          restored.push(host);
          continue;
        }
        approved.add(host);
      }
      for (const host of declared) {
        if (named.has(host) && !denied.has(host)) {
          approved.add(host);
        }
      }
      if (input.reason !== 'code_changed' || approved.size > 0) {
        await input.store.setSkillNetworkApproval({
          tenant_id: input.tenant_id,
          name: input.skill_name,
          hosts: [...approved],
          code_sha,
        });
      }
      for (const host of restored) {
        await input.store.setSkillNetworkHostDecision({
          tenant_id: input.tenant_id,
          name: input.skill_name,
          host,
          decision: 'allowed',
        });
      }
      if (approved.size === 0 && restored.length > 0) {
        // The answer restored only allowances, so no approval write stored the pin: store
        // it now, or the allowances would sit outside the pin again.
        await input.store.setSkillNetworkCodePin({
          tenant_id: input.tenant_id,
          name: input.skill_name,
          code_sha,
        });
      }
      forgetCachedSkillCode({ skill_name: input.skill_name });
      input.registry.clearCardRaised({ session_id: input.session_id, skill_name: input.skill_name });
      input.registry.clearCodeChanged({ session_id: input.session_id, skill_name: input.skill_name });
      return;
    }
  }
  if (input.answer === 'always_allow') {
    // Only the undeclared-host answer reaches here; the first-use and code-changed answers
    // returned above. Allowing a site the skill never declared binds the allowance to the
    // skill's code as it stands: when the skill holds no approval and no pin yet, the pin
    // is read before anything is recorded and stored with the allowances, and a code
    // version that cannot be read refuses the whole answer, like approving. A skill that
    // already holds an approval or a pin keeps the binding it has.
    const records = await input.store.listSkills({ tenant_id: input.tenant_id, names: [input.skill_name] });
    const record = records[0];
    let code_sha: string | null = null;
    if (record?.network_approval === null && record.network_approval_code_sha === null) {
      code_sha = await resolveSkillCodePin({ manifest: record.manifest, resolve: input.resolveCodeSha });
      if (code_sha === null) {
        // A manifest that names no code version cannot be pinned; refuse like an
        // unreadable one rather than store an unbound allowance.
        throw new SkillCodePinRefusedError();
      }
    }
    input.registry.clearCardRaised({ session_id: input.session_id, skill_name: input.skill_name });
    input.registry.clearCodeChanged({ session_id: input.session_id, skill_name: input.skill_name });
    for (const host of hosts) {
      await input.store.setSkillNetworkHostDecision({
        tenant_id: input.tenant_id,
        name: input.skill_name,
        host,
        decision: 'allowed',
      });
    }
    if (code_sha !== null) {
      await input.store.setSkillNetworkCodePin({
        tenant_id: input.tenant_id,
        name: input.skill_name,
        code_sha,
      });
      forgetCachedSkillCode({ skill_name: input.skill_name });
    }
    return;
  }
  input.registry.clearCardRaised({ session_id: input.session_id, skill_name: input.skill_name });
  input.registry.clearCodeChanged({ session_id: input.session_id, skill_name: input.skill_name });
  if (input.answer === 'allow_once') {
    // The sites join this chat under the code the skill is at now: its stored pin when one
    // is in force, else the commit its ref names now. When neither can be read, the pin in
    // force (possibly none) is what they carry.
    const records = await input.store.listSkills({ tenant_id: input.tenant_id, names: [input.skill_name] });
    const record = records[0];
    let code_sha: string | null = record?.network_approval_code_sha ?? null;
    if (record !== undefined && code_sha === null && parseGitSkill(record.manifest) !== undefined) {
      try {
        code_sha = await resolveSkillCodePin({ manifest: record.manifest, resolve: input.resolveCodeSha });
      } catch {
        code_sha = null;
      }
    }
    if (hosts.length > 0) {
      input.registry.addSessionHosts({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        session_id: input.session_id,
        skill_name: input.skill_name,
        hosts,
        code_sha,
      });
      forgetCachedSkillCode({ skill_name: input.skill_name });
    }
    return;
  }
  // The only answer left is deny.
  for (const host of hosts) {
    await input.store.setSkillNetworkHostDecision({
      tenant_id: input.tenant_id,
      name: input.skill_name,
      host,
      decision: 'denied',
    });
  }
}
