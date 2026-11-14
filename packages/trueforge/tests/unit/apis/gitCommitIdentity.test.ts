/**
 * Settings name on Git commits: GET reports what the person chose beside the defaults,
 * PUT stores a name and email, and PUT with both null clears the choice.
 */
import { createLogger } from 'winston';

import { createGitCommitIdentityRouter } from '../../../src/apis/gitCommitIdentity';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';

const silentLogger = createLogger({ silent: true });

const KEY = 'sandbox_git_commit_identity';

async function createRouter(input: { personName: string | null }) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const profileKeys: { tenant_id: string; created_by: string }[] = [];
  const router = createGitCommitIdentityRouter({
    globalSettingsStore,
    personalizationStore: {
      getProfile: async key => {
        profileKeys.push({ tenant_id: key.tenant_id, created_by: key.created_by });
        return input.personName === null
          ? undefined
          : {
              tenant_id: key.tenant_id,
              created_by: key.created_by,
              assistant_name: null,
              assistant_identity: null,
              voice_guidance: null,
              user_name: input.personName,
              address_as: null,
              user_profile: null,
              pinned_preferences: [],
              help_areas: [],
              learned_profile: null,
              learning_enabled: false,
              revision: 1,
              digest: 'unused',
              updated_by: key.created_by,
              created_at: '2026-11-13T00:00:00.000Z',
              updated_at: '2026-11-13T00:00:00.000Z',
            };
      },
    },
    resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    logger: silentLogger,
  });
  return { router, globalSettingsStore, profileKeys };
}

function putInit(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('gitCommitIdentity router', () => {
  it("GET shows the person's own name as the default when nothing was chosen", async () => {
    const { router, profileKeys } = await createRouter({ personName: 'Sam Rivera' });
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { name: null, email: null, default_name: 'Sam Rivera', default_email: 'aman@localhost' },
    });
    expect(profileKeys).toEqual([{ tenant_id: 'default', created_by: STANDALONE_REQUEST_CONTEXT.subject.id }]);
  });

  it('GET falls back to Aman when the person gave no name', async () => {
    const { router } = await createRouter({ personName: null });
    expect(await (await router.request('/')).json()).toEqual({
      data: { name: null, email: null, default_name: 'Aman', default_email: 'aman@localhost' },
    });
  });

  it('PUT stores a chosen name and email and GET reports them', async () => {
    const { router, globalSettingsStore } = await createRouter({ personName: 'Sam Rivera' });
    const put = await router.request('/', putInit({ name: ' Aman ', email: 'sam@example.com' }));
    expect(put.status).toBe(200);
    const expected = {
      data: { name: 'Aman', email: 'sam@example.com', default_name: 'Sam Rivera', default_email: 'aman@localhost' },
    };
    expect(await put.json()).toEqual(expected);
    expect((await globalSettingsStore.getSetting({ key: KEY }))?.value).toBe(
      JSON.stringify({ name: 'Aman', email: 'sam@example.com' }),
    );
    expect(await (await router.request('/')).json()).toEqual(expected);
  });

  it('PUT with both parts null clears the choice', async () => {
    const { router, globalSettingsStore } = await createRouter({ personName: 'Sam Rivera' });
    await router.request('/', putInit({ name: 'Aman', email: null }));
    const cleared = await router.request('/', putInit({ name: null, email: null }));
    expect(cleared.status).toBe(200);
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });

  it.each([
    ['a name with angle brackets', { name: 'Sam <x>', email: null }],
    ['a name with a line break', { name: 'Sam\nRivera', email: null }],
    ['an empty name', { name: '  ', email: null }],
    ['an email without an @', { name: null, email: 'sam.example.com' }],
    ['a missing email field', { name: 'Sam' }],
  ])('PUT with %s is rejected and stores nothing', async (_label, body) => {
    const { router, globalSettingsStore } = await createRouter({ personName: null });
    const response = await router.request('/', putInit(body));
    expect(response.status).toBe(400);
    expect(await globalSettingsStore.getSetting({ key: KEY })).toBeUndefined();
  });
});
