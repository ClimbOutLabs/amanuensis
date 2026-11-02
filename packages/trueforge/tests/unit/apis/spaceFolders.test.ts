import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger } from 'winston';
import { createSpaceFolderAssignmentsRouter, createSpaceFoldersRouter } from '../../../src/apis/spaceFolders';
import { createSpacesRouter } from '../../../src/apis/spaces';
import { createAppErrorHandler } from '../../../src/app';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';

function requestContext(userRef: string): RequestContext {
  return {
    tenant_id: 'default',
    subject: { id: userRef, type: 'user', display_name: userRef },
    roles: [],
    user_credential: null,
  };
}

const userA = requestContext('user-a');
const userB = requestContext('user-b');

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

interface WireSpace {
  id: string;
  revision: number;
  updated_at: string;
  folder_id: string | null;
}

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const spaceStore = new SqliteSpaceStore(db);
  let user = userA;
  const deps = { spaceStore, resolveRequestContext: () => user };
  // Mirrors production: folders and spaces are separate prefixes, and assignments share the spaces prefix.
  const app = new OpenAPIHono();
  app.route('/api/v1/spaces', createSpacesRouter(deps));
  app.route('/api/v1/spaces', createSpaceFolderAssignmentsRouter(deps));
  app.route('/api/v1/space-folders', createSpaceFoldersRouter(deps));
  app.onError(createAppErrorHandler({ logger: createLogger({ silent: true }) }));

  const createSpace = async () => {
    const response = await app.request(
      '/api/v1/spaces',
      jsonInit('POST', {
        space: { name: 'Spain houses', purpose: 'Track houses.', status: 'active', body: 'x' },
        expected_aggregate_revision: (
          await spaceStore.getAggregate({ tenant_id: 'default', created_by: user.subject.id })
        ).revision,
      }),
    );
    return ((await response.json()) as { data: { space: WireSpace } }).data.space;
  };
  const createFolder = async (name: string) => {
    const response = await app.request('/api/v1/space-folders', jsonInit('POST', { name }));
    return ((await response.json()) as { data: { id: string; name: string } }).data;
  };
  const listSpaces = async () =>
    (
      (await (await app.request('/api/v1/spaces')).json()) as {
        data: { spaces: WireSpace[]; aggregate_revision: number };
      }
    ).data;

  return {
    app,
    spaceStore,
    createSpace,
    createFolder,
    listSpaces,
    as: (next: RequestContext) => {
      user = next;
    },
  };
}

describe('space folders API', () => {
  it('creates, renames, lists sorted, and deletes folders', async () => {
    const { app } = await setup();

    const created = await app.request('/api/v1/space-folders', jsonInit('POST', { name: '  Zeta  ' }));
    expect(created.status).toBe(201);
    const zeta = ((await created.json()) as { data: { id: string; name: string } }).data;
    expect(zeta.name).toBe('Zeta');
    await app.request('/api/v1/space-folders', jsonInit('POST', { name: 'Alpha' }));

    const listed = (await (await app.request('/api/v1/space-folders')).json()) as { data: { name: string }[] };
    expect(listed.data.map(folder => folder.name)).toEqual(['Alpha', 'Zeta']);

    const renamed = await app.request(`/api/v1/space-folders/${zeta.id}`, jsonInit('PUT', { name: 'Beta' }));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ data: { id: zeta.id, name: 'Beta' } });

    const deleted = await app.request(`/api/v1/space-folders/${zeta.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});
    const after = (await (await app.request('/api/v1/space-folders')).json()) as { data: { name: string }[] };
    expect(after.data.map(folder => folder.name)).toEqual(['Alpha']);
  });

  it('rejects a blank or over-long folder name, and renaming a missing folder', async () => {
    const { app } = await setup();

    expect((await app.request('/api/v1/space-folders', jsonInit('POST', { name: '   ' }))).status).toBe(400);
    expect((await app.request('/api/v1/space-folders', jsonInit('POST', { name: 'x'.repeat(65) }))).status).toBe(400);
    expect((await app.request('/api/v1/space-folders/missing', jsonInit('PUT', { name: 'Fine' }))).status).toBe(404);
  });

  it('moves a space into a folder and back out without counting as an edit', async () => {
    const { app, createSpace, createFolder, listSpaces } = await setup();
    const space = await createSpace();
    const folder = await createFolder('Homes');
    expect(space.folder_id).toBeNull();
    const before = await listSpaces();

    const moved = await app.request(`/api/v1/spaces/${space.id}/folder`, jsonInit('PUT', { folder_id: folder.id }));
    expect(moved.status).toBe(200);

    const filed = await listSpaces();
    expect(filed.spaces[0]).toEqual({ ...before.spaces[0], folder_id: folder.id });
    expect(filed.spaces[0]?.revision).toBe(space.revision);
    expect(filed.spaces[0]?.updated_at).toBe(space.updated_at);
    expect(filed.aggregate_revision).toBe(before.aggregate_revision);
    const fetched = (await (await app.request(`/api/v1/spaces/${space.id}`)).json()) as { data: WireSpace };
    expect(fetched.data.folder_id).toBe(folder.id);

    const cleared = await app.request(`/api/v1/spaces/${space.id}/folder`, { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(await listSpaces()).toEqual(before);
  });

  it('keeps the folder through an update and a revert', async () => {
    const { app, createSpace, createFolder } = await setup();
    const space = await createSpace();
    const folder = await createFolder('Homes');
    await app.request(`/api/v1/spaces/${space.id}/folder`, jsonInit('PUT', { folder_id: folder.id }));

    const updateRes = await app.request(
      `/api/v1/spaces/${space.id}`,
      jsonInit('PUT', {
        space: { name: 'Spain houses', purpose: 'Track houses.', status: 'active', body: 'changed' },
        expected_revision: 1,
        expected_aggregate_revision: 1,
      }),
    );
    const updated = (await updateRes.json()) as { data: { space: WireSpace; aggregate_revision: number } };
    expect(updated.data.space.folder_id).toBe(folder.id);

    const revertRes = await app.request(
      `/api/v1/spaces/${space.id}/revert`,
      jsonInit('POST', {
        revision: 1,
        expected_revision: 2,
        expected_aggregate_revision: updated.data.aggregate_revision,
      }),
    );
    const reverted = (await revertRes.json()) as { data: { space: WireSpace } };
    expect(reverted.data.space.revision).toBe(3);
    expect(reverted.data.space.folder_id).toBe(folder.id);
  });

  it('deleting a folder keeps its spaces and leaves them without a folder', async () => {
    const { app, createSpace, createFolder, listSpaces } = await setup();
    const space = await createSpace();
    const folder = await createFolder('Homes');
    await app.request(`/api/v1/spaces/${space.id}/folder`, jsonInit('PUT', { folder_id: folder.id }));

    await app.request(`/api/v1/space-folders/${folder.id}`, { method: 'DELETE' });

    const { spaces } = await listSpaces();
    expect(spaces.map(entry => ({ id: entry.id, folder_id: entry.folder_id, revision: entry.revision }))).toEqual([
      { id: space.id, folder_id: null, revision: 1 },
    ]);
  });

  it('deleting a space removes its assignment but not the folder', async () => {
    const { app, spaceStore, createSpace, createFolder } = await setup();
    const space = await createSpace();
    const folder = await createFolder('Homes');
    await app.request(`/api/v1/spaces/${space.id}/folder`, jsonInit('PUT', { folder_id: folder.id }));

    const deleted = await app.request(`/api/v1/spaces/${space.id}?expected_revision=1`, { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect(await spaceStore.listSpaceFolderAssignments({ tenant_id: 'default', created_by: 'user-a' })).toEqual([]);
    const folders = (await (await app.request('/api/v1/space-folders')).json()) as { data: { id: string }[] };
    expect(folders.data.map(entry => entry.id)).toEqual([folder.id]);
  });

  it('answers 404 to another user who tries to see, move into, rename, or delete a folder', async () => {
    const { app, as, createSpace, createFolder, listSpaces } = await setup();
    const space = await createSpace();
    const folder = await createFolder('Homes');
    await app.request(`/api/v1/spaces/${space.id}/folder`, jsonInit('PUT', { folder_id: folder.id }));

    as(userB);
    const bobSpace = await createSpace();
    const bobFolder = await createFolder('Bob folder');
    expect((await (await app.request('/api/v1/space-folders')).json()) as unknown).toEqual({
      data: [expect.objectContaining({ id: bobFolder.id })],
    });
    expect(
      (await app.request(`/api/v1/spaces/${space.id}/folder`, jsonInit('PUT', { folder_id: bobFolder.id }))).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/v1/spaces/${bobSpace.id}/folder`, jsonInit('PUT', { folder_id: folder.id }))).status,
    ).toBe(404);
    expect((await app.request(`/api/v1/spaces/${space.id}/folder`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/api/v1/space-folders/${folder.id}`, jsonInit('PUT', { name: 'pwned' }))).status).toBe(
      404,
    );
    await app.request(`/api/v1/space-folders/${folder.id}`, { method: 'DELETE' });
    expect((await listSpaces()).spaces.map(entry => entry.folder_id)).toEqual([null]);

    as(userA);
    expect((await listSpaces()).spaces[0]?.folder_id).toBe(folder.id);
    const alices = (await (await app.request('/api/v1/space-folders')).json()) as { data: { name: string }[] };
    expect(alices.data.map(entry => entry.name)).toEqual(['Homes']);
  });
});
