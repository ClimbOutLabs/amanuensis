// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  RepositoryWorkProvider,
  type RepositorySummary,
  type RepositoryWorkApi,
} from '@/components/RepositoryWorkContext.js';
import { RunCodeStatusProvider, type RunCodeStatus } from '@/components/RunCodeStatusContext.js';
import SandboxSettings from '@/containers/SettingsBuilder/SandboxSettings.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelUserSettings } from '@/sentinel/types.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

const IMAGE = 'ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@sha256:' + 'a'.repeat(64);

const limits = {
  isolation_driver: 'docker',
  image: IMAGE,
  default_timeout_seconds: 60,
  max_timeout_seconds: 600,
  memory_mb: 2048,
  disk_mb: 1024,
  stdout_stderr_cap_kb: 256,
  image_pull_timeout_seconds: 600,
  network_egress: false,
  cosign_key_configured: true,
};

const repository: RepositorySummary = {
  id: 'repo-1',
  name: 'demo-repo',
  clone_url: 'https://github.com/octo-example/demo-repo.git',
  default_branch: 'main',
  revision: 1,
  package_downloads_allowed: false,
};

const settingsOff: SentinelUserSettings = {
  offline_mode: false,
  tier2_auto_allow: [],
  search_without_asking: true,
  maps_without_asking: true,
  sandbox_without_asking: true,
  package_downloads_without_project_allowed: false,
};

function server(): AgentUIServer {
  return createMockAgentUIServer({
    getCapabilities: async () => ({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
        memoryScreen: { enabled: false },
        toolOutputScreen: { enabled: false },
        sandbox_isolation: limits,
      },
    }),
  });
}

function renderPage(input: {
  repositoryApi: RepositoryWorkApi;
  sentinelApi: SentinelApi;
  getRunCodeStatus?: () => Promise<RunCodeStatus>;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerProvider server={server()}>
      <RunCodeStatusProvider
        api={{ getRunCodeStatus: input.getRunCodeStatus ?? (async () => ({ state: 'ready' as const })) }}
      >
        <RepositoryWorkProvider api={input.repositoryApi}>
          <SentinelApiProvider api={input.sentinelApi}>{children}</SentinelApiProvider>
        </RepositoryWorkProvider>
      </RunCodeStatusProvider>
    </ServerProvider>
  );
  return render(<SandboxSettings />, { wrapper });
}

function repositoryApi(): RepositoryWorkApi {
  return {
    listGithubRepositories: vi.fn().mockResolvedValue([]),
    getGithubRepository: vi.fn().mockRejectedValue(new Error('not used')),
    startRepositoryWork: vi.fn().mockRejectedValue(new Error('not used')),
    getSessionRepository: vi.fn().mockResolvedValue({ session_id: 's', repository_id: null, workspace_cwd: null }),
    getRepository: vi.fn().mockResolvedValue(repository),
    listRepositories: vi.fn().mockResolvedValue([repository]),
    setRepositoryPackageDownloads: vi
      .fn()
      .mockImplementation((change: { allowed: boolean }) =>
        Promise.resolve({ ...repository, package_downloads_allowed: change.allowed }),
      ),
    listCommandProposals: vi.fn().mockResolvedValue([]),
    confirmCommandProposal: vi.fn().mockResolvedValue(undefined),
    dismissCommandProposal: vi.fn().mockResolvedValue(undefined),
    unbindSessionRepository: vi.fn().mockResolvedValue(undefined),
  };
}

function sentinelApi(settings: SentinelUserSettings) {
  const updateUserSettings = vi.fn(async (patch: Partial<SentinelUserSettings>) => ({ ...settings, ...patch }));
  const api: SentinelApi = {
    listAuditEntries: vi.fn(async () => []),
    listBriefItemCompletions: async () => [],
    markBriefItemDone: async () => undefined,
    unmarkBriefItemDone: async () => undefined,
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings,
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
  return { api, updateUserSettings };
}

function card() {
  const section = screen.getByRole('heading', { name: 'Package downloads' }).closest('section');
  if (section === null) {
    throw new Error('The Package downloads heading is not inside a card');
  }
  return within(section);
}

describe('the Package downloads card in Settings, Sandbox', () => {
  it('lists each project and the chats without a project, saying the allowance covers scheduled runs', async () => {
    const { api } = sentinelApi(settingsOff);
    renderPage({ repositoryApi: repositoryApi(), sentinelApi: api });

    const downloads = card();
    expect(await downloads.findByText('demo-repo')).toBeTruthy();
    expect(downloads.getByText('Chats without a project')).toBeTruthy();
    expect(downloads.getByText(/also covers scheduled runs/)).toBeTruthy();
    expect(downloads.getByRole('switch', { name: 'Package downloads for demo-repo' })).toBeTruthy();
    expect(downloads.getByRole('switch', { name: 'Package downloads in chats without a project' })).toBeTruthy();
  });

  it('saves a project switch through the repositories API', async () => {
    const api = repositoryApi();
    const { api: sentinel } = sentinelApi(settingsOff);
    renderPage({ repositoryApi: api, sentinelApi: sentinel });

    const toggle = await card().findByRole('switch', { name: 'Package downloads for demo-repo' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.setRepositoryPackageDownloads).toHaveBeenCalledWith({ repositoryId: 'repo-1', allowed: true });
    });
  });

  it('saves the chats-without-a-project switch through the settings API', async () => {
    const { api, updateUserSettings } = sentinelApi(settingsOff);
    renderPage({ repositoryApi: repositoryApi(), sentinelApi: api });

    const toggle = await card().findByRole('switch', { name: 'Package downloads in chats without a project' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateUserSettings).toHaveBeenCalledWith({ package_downloads_without_project_allowed: true });
    });
  });

  it('shows the switch on when the allowance is on', async () => {
    const { api } = sentinelApi({ ...settingsOff, package_downloads_without_project_allowed: true });
    renderPage({ repositoryApi: repositoryApi(), sentinelApi: api });

    const toggle = await card().findByRole('switch', { name: 'Package downloads in chats without a project' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
