// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunCodeStatusProvider, type RunCodeStatus } from '@/components/RunCodeStatusContext.js';
import { SandboxWorkspacesProvider, type SandboxWorkspaceListing } from '@/components/SandboxWorkspacesContext.js';
import SandboxSettings from '@/containers/SettingsBuilder/SandboxSettings.js';
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

function serverWith(sandboxIsolation: unknown): AgentUIServer {
  return createMockAgentUIServer({
    getCapabilities: async () => ({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
        memoryScreen: { enabled: false },
        toolOutputScreen: { enabled: false },
        sandbox_isolation: sandboxIsolation,
      },
    }),
  });
}

function renderPage({
  getRunCodeStatus,
  sandboxIsolation = limits,
  listSandboxWorkspaces,
}: {
  getRunCodeStatus: () => Promise<RunCodeStatus>;
  sandboxIsolation?: unknown;
  listSandboxWorkspaces?: () => Promise<SandboxWorkspaceListing>;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerProvider server={serverWith(sandboxIsolation)}>
      <RunCodeStatusProvider api={{ getRunCodeStatus }}>
        {listSandboxWorkspaces === undefined ? (
          children
        ) : (
          <SandboxWorkspacesProvider api={{ listSandboxWorkspaces }}>{children}</SandboxWorkspacesProvider>
        )}
      </RunCodeStatusProvider>
    </ServerProvider>
  );
  return render(<SandboxSettings />, { wrapper });
}

/** The card under a heading, looked up fresh because the card is replaced as the check settles. */
function cardOf(name: string) {
  const card = screen.getByRole('heading', { name }).closest('section');
  if (card === null) {
    throw new Error(`Heading "${name}" is not inside a card`);
  }
  return within(card);
}

const STATES: Array<{ status: RunCodeStatus; headline: string; fix: RegExp | null; pill: string }> = [
  { status: { state: 'ready' }, headline: 'Code execution is on', fix: null, pill: 'Ready' },
  {
    status: { state: 'not_configured' },
    headline: 'Code execution is off: no sandbox image is configured',
    fix: /Ask whoever runs this server/,
    pill: 'Off',
  },
  {
    status: { state: 'docker_unavailable' },
    headline: 'Code execution is off: Docker is not available to the server',
    fix: /Docker socket/,
    pill: 'Off',
  },
  {
    status: { state: 'daemon_unavailable', detail: 'docker info failed' },
    headline: 'Code execution is off: Docker is not responding',
    fix: /Start or restart the Docker daemon/,
    pill: 'Off',
  },
  {
    status: { state: 'image_missing' },
    headline: 'Sandbox image not downloaded yet',
    fix: /run some code/,
    pill: 'Setting up',
  },
  {
    status: { state: 'signature_unverified', detail: 'cosign signature verification failed' },
    headline: "Code execution is off: the sandbox image's signature could not be verified",
    fix: /Restart the server with internet access/,
    pill: 'Off',
  },
  {
    status: { state: 'image_unavailable', detail: 'digest mismatch' },
    headline: 'Code execution is off: the sandbox image does not match this release',
    fix: /exact image for this release/,
    pill: 'Off',
  },
  {
    status: { state: 'isolation_refused', detail: 'canary refused' },
    headline: 'Code execution is off: the sandbox could not apply its safety limits',
    fix: /Update Docker/,
    pill: 'Off',
  },
  {
    status: { state: 'unsupported_platform', detail: 'needs Linux' },
    headline: "Code execution is off: this server's system is not supported",
    fix: /Run the server on Linux/,
    pill: 'Off',
  },
];

const SLOT_STATES: {
  status: RunCodeStatus;
  headline: string;
  fix: RegExp | undefined;
}[] = [
  { status: { state: 'ready', backend: 'slots' }, headline: 'Code execution is on', fix: undefined },
  {
    status: { state: 'slots_unavailable', backend: 'slots', detail: 'The sandbox slots are not running.' },
    headline: 'Code execution is off: the sandbox is not running',
    fix: /aman doctor sandbox --fix/,
  },
  {
    status: { state: 'isolation_refused', backend: 'slots', detail: 'apparmor: wrong profile' },
    headline: 'Code execution is off: the sandbox could not prove it is safe',
    fix: /aman doctor sandbox --fix/,
  },
  {
    status: { state: 'disabled', backend: 'slots' },
    headline: 'Code execution is off for this instance',
    fix: /Run `aman doctor sandbox --fix` on the computer where Aman is installed\. Then press Re-check\./,
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('SandboxSettings on the sandbox slots', () => {
  it.each(SLOT_STATES)(
    'words the $status.state state without Docker, images or signatures',
    async ({ status, headline, fix }) => {
      renderPage({ getRunCodeStatus: async () => status });

      await screen.findByText(headline);
      const page = document.body.textContent ?? '';
      expect(page).not.toMatch(/docker|image|signature/i);
      expect(screen.getByText(/isolated sandboxes with no network access/)).toBeInTheDocument();
      if (fix !== undefined) {
        expect(cardOf('Status').getByText(fix)).toBeInTheDocument();
      }
      expect(screen.queryByRole('heading', { name: 'Image' })).not.toBeInTheDocument();
    },
  );

  it('keeps the technical detail under Technical details', async () => {
    renderPage({
      getRunCodeStatus: async () => ({
        state: 'isolation_refused',
        backend: 'slots',
        detail: 'apparmor: wrong profile',
      }),
    });
    await screen.findByText('Code execution is off: the sandbox could not prove it is safe');
    expect(screen.getByText('apparmor: wrong profile')).toBeInTheDocument();
  });
});

describe('SandboxSettings', () => {
  it('names the page and says what the sandbox is for', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }) });

    expect(screen.getByRole('heading', { name: 'Sandbox' })).toBeInTheDocument();
    expect(screen.getByText(/isolated sandbox with no network access/)).toBeInTheDocument();
    await screen.findByText('Code execution is on');
    expect(screen.getByText(/isolated Docker container with no network access/)).toBeInTheDocument();
  });

  it.each(STATES)('explains the $status.state state in plain language', async ({ status, headline, fix, pill }) => {
    renderPage({ getRunCodeStatus: async () => status });

    await screen.findByText(headline);
    const card = cardOf('Status');
    expect(card.getByRole('status')).toHaveTextContent(pill);
    if (fix === null) {
      expect(card.queryByText('What to do')).not.toBeInTheDocument();
    } else {
      expect(card.getByText('What to do')).toBeInTheDocument();
      expect(card.getByText(fix)).toBeInTheDocument();
    }
    expect(card.getByText('Technical details')).toBeInTheDocument();
    if (status.detail === undefined) {
      expect(card.queryByText('Details:')).not.toBeInTheDocument();
    } else {
      expect(card.getByText(status.detail)).toBeInTheDocument();
    }
    expect(screen.queryByText(/unavailable\.$/)).not.toBeInTheDocument();
  });

  it('shows the short image name and the checks that follow from the state', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'signature_unverified', detail: 'bad signature' }) });

    await screen.findByRole('heading', { name: 'Image' });
    const image = cardOf('Image');
    expect(image.getByText('amanuensis-sandbox 0.1.0')).toBeInTheDocument();
    expect(image.queryByText(IMAGE)).not.toBeInTheDocument();
    expect(image.getByText('Downloaded')).toBeInTheDocument();
    expect(image.getByText('Not verified')).toBeInTheDocument();
    // The full reference with its digest lives under Technical details.
    expect(cardOf('Status').getByText(IMAGE)).toBeInTheDocument();
  });

  it.each(['docker_unavailable', 'daemon_unavailable', 'unsupported_platform'] as const)(
    'keeps only the version when %s makes the download and signature checks meaningless',
    async state => {
      renderPage({ getRunCodeStatus: async () => ({ state, detail: 'x' }) });

      await screen.findByRole('heading', { name: 'Image' });
      const image = cardOf('Image');
      expect(image.getByText('Version')).toBeInTheDocument();
      expect(image.queryByText('Download')).not.toBeInTheDocument();
      expect(image.queryByText('Signature')).not.toBeInTheDocument();
    },
  );

  it('says there is no image when the server has none configured', async () => {
    renderPage({
      getRunCodeStatus: async () => ({ state: 'not_configured' }),
      sandboxIsolation: { ...limits, image: '' },
    });

    await screen.findByRole('heading', { name: 'Image' });
    const image = cardOf('Image');
    expect(image.getByText('Not configured')).toBeInTheDocument();
    expect(image.queryByText('Version')).not.toBeInTheDocument();
  });

  it('keeps server setting names out of the advice and under Technical details', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'signature_unverified', detail: 'x' }) });

    await screen.findByText(/signature could not be verified/);
    const card = cardOf('Status');
    expect(card.getByText('What to do').parentElement).not.toHaveTextContent('SANDBOX_');
    expect(card.getByText('SANDBOX_COSIGN_PUBLIC_KEY_PATH')).toBeInTheDocument();
  });

  it('says when the status was last checked', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }) });

    expect(await screen.findByText('Last checked just now')).toBeInTheDocument();
  });

  it('ages the last-checked time as the clock moves on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }) });
    expect(await screen.findByText('Last checked just now')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(screen.getByText('Last checked 5 min ago')).toBeInTheDocument();
  });

  it('lists the limits that matter: time, memory, disk and network off', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }) });

    await screen.findByText('Code execution is on');
    const card = cardOf('Limits for each run');
    await waitFor(() => {
      expect(card.getByText('1 min by default, at most 10 min')).toBeInTheDocument();
    });
    expect(card.getByText('2 GB')).toBeInTheDocument();
    expect(card.getByText(/1 GB for files the code writes/)).toBeInTheDocument();
    expect(card.getByText(/Off\. Code cannot reach the internet/)).toBeInTheDocument();
  });

  it('keeps showing the status when the server did not report its limits', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }), sandboxIsolation: null });

    expect(await screen.findByText('Code execution is on')).toBeInTheDocument();
    expect(screen.getByText(/did not report its limits/)).toBeInTheDocument();
  });

  it('checks again when Re-check is pressed', async () => {
    const getRunCodeStatus = vi
      .fn<() => Promise<RunCodeStatus>>()
      .mockResolvedValueOnce({ state: 'docker_unavailable' })
      .mockResolvedValueOnce({ state: 'ready' });
    renderPage({ getRunCodeStatus });

    expect(await screen.findByText(/Docker is not available to the server/)).toBeInTheDocument();

    fireEvent.click(cardOf('Status').getByRole('button', { name: 'Re-check' }));

    expect(await screen.findByText('Code execution is on')).toBeInTheDocument();
    expect(getRunCodeStatus).toHaveBeenCalledTimes(2);
  });

  it('shows a clear error with a retry when the status cannot be fetched', async () => {
    const getRunCodeStatus = vi
      .fn<() => Promise<RunCodeStatus>>()
      .mockRejectedValueOnce(new Error('Request failed (502).'))
      .mockResolvedValueOnce({ state: 'ready' });
    renderPage({ getRunCodeStatus });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check the sandbox status');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The status check did not get an answer from the server. Nothing about the sandbox has changed. Try again in a moment.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('502');
    expect(cardOf('Status').getByText('Request failed (502).')).toBeInTheDocument();
    expect(screen.queryByText('Code execution is on')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Code execution is on')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says what it is doing while the first check runs', async () => {
    renderPage({ getRunCodeStatus: () => new Promise<RunCodeStatus>(() => {}) });

    expect(await screen.findByText(/Checking the sandbox\. This can take a few seconds/)).toBeInTheDocument();
  });

  it('no longer offers sandbox providers or a runtime upgrade', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }) });
    await screen.findByText('Code execution is on');

    expect(screen.queryByText(/provider/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
  });
});

describe('Chat workspaces card', () => {
  const slotsReady = async (): Promise<RunCodeStatus> => ({ state: 'ready', backend: 'slots' });

  it('lists the chats holding workspaces, with their slot, size and last use, and is honest about an orphan', async () => {
    renderPage({
      getRunCodeStatus: slotsReady,
      listSandboxWorkspaces: async () => ({
        slots: [{ slot: 1, workspace_count: 2, total_bytes: 6144, store_free_bytes: 1024 }],
        workspaces: [
          {
            holder: 'you',
            chat_id: 'chat-1',
            chat_title: 'Trip planning',
            chat_private: false,
            sandbox_id: `s1-${'a'.repeat(32)}`,
            slot: 1,
            bytes: 4096,
            entries: 12,
            last_used: '2026-11-01T10:00:00.000Z',
          },
          {
            holder: 'none',
            chat_id: null,
            chat_title: null,
            chat_private: false,
            sandbox_id: `s1-${'c'.repeat(32)}`,
            slot: 1,
            bytes: 2048,
            entries: 3,
            last_used: '2026-10-20T09:00:00.000Z',
          },
        ],
      }),
    });

    await screen.findByRole('heading', { name: 'Chat workspaces' });
    const card = cardOf('Chat workspaces');
    expect(await card.findByText('2 chat workspaces, 6 KB used, 1 KB of room left')).toBeInTheDocument();
    expect(card.getByText('Trip planning')).toBeInTheDocument();
    expect(card.getByText(/Slot 1 · 4 KB · Last used/)).toBeInTheDocument();
    expect(card.getByText('A workspace with no chat')).toBeInTheDocument();
    expect(card.getByText(/No chat on this server is linked to this workspace/)).toBeInTheDocument();
  });

  it('shows an untitled chat as untitled', async () => {
    renderPage({
      getRunCodeStatus: slotsReady,
      listSandboxWorkspaces: async () => ({
        slots: [{ slot: 2, workspace_count: 1, total_bytes: 1024, store_free_bytes: 2048 }],
        workspaces: [
          {
            holder: 'you',
            chat_id: 'chat-9',
            chat_title: null,
            chat_private: false,
            sandbox_id: `s2-${'b'.repeat(32)}`,
            slot: 2,
            bytes: 1024,
            entries: 1,
            last_used: '2026-11-02T08:00:00.000Z',
          },
        ],
      }),
    });

    await screen.findByRole('heading', { name: 'Chat workspaces' });
    const card = cardOf('Chat workspaces');
    expect(await card.findByText('1 chat workspace, 1 KB used, 2 KB of room left')).toBeInTheDocument();
    expect(card.getByText('Untitled chat')).toBeInTheDocument();
    expect(card.getByText(/Slot 2 · 1 KB · Last used/)).toBeInTheDocument();
  });

  it('shows your incognito chat as an incognito chat, without its title', async () => {
    renderPage({
      getRunCodeStatus: slotsReady,
      listSandboxWorkspaces: async () => ({
        slots: [{ slot: 1, workspace_count: 1, total_bytes: 1024, store_free_bytes: 2048 }],
        workspaces: [
          {
            holder: 'you',
            chat_id: 'chat-private',
            chat_title: null,
            chat_private: true,
            sandbox_id: `s1-${'e'.repeat(32)}`,
            slot: 1,
            bytes: 1024,
            entries: 1,
            last_used: '2026-11-02T08:00:00.000Z',
          },
        ],
      }),
    });

    await screen.findByRole('heading', { name: 'Chat workspaces' });
    const card = cardOf('Chat workspaces');
    expect(await card.findByText('Incognito chat')).toBeInTheDocument();
    expect(card.queryByText('Untitled chat')).not.toBeInTheDocument();
  });

  it("names another person's workspace without its chat title", async () => {
    renderPage({
      getRunCodeStatus: slotsReady,
      listSandboxWorkspaces: async () => ({
        slots: [{ slot: 1, workspace_count: 1, total_bytes: 1024, store_free_bytes: 2048 }],
        workspaces: [
          {
            holder: 'someone_else',
            chat_id: null,
            chat_title: null,
            chat_private: false,
            sandbox_id: `s1-${'d'.repeat(32)}`,
            slot: 1,
            bytes: 1024,
            entries: 2,
            last_used: '2026-11-02T08:00:00.000Z',
          },
        ],
      }),
    });

    await screen.findByRole('heading', { name: 'Chat workspaces' });
    const card = cardOf('Chat workspaces');
    expect(await card.findByText("Another person's chat")).toBeInTheDocument();
    expect(card.queryByText(/No chat on this server is linked/)).not.toBeInTheDocument();
  });

  it('has an honest empty state when no chat holds a workspace', async () => {
    renderPage({
      getRunCodeStatus: slotsReady,
      listSandboxWorkspaces: async () => ({
        slots: [{ slot: 1, workspace_count: 0, total_bytes: 0, store_free_bytes: 16 * 1024 ** 3 }],
        workspaces: [],
      }),
    });

    await screen.findByRole('heading', { name: 'Chat workspaces' });
    const card = cardOf('Chat workspaces');
    expect(await card.findByText('No chat workspaces, 16 GB of room left')).toBeInTheDocument();
    expect(card.getByText(/No chat holds a workspace right now/)).toBeInTheDocument();
  });

  it('says so, in the card, when the workspaces cannot be listed', async () => {
    renderPage({
      getRunCodeStatus: slotsReady,
      listSandboxWorkspaces: async () => {
        throw new Error('Request failed (500).');
      },
    });

    await screen.findByRole('heading', { name: 'Chat workspaces' });
    const card = cardOf('Chat workspaces');
    expect(await card.findByRole('alert')).toHaveTextContent('The chat workspaces could not be listed.');
  });

  it('stays hidden on the Docker backend', async () => {
    renderPage({
      getRunCodeStatus: async () => ({ state: 'ready' }),
      listSandboxWorkspaces: async () => ({ slots: [], workspaces: [] }),
    });

    await screen.findByText('Code execution is on');
    expect(screen.queryByRole('heading', { name: 'Chat workspaces' })).not.toBeInTheDocument();
  });
});
