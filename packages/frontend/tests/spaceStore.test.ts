import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpaceStore } from '../src/spaceStore';

const SPAIN_HOUSES = {
  id: 's-spain-houses',
  name: 'Spain houses',
  purpose: 'Track candidate houses in Spain.',
  status: 'active',
  body: 'Shortlist.',
  format: 'markdown',
  folder_id: null,
  revision: 2,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
};

test('space store delete sends the revision as a query param and returns nothing on 200', async () => {
  const requests: Request[] = [];
  const store = createSpaceStore(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    return Response.json({}, { status: 200 });
  });

  const result = await store.delete({ spaceId: SPAIN_HOUSES.id, expectedRevision: SPAIN_HOUSES.revision });

  assert.equal(result, undefined);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.method, 'DELETE');
  const url = new URL(request.url);
  assert.equal(url.pathname, `/api/v1/spaces/${SPAIN_HOUSES.id}`);
  assert.equal(url.searchParams.get('expected_revision'), String(SPAIN_HOUSES.revision));
});

test('space store delete retries once with a fresh revision after a 409', async () => {
  const requests: Request[] = [];
  const store = createSpaceStore(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === 'GET') {
      return Response.json({ data: { ...SPAIN_HOUSES, revision: 3 } });
    }
    if (url.searchParams.get('expected_revision') === '1') {
      return new Response('{"error":{"message":"Stale space revision: s-spain-houses"}}', { status: 409 });
    }
    return Response.json({}, { status: 200 });
  });

  const result = await store.delete({ spaceId: SPAIN_HOUSES.id, expectedRevision: 1 });

  assert.equal(result, undefined);
  assert.equal(requests.length, 3);
  const [firstDelete, get, retryDelete] = requests;
  assert.ok(firstDelete && get && retryDelete);
  assert.equal(firstDelete.method, 'DELETE');
  assert.equal(new URL(firstDelete.url).searchParams.get('expected_revision'), '1');
  assert.equal(get.method, 'GET');
  assert.equal(new URL(get.url).pathname, `/api/v1/spaces/${SPAIN_HOUSES.id}`);
  assert.equal(retryDelete.method, 'DELETE');
  assert.equal(new URL(retryDelete.url).searchParams.get('expected_revision'), '3');
});

test('space store delete surfaces the error when the retry also conflicts', async () => {
  const requests: Request[] = [];
  const store = createSpaceStore(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    if (request.method === 'GET') {
      return Response.json({ data: { ...SPAIN_HOUSES, revision: 3 } });
    }
    return new Response('{"error":{"message":"Stale space revision: s-spain-houses"}}', { status: 409 });
  });

  await assert.rejects(store.delete({ spaceId: SPAIN_HOUSES.id, expectedRevision: 1 }), /Stale space revision/);
  // First DELETE (409) + GET for the fresh revision + retried DELETE (409 again, then surfaced).
  assert.equal(requests.length, 3);
});

test('space store delete surfaces the server’s error message on a non-2xx response', async () => {
  const store = createSpaceStore(async () => new Response('Stale space revision: s-spain-houses', { status: 409 }));

  await assert.rejects(store.delete({ spaceId: SPAIN_HOUSES.id, expectedRevision: 1 }), /Stale space revision/);
});

test('space store list and get still parse the wire shape unchanged', async () => {
  const store = createSpaceStore(async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/v1/spaces') {
      return Response.json({ data: { spaces: [SPAIN_HOUSES], aggregate_revision: 1 } });
    }
    return Response.json({ data: SPAIN_HOUSES });
  });

  assert.deepEqual(await store.list(), [SPAIN_HOUSES]);
  assert.deepEqual(await store.get({ spaceId: SPAIN_HOUSES.id }), SPAIN_HOUSES);
});

function recordingStore(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const store = createSpaceStore(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    return respond(request);
  });
  return { store, requests };
}

test('space store list reads each space with its folder', async () => {
  const { store } = recordingStore(() =>
    Response.json({
      data: {
        spaces: [SPAIN_HOUSES, { ...SPAIN_HOUSES, id: 's-other', folder_id: 'folder-1' }],
        aggregate_revision: 3,
      },
    }),
  );

  const spaces = await store.list();

  assert.deepEqual(
    spaces.map(space => space.folder_id),
    [null, 'folder-1'],
  );
});

test('space store rejects a space that does not say where it is filed', async () => {
  const withoutFolder: Record<string, unknown> = { ...SPAIN_HOUSES };
  Reflect.deleteProperty(withoutFolder, 'folder_id');
  const { store } = recordingStore(() => Response.json({ data: { spaces: [withoutFolder], aggregate_revision: 1 } }));

  await assert.rejects(store.list(), /invalid space/);
});

test('space store lists, creates, renames and deletes folders', async () => {
  const { store, requests } = recordingStore(request => {
    if (request.method === 'DELETE') return Response.json({});
    if (request.method === 'GET')
      return Response.json({ data: [{ id: 'f-1', name: 'Homes', created_at: 'x', updated_at: 'x' }] });
    return Response.json({ data: { id: 'f-1', name: 'Renamed', created_at: 'x', updated_at: 'x' } }, { status: 201 });
  });

  assert.deepEqual(await store.listFolders(), [{ id: 'f-1', name: 'Homes' }]);
  assert.deepEqual(await store.createFolder({ name: 'Homes' }), { id: 'f-1', name: 'Renamed' });
  assert.deepEqual(await store.renameFolder({ folderId: 'f-1', name: 'Renamed' }), { id: 'f-1', name: 'Renamed' });
  assert.equal(await store.deleteFolder({ folderId: 'f 1' }), undefined);

  assert.deepEqual(
    requests.map(request => [request.method, new URL(request.url).pathname]),
    [
      ['GET', '/api/v1/space-folders'],
      ['POST', '/api/v1/space-folders'],
      ['PUT', '/api/v1/space-folders/f-1'],
      ['DELETE', '/api/v1/space-folders/f%201'],
    ],
  );
  assert.deepEqual(await requests[1]?.json(), { name: 'Homes' });
  assert.deepEqual(await requests[2]?.json(), { name: 'Renamed' });
});

test('space store moves a space into a folder and back out', async () => {
  const { store, requests } = recordingStore(() => Response.json({}));

  await store.setSpaceFolder({ spaceId: 's-1', folderId: 'f-1' });
  await store.setSpaceFolder({ spaceId: 's-1', folderId: null });

  assert.deepEqual(
    requests.map(request => [request.method, new URL(request.url).pathname]),
    [
      ['PUT', '/api/v1/spaces/s-1/folder'],
      ['DELETE', '/api/v1/spaces/s-1/folder'],
    ],
  );
  assert.deepEqual(await requests[0]?.json(), { folder_id: 'f-1' });
});

test('space store surfaces the server message when a move is refused', async () => {
  const { store } = recordingStore(() => new Response('Space folder not found: f-9', { status: 404 }));

  await assert.rejects(store.setSpaceFolder({ spaceId: 's-1', folderId: 'f-9' }), /Space folder not found/);
});
