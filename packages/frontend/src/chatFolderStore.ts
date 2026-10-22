import type { ChatFolder, ChatFolderSession, ChatFolderStore } from '@truefoundry/trueforge-ui';

interface SessionWire {
  id: string;
  folder_id: string | null;
  title: string | null;
  updated_at: string;
  agentName: string | null;
  isMutable: boolean;
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

function readSessionAgent(value: unknown): { agentName: string | null; isMutable: boolean } {
  if (!isRecord(value) || !('type' in value) || typeof value.type !== 'string') {
    throw new Error('Server returned an invalid chat folder session');
  }
  if (value.type === 'inline') {
    return { agentName: null, isMutable: true };
  }
  if (value.type === 'reference') {
    const name = 'name' in value ? value.name : undefined;
    if (name !== null && typeof name !== 'string') {
      throw new Error('Server returned an invalid chat folder session');
    }
    return { agentName: name, isMutable: false };
  }
  throw new Error('Server returned an invalid chat folder session');
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
      (item.folder_id !== null && typeof item.folder_id !== 'string') ||
      !('title' in item) ||
      (item.title !== null && typeof item.title !== 'string') ||
      !('updated_at' in item) ||
      typeof item.updated_at !== 'string' ||
      !('agent' in item)
    ) {
      throw new Error('Server returned invalid chat folder metadata');
    }
    const agent = readSessionAgent(item.agent);
    return {
      id: item.id,
      folder_id: item.folder_id,
      title: item.title,
      updated_at: item.updated_at,
      agentName: agent.agentName,
      isMutable: agent.isMutable,
    };
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
  // Server enforces max limit of 25 on session list queries (PAGE_LIMIT in trueforge/src/schemas/common.ts)
  const SESSION_LIST_PAGE_LIMIT = 25;

  async function listAllSessions(filter: { folder_id: string } | { no_folder: string }): Promise<SessionWire[]> {
    const sessions: SessionWire[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        ...filter,
        limit: String(SESSION_LIST_PAGE_LIMIT),
        order: 'desc',
      });
      if (pageToken !== undefined) {
        query.set('page_token', pageToken);
      }
      const page = readSessionPage(await readJson(await fetcher(`/api/v1/sessions?${query.toString()}`)));
      sessions.push(...page.sessions);
      pageToken = page.nextPageToken;
      if (pageToken !== undefined) {
        if (seenPageTokens.has(pageToken)) {
          throw new Error('Server returned an invalid session page');
        }
        seenPageTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return sessions;
  }

  function toFolderSession(session: SessionWire): ChatFolderSession {
    return {
      sessionId: session.id,
      title: session.title,
      updatedAt: new Date(session.updated_at),
      agentName: session.agentName,
      isMutable: session.isMutable,
    };
  }

  return {
    async load() {
      const folders = readFolders(await readJson(await fetcher('/api/v1/session-folders')));
      const assignments: { sessionId: string; folderId: string }[] = [];
      const folderSessions: { folderId: string; sessions: ChatFolderSession[] }[] = [];
      // Each folder's chats come from the server by folder, so a folder is complete
      // no matter how far the recent chats list has been scrolled.
      for (const folder of folders) {
        const sessions: ChatFolderSession[] = [];
        for (const session of await listAllSessions({ folder_id: folder.id })) {
          assignments.push({ sessionId: session.id, folderId: folder.id });
          sessions.push(toFolderSession(session));
        }
        folderSessions.push({ folderId: folder.id, sessions });
      }
      // Chats with no folder come from their own query for the same reason: the
      // recent chats list only covers its loaded pages.
      const unfiledSessions = (await listAllSessions({ no_folder: 'true' })).map(toFolderSession);
      return { folders, assignments, folderSessions, unfiledSessions };
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
