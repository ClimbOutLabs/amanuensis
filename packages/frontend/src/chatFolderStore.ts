import type { ChatFolder, ChatFolderStore } from '@truefoundry/trueforge-ui';

interface SessionWire {
  id: string;
  folder_id: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with HTTP ${String(response.status)}`);
  }
  return response.json();
}

function readFolders(value: unknown): ChatFolder[] {
  if (!isRecord(value) || !('data' in value) || !isUnknownArray(value.data)) {
    throw new Error('Server returned an invalid chat-folder response');
  }
  return value.data.map(item => {
    if (
      !isRecord(item) ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      !('name' in item) ||
      typeof item.name !== 'string'
    ) {
      throw new Error('Server returned an invalid chat folder');
    }
    return { id: item.id, name: item.name };
  });
}

function readFolder(value: unknown): ChatFolder {
  const folders = readFolders(isRecord(value) && 'data' in value ? { data: [value.data] } : value);
  const folder = folders[0];
  if (folder === undefined) {
    throw new Error('Server did not return the chat folder');
  }
  return folder;
}

function readSessionPage(value: unknown): { sessions: SessionWire[]; nextPageToken?: string } {
  if (!isRecord(value) || !('data' in value) || !isUnknownArray(value.data)) {
    throw new Error('Server returned an invalid session page');
  }
  const sessions = value.data.map(item => {
    if (
      !isRecord(item) ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      !('folder_id' in item) ||
      (item.folder_id !== null && typeof item.folder_id !== 'string')
    ) {
      throw new Error('Server returned invalid chat folder metadata');
    }
    return { id: item.id, folder_id: item.folder_id };
  });
  const pagination = isRecord(value) && 'pagination' in value ? value.pagination : undefined;
  if (!isRecord(pagination) || !('next_page_token' in pagination)) {
    return { sessions };
  }
  const token = pagination.next_page_token;
  return typeof token === 'string' ? { sessions, nextPageToken: token } : { sessions };
}

export function createChatFolderStore(fetcher: typeof fetch): ChatFolderStore {
  const jsonHeaders = { 'content-type': 'application/json' };
  return {
    async load() {
      const folders = readFolders(await readJson(await fetcher('/api/v1/session-folders')));
      const assignments: { sessionId: string; folderId: string }[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ limit: '100', order: 'desc' });
        if (pageToken !== undefined) {
          query.set('page_token', pageToken);
        }
        const page = readSessionPage(await readJson(await fetcher(`/api/v1/sessions?${query.toString()}`)));
        for (const session of page.sessions) {
          if (session.folder_id !== null) {
            assignments.push({ sessionId: session.id, folderId: session.folder_id });
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return { folders, assignments };
    },

    async createFolder({ name }) {
      return readFolder(
        await readJson(
          await fetcher('/api/v1/session-folders', {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ name }),
          }),
        ),
      );
    },

    async renameFolder({ folderId, name }) {
      return readFolder(
        await readJson(
          await fetcher(`/api/v1/session-folders/${encodeURIComponent(folderId)}`, {
            method: 'PUT',
            headers: jsonHeaders,
            body: JSON.stringify({ name }),
          }),
        ),
      );
    },

    async deleteFolder({ folderId }) {
      await readJson(await fetcher(`/api/v1/session-folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }));
    },

    async setSessionFolder({ sessionId, folderId }) {
      const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/folder`;
      if (folderId === null) {
        await readJson(await fetcher(path, { method: 'DELETE' }));
        return;
      }
      await readJson(
        await fetcher(path, {
          method: 'PUT',
          headers: jsonHeaders,
          body: JSON.stringify({ folder_id: folderId }),
        }),
      );
    },
  };
}
