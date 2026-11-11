import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandboxWorkspacesApi } from '../src/sandboxWorkspacesApi';

const LISTING = {
  slots: [{ slot: 1, workspace_count: 1, total_bytes: 4096, store_free_bytes: 1024 }],
  workspaces: [
    {
      holder: 'you',
      chat_id: 'chat-1',
      chat_title: 'Trip planning',
      chat_private: false,
      sandbox_id: `s1-${'a'.repeat(32)}`,
      slot: 1,
      bytes: 4096,
      entries: 12,
      last_used: '2026-11-01T10:00:00.000Z',
    },
  ],
};

test('chat workspaces API reads the listing from the settings route', async () => {
  const requests: Request[] = [];
  const api = createSandboxWorkspacesApi(async input => {
    requests.push(new Request(new URL(String(input), 'http://localhost')));
    return Response.json({ data: LISTING });
  });

  assert.deepEqual(await api.listSandboxWorkspaces(), LISTING);
  assert.equal(new URL(requests[0]?.url ?? '').pathname, '/api/v1/settings/sandbox-workspaces');
});

test('chat workspaces API surfaces the server error message', async () => {
  const api = createSandboxWorkspacesApi(async () =>
    Response.json({ error: { message: 'The sandbox slots could not be asked.' } }, { status: 500 }),
  );
  await assert.rejects(api.listSandboxWorkspaces(), { message: 'The sandbox slots could not be asked.' });
});

test('chat workspaces API falls back to the HTTP status when the body is not an error envelope', async () => {
  const api = createSandboxWorkspacesApi(async () => new Response('Bad Gateway', { status: 502 }));
  await assert.rejects(api.listSandboxWorkspaces(), { message: 'Request failed (502).' });
});

test('chat workspaces API rejects a listing it cannot read', async () => {
  const api = createSandboxWorkspacesApi(async () => Response.json({ data: { slots: 'many', workspaces: [] } }));
  await assert.rejects(api.listSandboxWorkspaces(), { message: 'The chat workspaces response was invalid.' });
});
