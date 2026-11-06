import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRepositoryWorkApi } from '../src/repositoryWorkApi';

type Captured = { url?: string; method?: string; body?: string };

function fetcherReturning(data: unknown, capture: Captured, status = 200): typeof fetch {
  const fetcher: typeof fetch = async (url, init) => {
    capture.url = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    capture.method = init?.method ?? 'GET';
    capture.body = typeof init?.body === 'string' ? init.body : undefined;
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };
  return fetcher;
}

const repoData = {
  id: 'repo-1',
  name: 'demo-repo',
  clone_url: 'https://github.com/octo-example/demo-repo.git',
  default_branch: 'main',
  revision: 3,
  package_downloads_allowed: true,
  created_at: '2026-10-18T00:00:00.000Z',
  updated_at: '2026-10-18T00:00:00.000Z',
};

test('lists GitHub repos for the chat and parses the picker fields', async () => {
  const capture: Captured = {};
  const api = createRepositoryWorkApi(
    fetcherReturning(
      {
        data: {
          repositories: [
            {
              name: 'demo-repo',
              full_name: 'octo-example/demo-repo',
              clone_url: 'https://github.com/octo-example/demo-repo.git',
              default_branch: 'main',
              size_kb: 2048,
              private: true,
            },
          ],
        },
      },
      capture,
    ),
  );
  const repos = await api.listGithubRepositories('session-1');
  assert.equal(capture.url, '/api/v1/sessions/session-1/repository/github-repositories');
  assert.deepEqual(repos, [
    {
      name: 'demo-repo',
      full_name: 'octo-example/demo-repo',
      clone_url: 'https://github.com/octo-example/demo-repo.git',
      default_branch: 'main',
      size_kb: 2048,
      private: true,
    },
  ]);
});

test('looks up a public repo without a session and a private one with a session', async () => {
  const details = {
    name: 'demo-repo',
    full_name: 'octo-example/demo-repo',
    clone_url: 'https://github.com/octo-example/demo-repo.git',
    default_branch: 'main',
    size_kb: 2048,
    private: false,
    branches: ['main', 'dev'],
  };
  const publicCapture: Captured = {};
  const publicApi = createRepositoryWorkApi(fetcherReturning({ data: details }, publicCapture));
  const found = await publicApi.getGithubRepository({
    sessionId: null,
    cloneUrl: 'https://github.com/octo-example/demo-repo',
  });
  assert.equal(
    publicCapture.url,
    '/api/v1/repositories/github/metadata?clone_url=https%3A%2F%2Fgithub.com%2Focto-example%2Fdemo-repo',
  );
  assert.deepEqual(found.branches, ['main', 'dev']);

  const sessionCapture: Captured = {};
  const sessionApi = createRepositoryWorkApi(fetcherReturning({ data: details }, sessionCapture));
  await sessionApi.getGithubRepository({ sessionId: 'session-1', cloneUrl: details.clone_url });
  assert.equal(
    sessionCapture.url,
    '/api/v1/sessions/session-1/repository/github-repository?clone_url=https%3A%2F%2Fgithub.com%2Focto-example%2Fdemo-repo.git',
  );
});

test('start work posts the clone address and branch and parses the binding', async () => {
  const capture: Captured = {};
  const api = createRepositoryWorkApi(
    fetcherReturning(
      {
        data: {
          session_id: 'session-1',
          repository_id: 'repo-1',
          workspace_cwd: '/workspace/demo-repo',
          branch: 'dev',
          repository: repoData,
        },
      },
      capture,
    ),
  );
  const started = await api.startRepositoryWork({
    sessionId: 'session-1',
    cloneUrl: 'https://github.com/octo-example/demo-repo',
    branch: 'dev',
  });
  assert.equal(capture.url, '/api/v1/sessions/session-1/repository/start-work');
  assert.equal(capture.method, 'POST');
  assert.deepEqual(JSON.parse(capture.body ?? '{}'), {
    clone_url: 'https://github.com/octo-example/demo-repo',
    branch: 'dev',
  });
  assert.equal(started.workspace_cwd, '/workspace/demo-repo');
  assert.equal(started.branch, 'dev');
  assert.deepEqual(started.repository, {
    id: 'repo-1',
    name: 'demo-repo',
    clone_url: 'https://github.com/octo-example/demo-repo.git',
    default_branch: 'main',
    revision: 3,
    package_downloads_allowed: true,
  });
});

test('lists repositories and sets package downloads for one', async () => {
  const listCapture: Captured = {};
  const listApi = createRepositoryWorkApi(fetcherReturning({ data: [repoData] }, listCapture));
  const listed = await listApi.listRepositories();
  assert.equal(listCapture.url, '/api/v1/repositories');
  assert.equal(listed[0]?.package_downloads_allowed, true);

  const setCapture: Captured = {};
  const setApi = createRepositoryWorkApi(
    fetcherReturning({ data: { ...repoData, package_downloads_allowed: false } }, setCapture),
  );
  const saved = await setApi.setRepositoryPackageDownloads({ repositoryId: 'repo-1', allowed: false });
  assert.equal(setCapture.url, '/api/v1/repositories/repo-1/package-downloads');
  assert.equal(setCapture.method, 'POST');
  assert.deepEqual(JSON.parse(setCapture.body ?? '{}'), { allowed: false });
  assert.equal(saved.package_downloads_allowed, false);
});

test('reads the binding, proposals, confirms with wire names, dismisses and unbinds', async () => {
  const bindingCapture: Captured = {};
  const bindingApi = createRepositoryWorkApi(
    fetcherReturning(
      { data: { session_id: 'session-1', repository_id: 'repo-1', workspace_cwd: '/workspace/demo-repo' } },
      bindingCapture,
    ),
  );
  assert.deepEqual(await bindingApi.getSessionRepository('session-1'), {
    session_id: 'session-1',
    repository_id: 'repo-1',
    workspace_cwd: '/workspace/demo-repo',
  });
  assert.equal(bindingCapture.url, '/api/v1/sessions/session-1/repository');

  const proposalsCapture: Captured = {};
  const proposalsApi = createRepositoryWorkApi(
    fetcherReturning(
      {
        data: {
          proposals: [
            {
              id: 'proposal-1',
              purpose: 'test',
              command: 'pnpm test',
              source_kind: 'pyproject_toml',
              source_path: 'pyproject.toml',
              source_fingerprint: 'sha256:fixture',
              created_at: '2026-10-18T00:00:00.000Z',
            },
          ],
          repository_revision: 3,
        },
      },
      proposalsCapture,
    ),
  );
  assert.deepEqual(await proposalsApi.listCommandProposals('repo-1'), [
    {
      id: 'proposal-1',
      purpose: 'test',
      command: 'pnpm test',
      source_kind: 'pyproject_toml',
      source_path: 'pyproject.toml',
    },
  ]);
  assert.equal(proposalsCapture.url, '/api/v1/repositories/repo-1/command-proposals');

  const confirmCapture: Captured = {};
  const confirmApi = createRepositoryWorkApi(
    fetcherReturning({ data: { command_id: 'test', repository_revision: 4 } }, confirmCapture),
  );
  await confirmApi.confirmCommandProposal({
    repositoryId: 'repo-1',
    proposalId: 'proposal-1',
    commandId: 'test',
    timeoutMs: 900_000,
  });
  assert.equal(confirmCapture.url, '/api/v1/repositories/repo-1/command-proposals/proposal-1/confirm');
  assert.deepEqual(JSON.parse(confirmCapture.body ?? '{}'), { command_id: 'test', timeout_ms: 900_000 });

  const dismissCapture: Captured = {};
  const dismissApi = createRepositoryWorkApi(fetcherReturning({}, dismissCapture));
  await dismissApi.dismissCommandProposal({ repositoryId: 'repo-1', proposalId: 'proposal-1' });
  assert.equal(dismissCapture.url, '/api/v1/repositories/repo-1/command-proposals/proposal-1');
  assert.equal(dismissCapture.method, 'DELETE');

  const unbindCapture: Captured = {};
  const unbindApi = createRepositoryWorkApi(
    fetcherReturning({ data: { session_id: 'session-1', repository_id: null, workspace_cwd: null } }, unbindCapture),
  );
  await unbindApi.unbindSessionRepository('session-1');
  assert.equal(unbindCapture.url, '/api/v1/sessions/session-1/repository');
  assert.equal(unbindCapture.method, 'DELETE');
});

test('stopping work on a repo succeeds when the server answers with an empty reply', async () => {
  const capture: Captured = {};
  const emptyFetcher: typeof fetch = async (url, init) => {
    capture.url = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    capture.method = init?.method ?? 'GET';
    return new Response(null, { status: 200 });
  };
  const api = createRepositoryWorkApi(emptyFetcher);
  await api.unbindSessionRepository('session-1');
  assert.equal(capture.url, '/api/v1/sessions/session-1/repository');
  assert.equal(capture.method, 'DELETE');
});

test('surfaces the server plain error message', async () => {
  const api = createRepositoryWorkApi(
    fetcherReturning({ error: { message: 'Connect GitHub first, under Connectors.' } }, {}, 422),
  );
  await assert.rejects(api.listGithubRepositories('session-1'), /Connect GitHub first, under Connectors\./);
});
