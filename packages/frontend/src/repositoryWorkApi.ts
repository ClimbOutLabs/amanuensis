import type {
  GithubRepositoryDetails,
  GithubRepositoryOption,
  RepositoryCommandProposal,
  RepositorySummary,
  RepositoryWorkApi,
  SessionRepositoryBinding,
  StartRepositoryWorkResult,
} from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Repository response is missing ${field}. Reload the page and try again.`);
  }
  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return parseString(value, field);
}

function parseNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Repository response is missing ${field}. Reload the page and try again.`);
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Repository response is missing ${field}. Reload the page and try again.`);
  }
  return value;
}

function parseRepository(value: unknown): RepositorySummary {
  if (!isRecord(value)) {
    throw new Error('Repository response is not readable. Reload the page and try again.');
  }
  return {
    id: parseString(value.id, 'id'),
    name: parseString(value.name, 'name'),
    clone_url: parseString(value.clone_url, 'clone_url'),
    default_branch: parseNullableString(value.default_branch, 'default_branch'),
    revision: parseNumber(value.revision, 'revision'),
  };
}

function parseGithubOption(value: unknown): GithubRepositoryOption {
  if (!isRecord(value)) {
    throw new Error('GitHub response is not readable. Reload the page and try again.');
  }
  return {
    name: parseString(value.name, 'name'),
    full_name: parseString(value.full_name, 'full_name'),
    clone_url: parseString(value.clone_url, 'clone_url'),
    default_branch: parseNullableString(value.default_branch, 'default_branch'),
    size_kb: parseNumber(value.size_kb, 'size_kb'),
    private: parseBoolean(value.private, 'private'),
  };
}

function parseGithubDetails(value: unknown): GithubRepositoryDetails {
  if (!isRecord(value)) {
    throw new Error('GitHub response is not readable. Reload the page and try again.');
  }
  const branches = value.branches;
  if (!Array.isArray(branches) || branches.some(branch => typeof branch !== 'string')) {
    throw new Error('GitHub response is missing branches. Reload the page and try again.');
  }
  return { ...parseGithubOption(value), branches };
}

function parseProposal(value: unknown): RepositoryCommandProposal {
  if (!isRecord(value)) {
    throw new Error('Command proposal response is not readable. Reload the page and try again.');
  }
  const purpose = value.purpose;
  if (purpose !== 'build' && purpose !== 'test' && purpose !== 'verify') {
    throw new Error('Command proposal response has an unknown purpose. Reload the page and try again.');
  }
  return {
    id: parseString(value.id, 'id'),
    purpose,
    command: parseString(value.command, 'command'),
    source_kind: parseString(value.source_kind, 'source_kind'),
    source_path: parseString(value.source_path, 'source_path'),
  };
}

export function createRepositoryWorkApi(fetcher: typeof fetch): RepositoryWorkApi {
  async function parseData(responsePromise: Promise<Response>): Promise<unknown> {
    const response = await responsePromise;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
        throw new Error(body.error.message);
      }
      throw new Error('Aman could not reach the repository service. Try again.');
    }
    if (!isRecord(body) || !('data' in body)) {
      throw new Error('Repository response is not readable. Reload the page and try again.');
    }
    return body.data;
  }

  /** For endpoints that answer with an empty body on success, like dismissing a proposal. */
  async function parseOk(responsePromise: Promise<Response>): Promise<void> {
    const response = await responsePromise;
    if (response.ok) {
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
      throw new Error(body.error.message);
    }
    throw new Error('Aman could not reach the repository service. Try again.');
  }

  function jsonInit(method: string, payload: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
  }

  return {
    async listGithubRepositories(sessionId) {
      const data = await parseData(
        fetcher(apiPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/repository/github-repositories`)),
      );
      if (!isRecord(data) || !Array.isArray(data.repositories)) {
        throw new Error('GitHub response is not readable. Reload the page and try again.');
      }
      return data.repositories.map(parseGithubOption);
    },

    async getGithubRepository({ sessionId, cloneUrl }) {
      const query = `?clone_url=${encodeURIComponent(cloneUrl)}`;
      const path =
        sessionId === null
          ? `/api/v1/repositories/github/metadata${query}`
          : `/api/v1/sessions/${encodeURIComponent(sessionId)}/repository/github-repository${query}`;
      return parseGithubDetails(await parseData(fetcher(apiPath(path))));
    },

    async startRepositoryWork({ sessionId, cloneUrl, branch }) {
      const data = await parseData(
        fetcher(
          apiPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/repository/start-work`),
          jsonInit('POST', { clone_url: cloneUrl, branch }),
        ),
      );
      if (!isRecord(data)) {
        throw new Error('Repository response is not readable. Reload the page and try again.');
      }
      return {
        session_id: parseString(data.session_id, 'session_id'),
        repository_id: parseString(data.repository_id, 'repository_id'),
        workspace_cwd: parseString(data.workspace_cwd, 'workspace_cwd'),
        branch: parseString(data.branch, 'branch'),
        repository: parseRepository(data.repository),
      } satisfies StartRepositoryWorkResult;
    },

    async getSessionRepository(sessionId) {
      const data = await parseData(fetcher(apiPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/repository`)));
      if (!isRecord(data)) {
        throw new Error('Repository response is not readable. Reload the page and try again.');
      }
      const binding: SessionRepositoryBinding = {
        session_id: parseString(data.session_id, 'session_id'),
        repository_id: parseNullableString(data.repository_id, 'repository_id'),
        workspace_cwd: parseNullableString(data.workspace_cwd, 'workspace_cwd'),
      };
      return binding;
    },

    async getRepository(repositoryId) {
      return parseRepository(
        await parseData(fetcher(apiPath(`/api/v1/repositories/${encodeURIComponent(repositoryId)}`))),
      );
    },

    async listCommandProposals(repositoryId) {
      const data = await parseData(
        fetcher(apiPath(`/api/v1/repositories/${encodeURIComponent(repositoryId)}/command-proposals`)),
      );
      if (!isRecord(data) || !Array.isArray(data.proposals)) {
        throw new Error('Command proposal response is not readable. Reload the page and try again.');
      }
      return data.proposals.map(parseProposal);
    },

    async confirmCommandProposal({ repositoryId, proposalId, commandId, timeoutMs }) {
      await parseData(
        fetcher(
          apiPath(
            `/api/v1/repositories/${encodeURIComponent(repositoryId)}/command-proposals/${encodeURIComponent(proposalId)}/confirm`,
          ),
          jsonInit('POST', { command_id: commandId, timeout_ms: timeoutMs }),
        ),
      );
    },

    async dismissCommandProposal({ repositoryId, proposalId }) {
      await parseOk(
        fetcher(
          apiPath(
            `/api/v1/repositories/${encodeURIComponent(repositoryId)}/command-proposals/${encodeURIComponent(proposalId)}`,
          ),
          { method: 'DELETE' },
        ),
      );
    },

    async unbindSessionRepository(sessionId) {
      await parseData(
        fetcher(apiPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/repository`), { method: 'DELETE' }),
      );
    },
  };
}
