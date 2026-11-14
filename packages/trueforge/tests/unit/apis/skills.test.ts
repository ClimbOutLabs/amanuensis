import { createCatalogRouter } from '../../../src/apis/catalog';
import { createAvailableSkillsRouter, createSkillsRouter } from '../../../src/apis/skills';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../../src/catalog/SkillCatalog';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import type { ReadSkillFiles } from '../../../src/runtime/skillWebsites';
import { ListSkillsResponseSchema } from '../../../src/schemas/skill';
import { TRUEFOUNDRY_MANAGED_MESSAGE, trueFoundryManaged } from '../../../src/truefoundry/errors';

const putBody = {
  type: 'git' as const,
  name: 'algorithmic-art',
  url: 'https://github.com/anthropics/skills',
  path: 'skills/algorithmic-art',
  ref: 'main',
  description: 'Creating algorithmic art using p5.js with seeded randomness.',
};

const encode = (text: string) => new TextEncoder().encode(text);
const FIXTURE_COMMIT = 'f'.repeat(40);

/** Skill files by repository, as the host would read them; a repository missing here cannot be read. */
const fixtureFiles = new Map<string, { path: string; text: string }[]>([
  ['https://github.com/anthropics/skills', [{ path: 'SKILL.md', text: '---\nname: art\n---\nDraw.\n' }]],
  [
    'https://github.com/acme/news-skill',
    [
      { path: 'SKILL.md', text: '---\nname: news\n---\nRun scripts/fetch.py.\n' },
      { path: 'scripts/fetch.py', text: 'requests.get("https://api.news-digest.info/latest")\n' },
    ],
  ],
]);

const readFixture: ReadSkillFiles = source => {
  const files = fixtureFiles.get(source.url);
  if (files === undefined) {
    return Promise.reject(new Error('not found'));
  }
  return Promise.resolve({
    objectId: FIXTURE_COMMIT,
    files: files.map(file => ({ path: file.path, bytes: encode(file.text) })),
  });
};

function wrapManifest(manifest: unknown) {
  return { manifest };
}

function configured(manifest: { name: string }) {
  return { name: manifest.name, manifest };
}

function putInit(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('skills routers', () => {
  let settingsRouter: ReturnType<typeof createSkillsRouter>;
  let catalogRouter: ReturnType<typeof createCatalogRouter>;
  let availableRouter: ReturnType<typeof createAvailableSkillsRouter>;
  let skillStore: SqliteSkillStore;
  let db: ReturnType<typeof createSqliteDb>;

  beforeAll(async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    skillStore = new SqliteSkillStore(db);
    settingsRouter = createSkillsRouter({
      resolveSkillStore: () => skillStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      catalog: [],
      readFiles: readFixture,
    });
    catalogRouter = createCatalogRouter({
      modelCatalog: ModelCatalog.load(),
      mcpCatalog: McpCatalog.loadShipped(),
      skillCatalog: SkillCatalog.load(),
      sandboxCatalog: SandboxCatalog.load(),
    });
    availableRouter = createAvailableSkillsRouter({
      resolveSkillStore: () => skillStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    });
  });

  it('GET /catalogs/skills returns the shipped catalog verbatim', async () => {
    const response = await catalogRouter.request('/skills');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { name: string }[] };
    expect(body.data.map(skill => skill.name)).toEqual(
      SkillCatalog.load()
        .list()
        .map(skill => skill.name),
    );
  });

  it('PUT upserts a skill and echoes the stored manifest', async () => {
    const response = await settingsRouter.request('/', putInit(wrapManifest(putBody)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: configured(putBody) });

    const list = await settingsRouter.request('/');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [configured(putBody)] });
  });

  it('POST creates a skill and returns 409 on name clash', async () => {
    const createBody = {
      ...putBody,
      name: 'create-only-skill',
      path: 'skills/create-only-skill',
    };
    const created = await settingsRouter.request('/', postInit(wrapManifest(createBody)));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ data: configured(createBody) });

    const clash = await settingsRouter.request('/', postInit(wrapManifest(createBody)));
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({
      error: { message: 'Skill name already exists: create-only-skill' },
    });
  });

  it('GET / on the chat router returns name and description for git skills', async () => {
    const response = await availableRouter.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        { name: putBody.name, description: putBody.description },
        { name: 'create-only-skill', description: putBody.description },
      ],
    });
  });

  it('GET / maps registry rows with TrueFoundry metadata', async () => {
    const fqn = 'agent-skill:acme/team-a/echo:3';
    const now = '2026-01-01T00:00:00.000Z';
    const skillStore = {
      listSkills: jest.fn().mockResolvedValue([
        {
          tenant_id: 'default',
          name: fqn,
          manifest: {
            type: 'truefoundry' as const,
            name: fqn,
            display_name: 'echo',
            description: 'Echo skill',
            repository_name: 'team-a',
            version: 3,
          },
          network_approval: null,
          created_at: now,
          updated_at: now,
        },
      ]),
      createSkill: jest.fn(),
      upsertSkill: jest.fn(),
      listSkillVersions: jest.fn(),
      validateAgentSkills: jest.fn(),
      deleteSkill: jest.fn(),
      resolveTurnSkills: jest.fn(),
      setSkillNetworkApproval: jest.fn(),
      setSkillNetworkHostDecision: jest.fn(),
    };
    const router = createAvailableSkillsRouter({
      resolveSkillStore: () => skillStore,
      withTransaction: async callback => callback(undefined as never),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    });
    const response = await router.request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          name: fqn,
          description: 'Echo skill',
          metadata: {
            display_name: 'echo',
            repository_name: 'team-a',
            version: '3',
          },
        },
      ],
    });
  });

  it('settings create/put forward registry bodies to the store (no early git-only 400)', async () => {
    const registryManifest = {
      type: 'truefoundry' as const,
      name: 'agent-skill:acme/team-a/echo:3',
      display_name: 'echo',
      description: 'Echo skill',
      repository_name: 'team-a',
      version: 3,
    };
    const now = '2026-01-01T00:00:00.000Z';
    const record = {
      tenant_id: 'default',
      name: 'agent-skill:acme/team-a/echo:3' as const,
      manifest: registryManifest,
      network_approval: null,
      created_at: now,
      updated_at: now,
    };
    const managedStore = {
      listSkills: jest.fn(),
      createSkill: jest.fn().mockResolvedValue(record),
      upsertSkill: jest.fn().mockResolvedValue(record),
      listSkillVersions: jest.fn(),
      validateAgentSkills: jest.fn(),
      deleteSkill: jest.fn(),
      resolveTurnSkills: jest.fn(),
      setSkillNetworkApproval: jest.fn(),
      setSkillNetworkHostDecision: jest.fn(),
    };
    const router = createSkillsRouter({
      resolveSkillStore: () => managedStore,
      withTransaction: async callback => callback(undefined as never),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      catalog: [],
      readFiles: readFixture,
    });
    const created = await router.request('/', postInit(wrapManifest(registryManifest)));
    expect(created.status).toBe(201);
    expect(managedStore.createSkill).toHaveBeenCalledWith({
      tenant_id: 'default',
      name: 'agent-skill:acme/team-a/echo:3',
      manifest: registryManifest,
    });

    const put = await router.request('/', putInit(wrapManifest(registryManifest)));
    expect(put.status).toBe(200);
    expect(managedStore.upsertSkill).toHaveBeenCalledWith({
      tenant_id: 'default',
      name: 'agent-skill:acme/team-a/echo:3',
      manifest: registryManifest,
    });
  });

  it('settings create/put return 424 when the skill store is TrueFoundry-managed', async () => {
    const registryManifest = {
      type: 'truefoundry' as const,
      name: 'agent-skill:acme/team-a/echo:3',
      display_name: 'echo',
      description: 'Echo skill',
      repository_name: 'team-a',
      version: 3,
    };
    const managedStore = {
      listSkills: jest.fn(),
      createSkill: jest.fn(() => trueFoundryManaged()),
      upsertSkill: jest.fn(() => trueFoundryManaged()),
      listSkillVersions: jest.fn(),
      validateAgentSkills: jest.fn(),
      deleteSkill: jest.fn(),
      resolveTurnSkills: jest.fn(),
      setSkillNetworkApproval: jest.fn(),
      setSkillNetworkHostDecision: jest.fn(),
    };
    const router = createSkillsRouter({
      resolveSkillStore: () => managedStore,
      withTransaction: async callback => callback(undefined as never),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      catalog: [],
      readFiles: readFixture,
    });

    const created = await router.request('/', postInit(wrapManifest(registryManifest)));
    expect(created.status).toBe(424);
    expect(await created.text()).toBe(TRUEFOUNDRY_MANAGED_MESSAGE);

    const put = await router.request('/', putInit(wrapManifest(registryManifest)));
    expect(put.status).toBe(424);
    expect(await put.text()).toBe(TRUEFOUNDRY_MANAGED_MESSAGE);
  });

  it('PUT rejects invalid bodies at the Zod layer', async () => {
    const { url: _, ...withoutUrl } = putBody;
    const missingUrl = await settingsRouter.request('/', putInit(wrapManifest(withoutUrl)));
    expect(missingUrl.status).toBe(400);

    const badName = await settingsRouter.request('/', putInit(wrapManifest({ ...putBody, name: 'Not A Name' })));
    expect(badName.status).toBe(400);

    const badUrl = await settingsRouter.request(
      '/',
      putInit(wrapManifest({ ...putBody, name: 'bad-url', url: 'https://example.com/repo' })),
    );
    expect(badUrl.status).toBe(400);
  });

  it('DELETE removes a configured skill and it disappears from list', async () => {
    const deleteBody = {
      ...putBody,
      name: 'deletable-skill',
      path: 'skills/deletable-skill',
    };
    const created = await settingsRouter.request('/', putInit(wrapManifest(deleteBody)));
    expect(created.status).toBe(200);

    const deleted = await settingsRouter.request('/deletable-skill', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});

    const list = await settingsRouter.request('/');
    const body = ListSkillsResponseSchema.parse(await list.json());
    expect(body.data.map(skill => skill.name)).not.toContain('deletable-skill');
  });

  it('DELETE returns 404 for an unknown skill name', async () => {
    const response = await settingsRouter.request('/does-not-exist', { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: 'No skill with this name: does-not-exist' },
    });
  });

  describe('adding a skill from Settings checks its websites first', () => {
    const news = {
      type: 'git' as const,
      name: 'news',
      url: 'https://github.com/acme/news-skill',
      ref: 'main',
      description: 'Reads the news.',
    };

    it('lists the websites the skill sends requests to, and saves nothing', async () => {
      const response = await settingsRouter.request('/check-websites', postInit({ url: news.url, ref: news.ref }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: {
          commit: FIXTURE_COMMIT,
          websites: ['api.news-digest.info'],
          makes_up_addresses: false,
          can_send: false,
        },
      });
      expect(await skillStore.listSkills({ tenant_id: 'default', names: ['news'] })).toEqual([]);
    });

    it('says plainly when the files cannot be read', async () => {
      const response = await settingsRouter.request(
        '/check-websites',
        postInit({ url: 'https://github.com/acme/missing', ref: 'main' }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: { message: expect.stringContaining('Check the address, folder and branch, then try again.') },
      });
    });

    it('adds nothing unless the websites found are approved with it', async () => {
      const without = await settingsRouter.request('/', postInit(wrapManifest(news)));
      expect(without.status).toBe(409);
      const wrong = await settingsRouter.request(
        '/',
        postInit({ manifest: news, approved_websites: ['api.news-digest.info', 'extra.example.org'] }),
      );
      expect(wrong.status).toBe(409);
      const viaPut = await settingsRouter.request('/', putInit(wrapManifest(news)));
      expect(viaPut.status).toBe(409);
      expect(await skillStore.listSkills({ tenant_id: 'default', names: ['news'] })).toEqual([]);
    });

    it('stores the websites it found, never a list sent with the skill, and approves them with it', async () => {
      const created = await settingsRouter.request(
        '/',
        postInit({
          manifest: { ...news, network_hosts: ['anything.example.org'] },
          approved_websites: ['api.news-digest.info'],
        }),
      );
      expect(created.status).toBe(201);
      const [record] = await skillStore.listSkills({ tenant_id: 'default', names: ['news'] });
      expect(record?.manifest).toMatchObject({ network_hosts: ['api.news-digest.info'] });
      expect(record?.network_approval).toEqual(['api.news-digest.info']);
      await settingsRouter.request('/news', { method: 'DELETE' });
    });

    it('adds a starter skill at its pinned version as shipped, without reading it', async () => {
      const starterRouter = createSkillsRouter({
        resolveSkillStore: () => skillStore,
        withTransaction: callback => db.transaction().execute(callback),
        resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
        catalog: [{ ...news, name: 'news-starter', ref: FIXTURE_COMMIT }],
        readFiles: () => Promise.reject(new Error('a starter is never read')),
      });
      const created = await starterRouter.request(
        '/',
        postInit(wrapManifest({ ...news, name: 'news-starter', ref: FIXTURE_COMMIT })),
      );
      expect(created.status).toBe(201);
      await settingsRouter.request('/news-starter', { method: 'DELETE' });
    });
  });

  describe('network approval', () => {
    const tenX = {
      type: 'git' as const,
      name: 'ten-x',
      url: 'https://github.com/example/ten-x',
      ref: 'main',
      description: 'Works with GitHub from the sandbox.',
      network_hosts: ['github.com', 'api.github.com'],
    };

    // Seeded straight into the store: these tests are about the approval routes, not about adding.
    beforeAll(async () => {
      await skillStore.createSkill({ tenant_id: 'default', name: tenX.name, manifest: tenX });
    });

    it('GET shows the declared sites, no approval yet, and no send line for GitHub', async () => {
      const response = await settingsRouter.request('/ten-x/network-approval');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('PUT stores the approval for exactly the declared list', async () => {
      const response = await settingsRouter.request(
        '/ten-x/network-approval',
        putInit({ hosts: ['api.github.com', 'github.com'] }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: ['github.com', 'api.github.com'],
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
      const state = await settingsRouter.request('/ten-x/network-approval');
      expect(await state.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: ['github.com', 'api.github.com'],
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('PUT refuses a list that is not the declared list, with the next step in plain words', async () => {
      const response = await settingsRouter.request('/ten-x/network-approval', putInit({ hosts: ['github.com'] }));
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('The list of sites changed since this page was loaded');
    });

    it('DELETE takes the approval back', async () => {
      const removed = await settingsRouter.request('/ten-x/network-approval', { method: 'DELETE' });
      expect(removed.status).toBe(200);
      const state = await settingsRouter.request('/ten-x/network-approval');
      expect(await state.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('a skill that declares no sites reports an empty list and never a send line', async () => {
      const response = await settingsRouter.request('/algorithmic-art/network-approval');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: {
          declared_hosts: [],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('a mail skill is flagged send-capable so Settings can name the sending', async () => {
      const mailSkill = {
        type: 'git' as const,
        name: 'mail-reader',
        url: 'https://github.com/example/mail-reader',
        ref: 'main',
        description: 'Reads mail.',
        network_hosts: ['gmail.googleapis.com'],
      };
      await skillStore.createSkill({ tenant_id: 'default', name: mailSkill.name, manifest: mailSkill });
      const response = await settingsRouter.request('/mail-reader/network-approval');
      expect(await response.json()).toEqual({
        data: {
          declared_hosts: ['gmail.googleapis.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: true,
        },
      });
    });

    it('all three routes 404 for an unknown skill name', async () => {
      const get = await settingsRouter.request('/nope/network-approval');
      expect(get.status).toBe(404);
      const put = await settingsRouter.request('/nope/network-approval', putInit({ hosts: [] }));
      expect(put.status).toBe(404);
      const del = await settingsRouter.request('/nope/network-approval', { method: 'DELETE' });
      expect(del.status).toBe(404);
    });

    it('PUT allowed-host allows one site on its own, without approving the declared list', async () => {
      const response = await settingsRouter.request(
        '/ten-x/network-approval/allowed-host',
        putInit({ host: 'uploads.github.com' }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: ['uploads.github.com'],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('DELETE allowed-host clears that one site again', async () => {
      const removed = await settingsRouter.request('/ten-x/network-approval/allowed-host?host=uploads.github.com', {
        method: 'DELETE',
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({});
      const state = await settingsRouter.request('/ten-x/network-approval');
      expect(await state.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('PUT denied-host turns one site down, and a site holds one decision at a time', async () => {
      const allowed = await settingsRouter.request(
        '/ten-x/network-approval/allowed-host',
        putInit({ host: 'uploads.github.com' }),
      );
      expect(allowed.status).toBe(200);
      const denied = await settingsRouter.request(
        '/ten-x/network-approval/denied-host',
        putInit({ host: 'uploads.github.com' }),
      );
      expect(denied.status).toBe(200);
      expect(await denied.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: ['uploads.github.com'],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('DELETE denied-host clears the turned-down site so a card can ask again', async () => {
      const removed = await settingsRouter.request('/ten-x/network-approval/denied-host?host=uploads.github.com', {
        method: 'DELETE',
      });
      expect(removed.status).toBe(200);
      const state = await settingsRouter.request('/ten-x/network-approval');
      expect(await state.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: [],
          session_hosts: [],
          send_capable: false,
        },
      });
    });

    it('clearing an allowed site never clears a turned-down one, and the other way round', async () => {
      await settingsRouter.request('/ten-x/network-approval/allowed-host', putInit({ host: 'a.example.com' }));
      await settingsRouter.request('/ten-x/network-approval/denied-host', putInit({ host: 'b.example.com' }));
      await settingsRouter.request('/ten-x/network-approval/allowed-host?host=a.example.com', { method: 'DELETE' });
      const state = await settingsRouter.request('/ten-x/network-approval');
      expect(await state.json()).toEqual({
        data: {
          declared_hosts: ['github.com', 'api.github.com'],
          approved_hosts: null,
          allowed_hosts: [],
          denied_hosts: ['b.example.com'],
          session_hosts: [],
          send_capable: false,
        },
      });
      await settingsRouter.request('/ten-x/network-approval/denied-host?host=b.example.com', { method: 'DELETE' });
    });

    it('the per-site routes 404 for an unknown skill name', async () => {
      const allow = await settingsRouter.request(
        '/nope/network-approval/allowed-host',
        putInit({ host: 'a.example.com' }),
      );
      expect(allow.status).toBe(404);
      const deny = await settingsRouter.request(
        '/nope/network-approval/denied-host',
        putInit({ host: 'a.example.com' }),
      );
      expect(deny.status).toBe(404);
      const clearAllowed = await settingsRouter.request('/nope/network-approval/allowed-host?host=a.example.com', {
        method: 'DELETE',
      });
      expect(clearAllowed.status).toBe(404);
      const clearDenied = await settingsRouter.request('/nope/network-approval/denied-host?host=a.example.com', {
        method: 'DELETE',
      });
      expect(clearDenied.status).toBe(404);
    });
  });
});
