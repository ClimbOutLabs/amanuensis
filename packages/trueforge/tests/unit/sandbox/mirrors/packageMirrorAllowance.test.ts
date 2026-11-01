/**
 * The shared-database check behind every mirror grant: a grant holds only while its chat exists
 * and belongs to the person, and the allowance behind it is still on, read through whichever
 * server the change was made on. Answers are reused for a few seconds, and a failed read is off.
 */
import { DEFAULT_SENTINEL_USER_SETTINGS } from '../../../../src/db/sentinelSettingsStore';
import { createPackageMirrorAllowanceCheck } from '../../../../src/sandbox/mirrors/packageMirrorAllowance';
import type { PackageMirrorGrant } from '../../../../src/sandbox/mirrors/packageMirrorTokens';

function grant(overrides: Partial<PackageMirrorGrant> = {}): PackageMirrorGrant {
  return {
    token: 'a'.repeat(32),
    tenant_id: 't1',
    created_by: 'u1',
    session_id: 's1',
    repository_id: undefined,
    issued_at: '2026-11-01T00:00:00.000Z',
    expires_at_ms: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function check(state: {
  owner?: string | undefined;
  withoutProject?: boolean;
  repoAllowed?: boolean | undefined;
  failSettings?: boolean;
  clock?: { now: number };
}) {
  const reads = { settings: 0 };
  const allowanceHolds = createPackageMirrorAllowanceCheck({
    sessionStore: {
      getSession: async () =>
        state.owner === undefined
          ? undefined
          : {
              tenant_id: 't1',
              session_id: 's1',
              created_by_subject: { subject_id: state.owner, subject_type: 'user', subject_display_name: state.owner },
            },
    },
    repositoryStore: {
      getRepository: async () =>
        state.repoAllowed === undefined ? undefined : { package_downloads_allowed: state.repoAllowed },
    },
    sentinelSettingsStore: {
      get: async () => {
        reads.settings += 1;
        if (state.failSettings === true) {
          throw new Error('database unavailable');
        }
        return {
          ...DEFAULT_SENTINEL_USER_SETTINGS,
          package_downloads_without_project_allowed: state.withoutProject ?? false,
        };
      },
    },
    now: () => state.clock?.now ?? 0,
  });
  return { allowanceHolds, reads };
}

describe('createPackageMirrorAllowanceCheck', () => {
  it('holds while the chat is the person’s and their allowance for chats without a project is on', async () => {
    expect(await check({ owner: 'u1', withoutProject: true }).allowanceHolds(grant())).toBe('holds');
    expect(await check({ owner: 'u1', withoutProject: false }).allowanceHolds(grant())).toBe('off');
  });

  it('follows the repo’s own allowance for a repo grant', async () => {
    expect(await check({ owner: 'u1', repoAllowed: true }).allowanceHolds(grant({ repository_id: 'r1' }))).toBe(
      'holds',
    );
    expect(await check({ owner: 'u1', repoAllowed: false }).allowanceHolds(grant({ repository_id: 'r1' }))).toBe('off');
    expect(await check({ owner: 'u1', repoAllowed: undefined }).allowanceHolds(grant({ repository_id: 'r1' }))).toBe(
      'off',
    );
  });

  it('ends a grant whose chat was deleted or belongs to someone else', async () => {
    expect(await check({ owner: undefined, withoutProject: true }).allowanceHolds(grant())).toBe('chat_deleted');
    expect(await check({ owner: 'u2', withoutProject: true }).allowanceHolds(grant())).toBe('chat_deleted');
  });

  it('counts a failed read as unavailable, not off, and does not cache it', async () => {
    const state: { owner?: string | undefined; withoutProject?: boolean; failSettings?: boolean } = {
      owner: 'u1',
      withoutProject: true,
      failSettings: true,
    };
    const { allowanceHolds, reads } = check(state);
    expect(await allowanceHolds(grant())).toBe('unavailable');
    state.failSettings = false;
    expect(await allowanceHolds(grant())).toBe('holds');
    expect(reads.settings).toBe(2);
  });

  it('shares one read between checks that arrive while it is still running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let settingsReads = 0;
    const allowanceHolds = createPackageMirrorAllowanceCheck({
      sessionStore: {
        getSession: async () => ({
          tenant_id: 't1',
          session_id: 's1',
          created_by_subject: { subject_id: 'u1', subject_type: 'user', subject_display_name: 'u1' },
        }),
      },
      repositoryStore: { getRepository: async () => undefined },
      sentinelSettingsStore: {
        get: async () => {
          settingsReads += 1;
          await gate;
          return { ...DEFAULT_SENTINEL_USER_SETTINGS, package_downloads_without_project_allowed: true };
        },
      },
      now: () => 0,
    });
    const first = allowanceHolds(grant());
    const second = allowanceHolds(grant());
    release?.();
    expect(await first).toBe('holds');
    expect(await second).toBe('holds');
    expect(settingsReads).toBe(1);
  });

  it('reuses an answer for a few seconds, then reads again', async () => {
    const clock = { now: 0 };
    const state = { owner: 'u1', withoutProject: true, clock };
    const { allowanceHolds, reads } = check(state);
    expect(await allowanceHolds(grant())).toBe('holds');
    state.withoutProject = false;
    clock.now = 1_000;
    expect(await allowanceHolds(grant())).toBe('holds');
    expect(reads.settings).toBe(1);
    clock.now = 6_000;
    expect(await allowanceHolds(grant())).toBe('off');
    expect(reads.settings).toBe(2);
  });
});
