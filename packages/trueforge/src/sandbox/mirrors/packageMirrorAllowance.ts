import type { GetSessionInput } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import type { GetRepositoryInput } from '../../db/repositoryStore';
import type { ISentinelSettingsStore } from '../../db/sentinelSettingsStore';
import type { PackageMirrorGrant } from './packageMirrorTokens';

/** How long one answer is reused, so a burst of downloads makes one read, and a change elsewhere lands within it. */
const ALLOWANCE_RECHECK_MS = 5_000;

/**
 * Whether a grant's allowance still holds in the shared database: 'holds' while it does, 'off'
 * when the database says it ended, and 'unavailable' when the database could not be read at
 * all. 'unavailable' is not 'off': the grant stays in place and the person is told to try
 * again, because nothing they did turned downloads off.
 */
export type PackageMirrorAllowanceResult = 'holds' | 'off' | 'unavailable';

/** Whether a grant's allowance still holds in the shared database. */
export type PackageMirrorAllowanceCheck = (grant: PackageMirrorGrant) => Promise<PackageMirrorAllowanceResult>;

/**
 * Checks each mirror grant against the shared database, not only this process's memory: the chat
 * still exists and belongs to the person, and the allowance behind the grant (the repo's, or the
 * person's for chats without a project) is still on. A change made through any server, deleting the
 * chat or turning downloads off, ends the grant here within a few seconds. Concurrent checks for
 * one grant share a single read, and a failed read is reported as 'unavailable', never cached.
 */
export function createPackageMirrorAllowanceCheck(deps: {
  sessionStore: {
    getSession(input: GetSessionInput): Promise<{ created_by_subject: { subject_id: string } } | undefined>;
  };
  repositoryStore: {
    getRepository(input: GetRepositoryInput): Promise<{ package_downloads_allowed: boolean } | undefined>;
  };
  sentinelSettingsStore: Pick<ISentinelSettingsStore, 'get'>;
  now?: () => number;
}): PackageMirrorAllowanceCheck {
  const now = deps.now ?? Date.now;
  const answers = new Map<string, { result: Exclude<PackageMirrorAllowanceResult, 'unavailable'>; until: number }>();
  const inflight = new Map<string, Promise<PackageMirrorAllowanceResult>>();

  const read = async (grant: PackageMirrorGrant): Promise<Exclude<PackageMirrorAllowanceResult, 'unavailable'>> => {
    const session = await deps.sessionStore.getSession({ tenant_id: grant.tenant_id, session_id: grant.session_id });
    if (session?.created_by_subject.subject_id !== grant.created_by) {
      return 'off';
    }
    if (grant.repository_id === undefined) {
      const settings = await deps.sentinelSettingsStore.get({
        tenant_id: grant.tenant_id,
        created_by: grant.created_by,
      });
      return settings.package_downloads_without_project_allowed ? 'holds' : 'off';
    }
    const repository = await deps.repositoryStore.getRepository({
      tenant_id: grant.tenant_id,
      created_by: grant.created_by,
      repository_id: grant.repository_id,
    });
    return repository?.package_downloads_allowed === true ? 'holds' : 'off';
  };

  return async grant => {
    const cached = answers.get(grant.token);
    if (cached !== undefined && cached.until > now()) {
      return cached.result;
    }
    const pending = inflight.get(grant.token);
    if (pending !== undefined) {
      return pending;
    }
    const lookup: Promise<PackageMirrorAllowanceResult> = read(grant)
      .then(result => {
        for (const [token, answer] of answers) {
          if (answer.until <= now()) {
            answers.delete(token);
          }
        }
        answers.set(grant.token, { result, until: now() + ALLOWANCE_RECHECK_MS });
        return result;
      })
      .catch((): PackageMirrorAllowanceResult => 'unavailable')
      .finally(() => {
        inflight.delete(grant.token);
      });
    inflight.set(grant.token, lookup);
    return lookup;
  };
}
