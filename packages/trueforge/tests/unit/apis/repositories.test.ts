import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { createRepositoriesRouter, createSessionRepositoryRouter } from '../../../src/apis/repositories';
import { TENANT_ID } from '../../../src/apis/sessions';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
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
} from '../../../src/schemas/repository';

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const repositoryStore = new SqliteRepositoryStore(db);
  const sessionStore = new SqliteSessionStore(db);
  let user: RequestContext = {
    tenant_id: 'default',
    subject: { id: 'owner-1', type: 'user', display_name: 'owner-1' },
    roles: ['admin'],
    user_credential: null,
  };
  const app = new OpenAPIHono();
  app.route('/repositories', createRepositoriesRouter({ repositoryStore, resolveRequestContext: () => user }));
  app.route(
    '/sessions',
    createSessionRepositoryRouter({ repositoryStore, sessionStore, resolveRequestContext: () => user }),
  );
  await sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: 'session-1',
    created_by_subject: { subject_id: user.subject.id, subject_type: 'user', subject_display_name: user.subject.id },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: 'test/model' }, instructions: 'test' }),
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
