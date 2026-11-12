import type { Space, SpaceFolder, SpaceStore } from '@truefoundry/trueforge-ui';

const SPACE_STATUSES = new Set(['active', 'archived']);
const SPACE_FORMATS = new Set(['markdown', 'html']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with HTTP ${String(response.status)}`);
  }
  return response.json();
}

function deleteUrl({ spaceId, expectedRevision }: { spaceId: string; expectedRevision: number }): string {
  const query = new URLSearchParams({ expected_revision: String(expectedRevision) });
  return `/api/v1/spaces/${encodeURIComponent(spaceId)}?${query.toString()}`;
}

async function readEmpty(response: Response): Promise<void> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with HTTP ${String(response.status)}`);
  }
}

function readSpace(value: unknown): Space {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.purpose !== 'string' ||
    typeof value.status !== 'string' ||
    !SPACE_STATUSES.has(value.status) ||
    typeof value.body !== 'string' ||
    (value.format !== undefined && (typeof value.format !== 'string' || !SPACE_FORMATS.has(value.format))) ||
    (value.folder_id !== null && typeof value.folder_id !== 'string') ||
    typeof value.revision !== 'number' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string'
  ) {
    throw new Error('Server returned an invalid space');
  }
  return {
    id: value.id,
    name: value.name,
    purpose: value.purpose,
    status: value.status === 'archived' ? 'archived' : 'active',
    body: value.body,
    format: value.format === 'html' ? 'html' : 'markdown',
    folder_id: value.folder_id,
    revision: value.revision,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function readSpaceList(value: unknown): Space[] {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.spaces)) {
    throw new Error('Server returned an invalid space list');
  }
  return value.data.spaces.map(readSpace);
}

function readSpaceEnvelope(value: unknown): Space {
  if (!isRecord(value) || !('data' in value)) {
    throw new Error('Server returned an invalid space response');
  }
  return readSpace(value.data);
}

function readFolder(value: unknown): SpaceFolder {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    throw new Error('Server returned an invalid space folder');
  }
  return { id: value.id, name: value.name };
}

function readFolderList(value: unknown): SpaceFolder[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Server returned an invalid space folder list');
  }
  return value.data.map(readFolder);
}

function readFolderEnvelope(value: unknown): SpaceFolder {
  if (!isRecord(value) || !('data' in value)) {
    throw new Error('Server returned an invalid space folder response');
  }
  return readFolder(value.data);
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function createSpaceStore(fetcher: typeof fetch): SpaceStore {
  return {
    async list() {
      return readSpaceList(await readJson(await fetcher('/api/v1/spaces')));
    },

    async get({ spaceId }) {
      return readSpaceEnvelope(await readJson(await fetcher(`/api/v1/spaces/${encodeURIComponent(spaceId)}`)));
    },

    async delete({ spaceId, expectedRevision }) {
      const first = await fetcher(deleteUrl({ spaceId, expectedRevision }), { method: 'DELETE' });
      if (first.status !== 409) {
        await readEmpty(first);
        return;
      }
      // The revision the view held went stale between the last list load and this delete (the
      // model may have updated the space while it was open). Refresh the revision once and retry
      // with it before surfacing the conflict; a second 409 (or any other failure) surfaces as-is.
      const fresh = readSpaceEnvelope(await readJson(await fetcher(`/api/v1/spaces/${encodeURIComponent(spaceId)}`)));
      await readEmpty(await fetcher(deleteUrl({ spaceId, expectedRevision: fresh.revision }), { method: 'DELETE' }));
    },

    async listFolders() {
      return readFolderList(await readJson(await fetcher('/api/v1/space-folders')));
    },

    async createFolder({ name }) {
      return readFolderEnvelope(
        await readJson(
          await fetcher('/api/v1/space-folders', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ name }),
          }),
        ),
      );
    },

    async renameFolder({ folderId, name }) {
      return readFolderEnvelope(
        await readJson(
          await fetcher(`/api/v1/space-folders/${encodeURIComponent(folderId)}`, {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ name }),
          }),
        ),
      );
    },

    async deleteFolder({ folderId }) {
      await readEmpty(await fetcher(`/api/v1/space-folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }));
    },

    async setSpaceFolder({ spaceId, folderId }) {
      const path = `/api/v1/spaces/${encodeURIComponent(spaceId)}/folder`;
      if (folderId === null) {
        await readEmpty(await fetcher(path, { method: 'DELETE' }));
        return;
      }
      await readEmpty(
        await fetcher(path, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ folder_id: folderId }) }),
      );
    },
  };
}
