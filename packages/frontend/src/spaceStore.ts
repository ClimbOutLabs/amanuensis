import type { Space, SpaceStore } from '@truefoundry/trueforge-ui';

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

export function createSpaceStore(fetcher: typeof fetch): SpaceStore {
  return {
    async list() {
      return readSpaceList(await readJson(await fetcher('/api/v1/spaces')));
    },

    async get({ spaceId }) {
      return readSpaceEnvelope(await readJson(await fetcher(`/api/v1/spaces/${encodeURIComponent(spaceId)}`)));
    },

    async delete({ spaceId, expectedRevision }) {
      const query = new URLSearchParams({ expected_revision: String(expectedRevision) });
      await readEmpty(
        await fetcher(`/api/v1/spaces/${encodeURIComponent(spaceId)}?${query.toString()}`, { method: 'DELETE' }),
      );
    },
  };
}
