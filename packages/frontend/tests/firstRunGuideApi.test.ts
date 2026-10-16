import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFirstRunGuideApi } from '../src/firstRunGuideApi';

test('first-run guide API reads the dismissal and writes it back as a PUT', async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const api = createFirstRunGuideApi(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    const body: unknown = request.method === 'PUT' ? await request.json() : undefined;
    requests.push({ method: request.method, body });
    assert.equal(request.url, 'http://localhost/api/v1/settings/first-run-guide');
    return Response.json({ data: { dismissed: request.method === 'PUT' } });
  });

  assert.equal(await api.getDismissed(), false);
  assert.equal(await api.setDismissed(true), true);
  assert.deepEqual(requests, [
    { method: 'GET', body: undefined },
    { method: 'PUT', body: { dismissed: true } },
  ]);
});

test('first-run guide API surfaces the server message and rejects a malformed body', async () => {
  const failing = createFirstRunGuideApi(async () =>
    Response.json({ error: { message: 'Admin access required.' } }, { status: 403 }),
  );
  await assert.rejects(failing.getDismissed(), /Admin access required/);

  const malformed = createFirstRunGuideApi(async () => Response.json({ data: { dismissed: 'yes' } }));
  await assert.rejects(malformed.getDismissed(), /invalid/);
});
