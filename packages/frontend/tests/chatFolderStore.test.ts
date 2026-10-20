import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatFolderStore } from '../src/chatFolderStore';

const FOLDER_A = { id: 'folder-a', name: 'Project A' };
const FOLDER_B = { id: 'folder-b', name: 'Project B' };

const FOLDERS_RESPONSE = {
  data: [FOLDER_A, FOLDER_B],
};

type SessionAgentWire =
  { type: 'reference'; id: string; name: string | null } | { type: 'inline'; spec: { model: { name: string } } };

function sessionWire({
  id,
  folderId,
  title,
  updatedAt,
  agent,
}: {
  id: string;
  folderId: string;
  title: string | null;
  updatedAt: string;
  agent: SessionAgentWire;
}) {
  return { id, folder_id: folderId, title, updated_at: updatedAt, agent };
}

test('chat folder store loads each folder by folder and pages within that folder', async () => {
  const sessionRequests: Array<{ folderId: string | null; pageToken: string | null }> = [];
  const store = createChatFolderStore(async input => {
    const url = new URL(String(input), 'http://localhost');

    if (url.pathname === '/api/v1/session-folders') {
      return Response.json(FOLDERS_RESPONSE);
    }

    if (url.pathname === '/api/v1/sessions') {
      assert.equal(url.searchParams.get('limit'), '25', 'should request a page size of 25');
      assert.equal(url.searchParams.get('order'), 'desc', 'should request newest chats first');
      const folderId = url.searchParams.get('folder_id');
      const pageToken = url.searchParams.get('page_token');
      sessionRequests.push({ folderId, pageToken });

      if (folderId === 'folder-a' && pageToken === null) {
        return Response.json({
          data: [
            sessionWire({
              id: 'session-a1',
              folderId: 'folder-a',
              title: 'Alpha one',
              updatedAt: '2026-10-20T12:00:00.000Z',
              agent: { type: 'reference', id: 'agent-support', name: 'Support' },
            }),
            sessionWire({
              id: 'session-a2',
              folderId: 'folder-a',
              title: null,
              updatedAt: '2026-10-19T12:00:00.000Z',
              agent: { type: 'inline', spec: { model: { name: 'test-model' } } },
            }),
          ],
          pagination: { next_page_token: 'folder-a-page-2' },
        });
      }
      if (folderId === 'folder-a' && pageToken === 'folder-a-page-2') {
        return Response.json({
          data: [
            sessionWire({
              id: 'session-a3',
              folderId: 'folder-a',
              title: 'Alpha three',
              updatedAt: '2026-10-18T12:00:00.000Z',
              agent: { type: 'reference', id: 'agent-research', name: null },
            }),
          ],
          pagination: {},
        });
      }
      if (folderId === 'folder-b' && pageToken === null) {
        return Response.json({
          data: [
            sessionWire({
              id: 'session-b1',
              folderId: 'folder-b',
              title: 'Beta one',
              updatedAt: '2026-10-17T12:00:00.000Z',
              agent: { type: 'inline', spec: { model: { name: 'test-model' } } },
            }),
          ],
          pagination: {},
        });
      }
    }

    throw new Error(`Unexpected request to ${url.pathname}${url.search}`);
  });

  const result = await store.load();

  assert.deepEqual(result.folders, [FOLDER_A, FOLDER_B]);
  assert.deepEqual(sessionRequests, [
    { folderId: 'folder-a', pageToken: null },
    { folderId: 'folder-a', pageToken: 'folder-a-page-2' },
    { folderId: 'folder-b', pageToken: null },
  ]);
  assert.deepEqual(result.assignments, [
    { sessionId: 'session-a1', folderId: 'folder-a' },
    { sessionId: 'session-a2', folderId: 'folder-a' },
    { sessionId: 'session-a3', folderId: 'folder-a' },
    { sessionId: 'session-b1', folderId: 'folder-b' },
  ]);
  assert.deepEqual(result.folderSessions, [
    {
      folderId: 'folder-a',
      sessions: [
        {
          sessionId: 'session-a1',
          title: 'Alpha one',
          updatedAt: new Date('2026-10-20T12:00:00.000Z'),
          agentName: 'Support',
          isMutable: false,
        },
        {
          sessionId: 'session-a2',
          title: null,
          updatedAt: new Date('2026-10-19T12:00:00.000Z'),
          agentName: null,
          isMutable: true,
        },
        {
          sessionId: 'session-a3',
          title: 'Alpha three',
          updatedAt: new Date('2026-10-18T12:00:00.000Z'),
          agentName: null,
          isMutable: false,
        },
      ],
    },
    {
      folderId: 'folder-b',
      sessions: [
        {
          sessionId: 'session-b1',
          title: 'Beta one',
          updatedAt: new Date('2026-10-17T12:00:00.000Z'),
          agentName: null,
          isMutable: true,
        },
      ],
    },
  ]);
});

test('chat folder store returns an empty chat list for an empty folder', async () => {
  let sessionRequests = 0;
  const store = createChatFolderStore(async input => {
    const url = new URL(String(input), 'http://localhost');

    if (url.pathname === '/api/v1/session-folders') {
      return Response.json({ data: [FOLDER_A] });
    }

    if (url.pathname === '/api/v1/sessions') {
      sessionRequests++;
      assert.equal(url.searchParams.get('folder_id'), 'folder-a');
      return Response.json({ data: [], pagination: {} });
    }

    throw new Error(`Unexpected request to ${url.pathname}`);
  });

  const result = await store.load();

  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.folderSessions, [{ folderId: 'folder-a', sessions: [] }]);
  assert.equal(sessionRequests, 1);
});

test('chat folder store surfaces server errors', async () => {
  const store = createChatFolderStore(async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/session-folders') {
      return new Response('Server error', { status: 500 });
    }
    throw new Error(`Unexpected request to ${url.pathname}`);
  });

  await assert.rejects(store.load(), /Server error/);
});

test('chat folder store surfaces a failed folder chat request', async () => {
  const store = createChatFolderStore(async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/session-folders') {
      return Response.json({ data: [FOLDER_A] });
    }
    if (url.pathname === '/api/v1/sessions') {
      return new Response('Folder chats unavailable', { status: 500 });
    }
    throw new Error(`Unexpected request to ${url.pathname}`);
  });

  await assert.rejects(store.load(), /Folder chats unavailable/);
});
