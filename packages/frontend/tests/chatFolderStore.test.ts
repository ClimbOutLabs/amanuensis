import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatFolderStore } from '../src/chatFolderStore';

const FOLDER_A = { id: 'folder-a', name: 'Project A' };
const FOLDER_B = { id: 'folder-b', name: 'Project B' };

const FOLDERS_RESPONSE = {
  data: [FOLDER_A, FOLDER_B],
};

test('chat folder store loads folders and sessions with pagination', async () => {
  let callCount = 0;
  const store = createChatFolderStore(async input => {
    const url = new URL(String(input), 'http://localhost');
    callCount++;

    if (url.pathname === '/api/v1/session-folders') {
      return Response.json(FOLDERS_RESPONSE);
    }

    if (url.pathname === '/api/v1/sessions') {
      const limit = url.searchParams.get('limit');
      assert.equal(limit, '25', 'should request page size of 25');

      const pageToken = url.searchParams.get('page_token');
      if (pageToken === null) {
        // First page
        return Response.json({
          data: [
            { id: 'session-1', folder_id: 'folder-a' },
            { id: 'session-2', folder_id: 'folder-b' },
            { id: 'session-3', folder_id: null },
          ],
          pagination: {
            next_page_token: 'token-page-2',
          },
        });
      } else if (pageToken === 'token-page-2') {
        // Second page
        return Response.json({
          data: [
            { id: 'session-4', folder_id: 'folder-a' },
            { id: 'session-5', folder_id: null },
          ],
          pagination: {},
        });
      }
    }

    throw new Error(`Unexpected request to ${url.pathname}`);
  });

  const result = await store.load();

  assert.deepEqual(result.folders, [FOLDER_A, FOLDER_B]);
  assert.equal(result.assignments.length, 3);
  assert.deepEqual(
    result.assignments.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [
      { sessionId: 'session-1', folderId: 'folder-a' },
      { sessionId: 'session-2', folderId: 'folder-b' },
      { sessionId: 'session-4', folderId: 'folder-a' },
    ],
  );
  assert.equal(callCount, 3, 'should make 3 requests: folders, page 1, page 2');
});

test('chat folder store handles single page under limit', async () => {
  let sessionRequests = 0;
  const store = createChatFolderStore(async input => {
    const url = new URL(String(input), 'http://localhost');

    if (url.pathname === '/api/v1/session-folders') {
      return Response.json(FOLDERS_RESPONSE);
    }

    if (url.pathname === '/api/v1/sessions') {
      sessionRequests++;
      assert.equal(sessionRequests, 1, 'should only request sessions once');
      return Response.json({
        data: [
          { id: 'session-1', folder_id: 'folder-a' },
          { id: 'session-2', folder_id: 'folder-b' },
        ],
        pagination: {},
      });
    }

    throw new Error(`Unexpected request to ${url.pathname}`);
  });

  const result = await store.load();

  assert.deepEqual(result.folders, [FOLDER_A, FOLDER_B]);
  assert.equal(result.assignments.length, 2);
  assert.equal(sessionRequests, 1, 'should only request sessions once for single page');
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
