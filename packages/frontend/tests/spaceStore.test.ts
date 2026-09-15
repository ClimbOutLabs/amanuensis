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
  revision: 2,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
};

test('space store delete sends the revision as a query param and returns nothing on 204', async () => {
  const requests: Request[] = [];
  const store = createSpaceStore(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    requests.push(request);
    return new Response(null, { status: 204 });
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
