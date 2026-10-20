import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { createRepositoriesRouter, createSessionRepositoryRouter } from '../../../src/apis/repositories';
import { TENANT_ID } from '../../../src/apis/sessions';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import {
  DeleteSessionRepositoryBindingResponseSchema,
  DeleteSessionRepositoryRequestQuerySchema,
  DeleteVerifyCommandsRequestQuerySchema,
  GetRepositoryResponseSchema,
  GetSessionRepositoryBindingResponseSchema,
  GetVerifyCommandResponseSchema,
  ListVerifyCommandsResponseSchema,
  StartRepositoryWorkResponseSchema,
} from '../../../src/schemas/repository';

const unusedGithubFetch: typeof fetch = () =>
  Promise.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));

async function setup(options: { githubConnected?: boolean; fetchGithub?: typeof fetch } = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const repositoryStore = new SqliteRepositoryStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const agentStore = new SqliteAgentStore(db);
  const mcpServerStore = new SqliteMcpServerStore(db);
  let user: RequestContext = {
    tenant_id: 'default',
    subject: { id: 'owner-1', type: 'user', display_name: 'owner-1' },
    roles: ['admin'],
    user_credential: null,
  };
  const fetchGithub = options.fetchGithub ?? unusedGithubFetch;
  const app = new OpenAPIHono();
  app.route(
    '/repositories',
    createRepositoriesRouter({ repositoryStore, resolveRequestContext: () => user, fetchGithub }),
  );
  app.route(
    '/sessions',
    createSessionRepositoryRouter({
      repositoryStore,
      sessionStore,
      resolveRequestContext: () => user,
      resolveAgentStore: () => agentStore,
      resolveMcpServerStore: () => mcpServerStore,
      resolveWorkspaceDir: () => Promise.resolve('/workspace'),
      fetchGithub,
    }),
  );
  if (options.githubConnected === true) {
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'github',
      manifest: {
        type: 'remote',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        description: 'GitHub',
        auth: { type: 'header', headers: { authorization: 'Bearer ghp_invented_token' } },
      },
      first_party: false,
    });
  }
  await sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: 'session-1',
    created_by_subject: { subject_id: user.subject.id, subject_type: 'user', subject_display_name: user.subject.id },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({
        model: { name: 'test/model' },
        instructions: 'test',
        ...(options.githubConnected === true ? { mcp_servers: [{ name: 'github' }] } : {}),
      }),
    },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  return {
    app,
    repositoryStore,
    setUser(next: RequestContext) {
      user = next;
    },
  };
}

describe('repository API', () => {
  it('registers, confirms, and binds a repository command through owner-scoped routes', async () => {
    const { app, repositoryStore } = await setup();
    const createResponse = await app.request('/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: {
          name: 'aman',
          clone_url: 'https://github.com/example/aman.git',
          default_branch: 'main',
        },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = GetRepositoryResponseSchema.parse(await createResponse.json());
    const repositoryId = created.data.id;

    await repositoryStore.upsertVerifyCommandProposal({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      repository_id: repositoryId,
      id: 'package-verify',
      purpose: 'verify',
      command: 'pnpm verify',
      source_kind: 'package_json',
      source_path: 'package.json',
      source_fingerprint: 'sha256:fixture',
    });
    const confirmResponse = await app.request(
      `/repositories/${repositoryId}/command-proposals/package-verify/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command_id: 'verify', timeout_ms: 900_000, expected_revision: 0 }),
      },
    );
    expect(confirmResponse.status).toBe(200);
    const confirmedCommand = GetVerifyCommandResponseSchema.parse(await confirmResponse.json());
    expect(Object.keys(confirmedCommand)).toEqual(['data']);
    expect(confirmedCommand).toMatchObject({
      data: { command_id: 'verify', command: 'pnpm verify', purpose: 'verify', repository_revision: 1 },
    });

    const bindResponse = await app.request('/sessions/session-1/repository', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository_id: repositoryId,
        workspace_cwd: 'C:\\work\\aman',
        expected_revision: 1,
      }),
    });
    expect(bindResponse.status).toBe(200);
    await expect(bindResponse.json()).resolves.toMatchObject({
      data: { session_id: 'session-1', repository_id: repositoryId, workspace_cwd: 'C:\\work\\aman' },
    });

    const commandsResponse = await app.request(`/repositories/${repositoryId}/commands`);
    expect(commandsResponse.status).toBe(200);
    const listedCommands = ListVerifyCommandsResponseSchema.parse(await commandsResponse.json());
    expect(Object.keys(listedCommands)).toEqual(['data']);
    expect(listedCommands).toMatchObject({
      data: { commands: [{ command_id: 'verify', purpose: 'verify' }], repository_revision: 1 },
    });
  });

  it('turns package downloads on and off for a repository through its route', async () => {
    const { app, setUser } = await setup();
    const createResponse = await app.request('/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: { name: 'downloads', clone_url: 'https://example.test/downloads.git', default_branch: 'main' },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = GetRepositoryResponseSchema.parse(await createResponse.json());
    expect(created.data.package_downloads_allowed).toBe(false);
    const repositoryId = created.data.id;

    const allowResponse = await app.request(`/repositories/${repositoryId}/package-downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed: true, expected_revision: created.data.revision }),
    });
    expect(allowResponse.status).toBe(200);
    const allowed = GetRepositoryResponseSchema.parse(await allowResponse.json());
    expect(allowed.data.package_downloads_allowed).toBe(true);

    const staleResponse = await app.request(`/repositories/${repositoryId}/package-downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed: false, expected_revision: created.data.revision }),
    });
    expect(staleResponse.status).toBe(409);

    const stopResponse = await app.request(`/repositories/${repositoryId}/package-downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed: false }),
    });
    expect(stopResponse.status).toBe(200);
    expect(GetRepositoryResponseSchema.parse(await stopResponse.json()).data.package_downloads_allowed).toBe(false);

    setUser({
      tenant_id: 'default',
      subject: { id: 'owner-2', type: 'user', display_name: 'owner-2' },
      roles: ['admin'],
      user_credential: null,
    });
    const strangerResponse = await app.request(`/repositories/${repositoryId}/package-downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed: true }),
    });
    expect(strangerResponse.status).toBe(404);
  });

  it('does not reveal another owner repository and rejects stale command writes', async () => {
    const { app, setUser } = await setup();
    const createResponse = await app.request('/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: { name: 'private', clone_url: 'https://example.test/private.git' } }),
    });
    const repositoryId = GetRepositoryResponseSchema.parse(await createResponse.json()).data.id;

    const firstWrite = await app.request(`/repositories/${repositoryId}/commands/verify`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'verify', command: 'make check', timeout_ms: 120_000, expected_revision: 0 }),
    });
    expect(firstWrite.status).toBe(200);
    const staleWrite = await app.request(`/repositories/${repositoryId}/commands/verify`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'verify', command: 'make verify', timeout_ms: 120_000, expected_revision: 0 }),
    });
    expect(staleWrite.status).toBe(409);

    setUser({
      tenant_id: 'default',
      subject: { id: 'owner-2', type: 'user', display_name: 'owner-2' },
      roles: ['admin'],
      user_credential: null,
    });
    expect((await app.request(`/repositories/${repositoryId}`)).status).toBe(404);
    expect((await app.request(`/repositories/${repositoryId}/commands`)).status).toBe(404);
  });

  it('treats an omitted expected_revision on repository unbind as unconditional', async () => {
    expect(DeleteSessionRepositoryRequestQuerySchema.parse({})).toEqual({ expected_revision: undefined });
    expect(DeleteSessionRepositoryRequestQuerySchema.parse({ expected_revision: '' })).toEqual({
      expected_revision: undefined,
    });
    expect(DeleteVerifyCommandsRequestQuerySchema.parse({ expected_revision: '0' })).toEqual({ expected_revision: 0 });

    const { app, repositoryStore } = await setup();
    const repository = await repositoryStore.createRepository({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      name: 'unconditional-unbind',
      clone_url: 'https://example.test/unconditional-unbind.git',
      default_branch: null,
    });
    await repositoryStore.bindSession({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      session_id: 'session-1',
      repository_id: repository.id,
      workspace_cwd: 'C:\\work\\unconditional-unbind',
      expected_revision: repository.revision,
    });
    await repositoryStore.upsertVerifyCommand({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      repository_id: repository.id,
      command_id: 'verify',
      purpose: 'verify',
      command: 'pnpm verify',
      timeout_ms: 120_000,
      expected_revision: repository.revision,
    });

    const staleDelete = await app.request('/sessions/session-1/repository?expected_revision=0', {
      method: 'DELETE',
    });
    expect(staleDelete.status).toBe(409);

    const unconditionalDelete = await app.request('/sessions/session-1/repository', { method: 'DELETE' });
    expect(unconditionalDelete.status).toBe(200);
    expect(DeleteSessionRepositoryBindingResponseSchema.parse(await unconditionalDelete.json())).toEqual({});

    const getBinding = await app.request('/sessions/session-1/repository');
    expect(getBinding.status).toBe(200);
    expect(GetSessionRepositoryBindingResponseSchema.parse(await getBinding.json())).toEqual({
      data: { session_id: 'session-1', repository_id: null, workspace_cwd: null },
    });
  });

  it('returns the mutation revision without rereading the repository after a write', async () => {
    const { app, repositoryStore } = await setup();
    const createResponse = await app.request('/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: { name: 'atomic', clone_url: 'https://example.test/atomic.git' } }),
    });
    const repositoryId = GetRepositoryResponseSchema.parse(await createResponse.json()).data.id;
    const getRepository = jest.spyOn(repositoryStore, 'getRepository');

    const upsertResponse = await app.request(`/repositories/${repositoryId}/commands/verify`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'verify', command: 'pnpm verify', timeout_ms: 120_000, expected_revision: 0 }),
    });
    expect(upsertResponse.status).toBe(200);
    expect(GetVerifyCommandResponseSchema.parse(await upsertResponse.json())).toMatchObject({
      data: { command_id: 'verify', repository_revision: 1 },
    });
    expect(getRepository).toHaveBeenCalledTimes(1);

    await repositoryStore.upsertVerifyCommandProposal({
      tenant_id: TENANT_ID,
      created_by: 'owner-1',
      repository_id: repositoryId,
      id: 'proposal-atomic',
      purpose: 'test',
      command: 'pnpm test',
      source_kind: 'package_json',
      source_path: 'package.json',
      source_fingerprint: 'sha256:atomic',
    });
    getRepository.mockClear();

    const confirmResponse = await app.request(
      `/repositories/${repositoryId}/command-proposals/proposal-atomic/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command_id: 'test', timeout_ms: 120_000, expected_revision: 1 }),
      },
    );
    expect(confirmResponse.status).toBe(200);
    expect(GetVerifyCommandResponseSchema.parse(await confirmResponse.json())).toMatchObject({
      data: { command_id: 'test', repository_revision: 2 },
    });
    expect(getRepository).toHaveBeenCalledTimes(1);
  });
});

const DEMO_REPO = {
  name: 'demo-repo',
  full_name: 'octo-example/demo-repo',
  clone_url: 'https://github.com/octo-example/demo-repo.git',
  default_branch: 'main',
  size: 2_048,
  private: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Fake GitHub API for the invented octo-example/demo-repo repo; never touches the network. */
function demoGithubFetch(input: { size?: number } = {}): typeof fetch {
  return (request: Parameters<typeof fetch>[0]) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    if (url === 'https://api.github.com/user/repos?per_page=100&sort=updated') {
      return Promise.resolve(jsonResponse([DEMO_REPO]));
    }
    if (url === 'https://api.github.com/repos/octo-example/demo-repo') {
      return Promise.resolve(jsonResponse({ ...DEMO_REPO, size: input.size ?? DEMO_REPO.size }));
    }
    if (url === 'https://api.github.com/repos/octo-example/demo-repo/branches?per_page=100') {
      return Promise.resolve(jsonResponse([{ name: 'main' }, { name: 'dev' }]));
    }
    return Promise.resolve(jsonResponse({ message: 'Not Found' }, 404));
  };
}

describe('work on a repo API', () => {
  it('says to connect GitHub when the chat has no GitHub connector', async () => {
    const { app } = await setup({ fetchGithub: demoGithubFetch() });
    const response = await app.request('/sessions/session-1/repository/github-repositories');
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { message: 'Connect GitHub first, under Connectors.' } });
  });

  it('lists the repos the connected GitHub account can open', async () => {
    const { app } = await setup({ githubConnected: true, fetchGithub: demoGithubFetch() });
    const response = await app.request('/sessions/session-1/repository/github-repositories');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        repositories: [
          {
            name: 'demo-repo',
            full_name: 'octo-example/demo-repo',
            clone_url: 'https://github.com/octo-example/demo-repo.git',
            default_branch: 'main',
            size_kb: 2_048,
            private: false,
          },
        ],
      },
    });
  });

  it('looks up a public repo and its branches without a connector', async () => {
    const { app } = await setup({ fetchGithub: demoGithubFetch() });
    const response = await app.request(
      '/sessions/session-1/repository/github-repository?clone_url=https%3A%2F%2Fgithub.com%2Focto-example%2Fdemo-repo',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        name: 'demo-repo',
        full_name: 'octo-example/demo-repo',
        clone_url: 'https://github.com/octo-example/demo-repo.git',
        default_branch: 'main',
        size_kb: 2_048,
        private: false,
        branches: ['main', 'dev'],
      },
    });
  });

  it('rejects an address that is not a GitHub repo', async () => {
    const { app } = await setup({ fetchGithub: demoGithubFetch() });
    const response = await app.request(
      '/sessions/session-1/repository/github-repository?clone_url=https%3A%2F%2Fexample.com%2Focto-example%2Fdemo-repo',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message:
          'That does not look like a GitHub repo address. Paste the full address, like https://github.com/owner/name.',
      },
    });
  });

  it('reports a repo GitHub cannot find in plain words', async () => {
    const { app } = await setup({ fetchGithub: demoGithubFetch() });
    const response = await app.request(
      '/repositories/github/metadata?clone_url=https%3A%2F%2Fgithub.com%2Focto-example%2Fmissing-repo',
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        message:
          'That repo could not be found on GitHub. Check the address, and if the repo is private, connect GitHub under Connectors and try again.',
      },
    });
  });

  it('registers the repo and binds the chat on start work', async () => {
    const { app } = await setup({ githubConnected: true, fetchGithub: demoGithubFetch() });
    const response = await app.request('/sessions/session-1/repository/start-work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clone_url: 'https://github.com/octo-example/demo-repo', branch: 'dev' }),
    });
    expect(response.status).toBe(200);
    const started = StartRepositoryWorkResponseSchema.parse(await response.json());
    expect(started.data.branch).toBe('dev');
    expect(started.data.workspace_cwd).toBe('/workspace/demo-repo');
    expect(started.data.repository.name).toBe('demo-repo');
    expect(started.data.repository.clone_url).toBe('https://github.com/octo-example/demo-repo.git');

    const bindingResponse = await app.request('/sessions/session-1/repository');
    expect(bindingResponse.status).toBe(200);
    expect(GetSessionRepositoryBindingResponseSchema.parse(await bindingResponse.json())).toEqual({
      data: {
        session_id: 'session-1',
        repository_id: started.data.repository_id,
        workspace_cwd: '/workspace/demo-repo',
      },
    });
  });

  it('reuses the registered repo when work starts twice', async () => {
    const { app, repositoryStore } = await setup({ githubConnected: true, fetchGithub: demoGithubFetch() });
    const body = JSON.stringify({ clone_url: 'https://github.com/octo-example/demo-repo.git', branch: 'main' });
    const first = await app.request('/sessions/session-1/repository/start-work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request('/sessions/session-1/repository/start-work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    const repositories = await repositoryStore.listRepositories({ tenant_id: TENANT_ID, created_by: 'owner-1' });
    expect(repositories).toHaveLength(1);
  });

  it('refuses a repo larger than 100 MB in plain words', async () => {
    const { app } = await setup({ githubConnected: true, fetchGithub: demoGithubFetch({ size: 200 * 1024 }) });
    const response = await app.request('/sessions/session-1/repository/start-work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clone_url: 'https://github.com/octo-example/demo-repo', branch: 'main' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { message: "This repo is larger than 100 MB, so it can't be opened yet." },
    });
  });

  it('refuses a branch the repo does not have', async () => {
    const { app } = await setup({ githubConnected: true, fetchGithub: demoGithubFetch() });
    const response = await app.request('/sessions/session-1/repository/start-work', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clone_url: 'https://github.com/octo-example/demo-repo', branch: 'nope' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'That branch is not in this repo. Pick one of its branches, then try again.' },
    });
  });
});
