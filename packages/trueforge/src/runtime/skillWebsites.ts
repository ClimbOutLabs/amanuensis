import {
  readGitSkillFiles,
  scanSkillSites,
  type GitSkillSource,
  type SkillFile,
} from '@truefoundry/trueforge-core/core';
import { SkillNetworkHostsSchema, skillNetworkHostsCanSend } from '../schemas/skill';
import type { CatalogSkill } from '../schemas/skillCatalog';

/** Reads every file of a skill at one branch, tag or commit, and says which commit that was. */
export type ReadSkillFiles = (source: GitSkillSource) => Promise<{ objectId: string; files: SkillFile[] }>;

/** The real reader: the same host-side git fetch that copies a skill into the sandbox. */
export const readSkillFilesFromGit: ReadSkillFiles = source => readGitSkillFiles({ skill: source });

/** What the host found about the websites a skill sends requests to, at one exact commit. */
export interface SkillWebsites {
  commit: string;
  /** The websites found, sorted, each once. */
  hosts: string[];
  /** True when the skill builds web addresses while it runs, which cannot be read ahead of time. */
  makesUpAddresses: boolean;
  /** True when one of the websites can send email or change a calendar. */
  canSend: boolean;
}

export type SkillWebsitesResult =
  { ok: true; value: SkillWebsites } | { ok: false; problem: 'unreadable' | 'too_many' };

/**
 * Marketplace skills do not say which websites they use, so the host reads every file of the
 * skill and finds them itself. Nothing in the skill runs. Both the chat install and Settings use
 * this, so a skill gets the same list whichever way it is added.
 */
export async function findSkillWebsites(input: {
  readFiles: ReadSkillFiles;
  source: GitSkillSource;
}): Promise<SkillWebsitesResult> {
  let read: Awaited<ReturnType<ReadSkillFiles>>;
  try {
    read = await input.readFiles(input.source);
  } catch {
    return { ok: false, problem: 'unreadable' };
  }
  const scan = scanSkillSites(read.files);
  if (!SkillNetworkHostsSchema.safeParse(scan.hosts).success) {
    return { ok: false, problem: 'too_many' };
  }
  return {
    ok: true,
    value: {
      commit: read.objectId,
      hosts: scan.hosts,
      makesUpAddresses: scan.unknown.length > 0,
      canSend: skillNetworkHostsCanSend(scan.hosts),
    },
  };
}

/** The same list in one order, so two lists can be compared as the person saw them. */
export function sameWebsites(input: { found: readonly string[]; approved: readonly string[] }): boolean {
  const approved = [...new Set(input.approved)].sort();
  const found = [...new Set(input.found)].sort();
  return approved.length === found.length && approved.every((host, index) => host === found[index]);
}

/** One form for comparing two places a skill can come from: the repository in lower case and the folder without edge slashes. */
export function skillSourceKey(input: { url: string; path?: string | undefined }): string {
  const repository = input.url
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return `${repository}#${(input.path ?? '').replace(/^\/+|\/+$/g, '')}`;
}

/**
 * The websites of a skill, read from its files, or from the catalog for a starter skill at the
 * exact version the catalog pins: starters are taken as shipped and never read.
 */
export async function settleSkillWebsites(input: {
  readFiles: ReadSkillFiles;
  catalog: readonly CatalogSkill[];
  source: GitSkillSource;
}): Promise<SkillWebsitesResult> {
  const key = skillSourceKey(input.source);
  const starter = input.catalog.find(entry => skillSourceKey(entry) === key && entry.ref === input.source.ref);
  if (starter !== undefined) {
    const hosts = [...(starter.network_hosts ?? [])].sort();
    return {
      ok: true,
      value: { commit: starter.ref, hosts, makesUpAddresses: false, canSend: skillNetworkHostsCanSend(hosts) },
    };
  }
  return findSkillWebsites({ readFiles: input.readFiles, source: input.source });
}
