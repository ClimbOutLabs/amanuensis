/**
 * Read-only GitHub lookups for the "Work on a repo" picker. These run on the
 * host with the person's GitHub connector token when one is available, and
 * without a token for public repos. Nothing here writes to GitHub.
 */

export const MAX_GITHUB_REPOSITORY_SIZE_KB = 100 * 1024;

export interface GithubRepositoryOption {
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string | null;
  size_kb: number;
  private: boolean;
}

export interface GithubRepositoryDetails extends GithubRepositoryOption {
  branches: string[];
}

export type GithubLookupErrorKind = 'not_found' | 'unauthorized' | 'unavailable';

export class GithubLookupError extends Error {
  readonly kind: GithubLookupErrorKind;

  constructor(kind: GithubLookupErrorKind, options?: ErrorOptions) {
    super(
      kind === 'not_found'
        ? 'That repo could not be found on GitHub. Check the address, and if the repo is private, connect GitHub under Connectors and try again.'
        : kind === 'unauthorized'
          ? 'GitHub did not accept the sign-in for this chat. Reconnect GitHub under Connectors, then try again.'
          : 'GitHub could not be reached. Check your connection, then try again.',
      options,
    );
    this.name = 'GithubLookupError';
    this.kind = kind;
  }
}

/** Parses a github.com clone address into owner and repo; anything else is refused. */
export function parseGithubCloneUrl(cloneUrl: string): { owner: string; repo: string } | undefined {
  let url: URL;
  try {
    url = new URL(cloneUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    return undefined;
  }
  const parts = url.pathname.split('/').filter(part => part.length > 0);
  if (parts.length !== 2) {
    return undefined;
  }
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, '');
  if (owner === undefined || repo === undefined || repo.length === 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo === '..') {
    return undefined;
  }
  return { owner, repo };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repositoryOption(value: unknown): GithubRepositoryOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const {
    name,
    full_name: fullName,
    clone_url: cloneUrl,
    default_branch: defaultBranch,
    size,
    private: isPrivate,
  } = value;
  if (
    typeof name !== 'string' ||
    typeof fullName !== 'string' ||
    typeof cloneUrl !== 'string' ||
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    typeof isPrivate !== 'boolean'
  ) {
    return undefined;
  }
  return {
    name,
    full_name: fullName,
    clone_url: cloneUrl,
    default_branch: typeof defaultBranch === 'string' && defaultBranch.length > 0 ? defaultBranch : null,
    size_kb: size,
    private: isPrivate,
  };
}

async function githubJson(input: { path: string; token: string | null; fetchImpl: typeof fetch }): Promise<unknown> {
  let response: Response;
  try {
    response = await input.fetchImpl(`https://api.github.com${input.path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'amanuensis',
        'x-github-api-version': '2022-11-28',
        ...(input.token === null ? {} : { authorization: `Bearer ${input.token}` }),
      },
    });
  } catch (error) {
    throw new GithubLookupError('unavailable', { cause: error });
  }
  if (response.status === 404) {
    throw new GithubLookupError('not_found');
  }
  if (response.status === 401 || response.status === 403) {
    throw new GithubLookupError('unauthorized');
  }
  if (!response.ok) {
    throw new GithubLookupError('unavailable');
  }
  try {
    return await response.json();
  } catch (error) {
    throw new GithubLookupError('unavailable', { cause: error });
  }
}

/** Lists the repos the token owner can see, most recently updated first. */
export async function listGithubRepositories(input: {
  token: string;
  fetchImpl: typeof fetch;
}): Promise<GithubRepositoryOption[]> {
  const body = await githubJson({
    path: '/user/repos?per_page=100&sort=updated',
    token: input.token,
    fetchImpl: input.fetchImpl,
  });
  if (!Array.isArray(body)) {
    throw new GithubLookupError('unavailable');
  }
  const options: GithubRepositoryOption[] = [];
  for (const item of body) {
    const option = repositoryOption(item);
    if (option !== undefined) {
      options.push(option);
    }
  }
  return options;
}

/** Reads one repo's details and branch names, for the picker and the size check. */
export async function getGithubRepositoryDetails(input: {
  owner: string;
  repo: string;
  token: string | null;
  fetchImpl: typeof fetch;
}): Promise<GithubRepositoryDetails> {
  const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const repoBody = await githubJson({ path: base, token: input.token, fetchImpl: input.fetchImpl });
  const option = repositoryOption(repoBody);
  if (option === undefined) {
    throw new GithubLookupError('unavailable');
  }
  const branchesBody = await githubJson({
    path: `${base}/branches?per_page=100`,
    token: input.token,
    fetchImpl: input.fetchImpl,
  });
  if (!Array.isArray(branchesBody)) {
    throw new GithubLookupError('unavailable');
  }
  const branches: string[] = [];
  for (const item of branchesBody) {
    if (isRecord(item) && typeof item['name'] === 'string') {
      branches.push(item['name']);
    }
  }
  return { ...option, branches };
}
