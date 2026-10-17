// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunCodeStatusProvider, type RunCodeStatus } from '@/components/RunCodeStatusContext.js';
import SandboxSettings from '@/containers/SettingsBuilder/SandboxSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

const limits = {
  isolation_driver: 'docker',
  image: 'ghcr.io/climboutlabs/amanuensis-sandbox:0.1.0@sha256:' + 'a'.repeat(64),
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
}: {
  getRunCodeStatus: () => Promise<RunCodeStatus>;
  sandboxIsolation?: unknown;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerProvider server={serverWith(sandboxIsolation)}>
      <RunCodeStatusProvider api={{ getRunCodeStatus }}>{children}</RunCodeStatusProvider>
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

const SENTENCE =
  "Code Aman writes runs in a sealed sandbox with no internet access, a fresh one for every run. If the sandbox isn't available, code doesn't run.";
const FIX = /aman doctor sandbox --fix/;

const SLOT_STATES: {
  status: RunCodeStatus;
  headline: string;
  fix: RegExp | undefined;
  pill: string;
}[] = [
  { status: { state: 'ready', backend: 'slots' }, headline: 'Sealed sandbox: ready', fix: undefined, pill: 'Ready' },
  {
    status: { state: 'slots_unavailable', backend: 'slots', detail: 'The sandbox slots are not running.' },
    headline: 'Sealed sandbox: not running',
    fix: FIX,
    pill: 'Off',
  },
  {
    status: { state: 'isolation_refused', backend: 'slots', detail: 'apparmor: wrong profile' },
    headline: 'Sealed sandbox: failed its safety check',
    fix: FIX,
    pill: 'Off',
  },
];

const LEGACY_STATES = [
  'not_configured',
  'docker_unavailable',
  'daemon_unavailable',
  'image_missing',
  'signature_unverified',
  'image_unavailable',
  'isolation_refused',
  'unsupported_platform',
] as const;

const JARGON = /docker|daemon|socket|seccomp|signature|image|cosign|tier \d/i;

afterEach(() => {
  vi.useRealTimers();
});

describe('SandboxSettings', () => {
  it('opens with the one sentence about the sandbox', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready', backend: 'slots' }) });

    expect(screen.getByRole('heading', { name: 'Sandbox' })).toBeInTheDocument();
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    await screen.findByText('Sealed sandbox: ready');
  });

  it.each(SLOT_STATES)('words the $status.state state in plain language', async ({ status, headline, fix, pill }) => {
    renderPage({ getRunCodeStatus: async () => status });

    await screen.findByText(headline);
    const card = cardOf('Status');
    expect(card.getByRole('status')).toHaveTextContent(pill);
    const visible = (document.body.textContent ?? '').replace(
      card.getByText('Technical details').parentElement?.textContent ?? '',
      '',
    );
    expect(visible).not.toMatch(JARGON);
    if (fix === undefined) {
      expect(card.queryByText('What to do')).not.toBeInTheDocument();
    } else {
      expect(card.getByText('What to do')).toBeInTheDocument();
      expect(card.getByText(fix)).toBeInTheDocument();
    }
    expect(screen.queryByRole('heading', { name: 'Image' })).not.toBeInTheDocument();
  });

  it.each(LEGACY_STATES)('words the developer-only %s state without Docker terms', async state => {
    renderPage({ getRunCodeStatus: async () => ({ state, backend: 'docker', detail: 'x' }) });

    await screen.findByText('Sealed sandbox: not ready');
    const card = cardOf('Status');
    expect(card.getByText(FIX)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Image' })).not.toBeInTheDocument();
    expect(card.getByRole('status')).toHaveTextContent('Off');
    const advice = card.getByText('What to do').parentElement;
    expect(advice?.textContent).not.toMatch(JARGON);
    expect(card.getByText('Technical details')).toBeInTheDocument();
  });

  it('keeps the technical detail under Technical details', async () => {
    renderPage({
      getRunCodeStatus: async () => ({
        state: 'isolation_refused',
        backend: 'slots',
        detail: 'apparmor: wrong profile',
      }),
    });
    await screen.findByText('Sealed sandbox: failed its safety check');
    expect(screen.getByText('apparmor: wrong profile')).toBeInTheDocument();
  });

  it('says when the status was last checked', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready', backend: 'slots' }) });

    expect(await screen.findByText('Last checked just now')).toBeInTheDocument();
  });

  it('ages the last-checked time as the clock moves on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready', backend: 'slots' }) });
    expect(await screen.findByText('Last checked just now')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(screen.getByText('Last checked 5 min ago')).toBeInTheDocument();
  });

  it('lists the limits that matter: time, memory, disk and network off', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready', backend: 'slots' }) });

    await screen.findByText('Sealed sandbox: ready');
    const card = cardOf('Limits for each run');
    await waitFor(() => {
      expect(card.getByText('1 min by default, at most 10 min')).toBeInTheDocument();
    });
    expect(card.getByText('2 GB')).toBeInTheDocument();
    expect(card.getByText(/1 GB for files the code writes/)).toBeInTheDocument();
    expect(card.getByText(/Off\. Code cannot reach the internet/)).toBeInTheDocument();
  });

  it('keeps showing the status when the server did not report its limits', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready', backend: 'slots' }), sandboxIsolation: null });

    expect(await screen.findByText('Sealed sandbox: ready')).toBeInTheDocument();
    expect(screen.getByText(/did not report its limits/)).toBeInTheDocument();
  });

  it('checks again when Re-check is pressed', async () => {
    const getRunCodeStatus = vi
      .fn<() => Promise<RunCodeStatus>>()
      .mockResolvedValueOnce({ state: 'slots_unavailable', backend: 'slots' })
      .mockResolvedValueOnce({ state: 'ready', backend: 'slots' });
    renderPage({ getRunCodeStatus });

    expect(await screen.findByText('Sealed sandbox: not running')).toBeInTheDocument();

    fireEvent.click(cardOf('Status').getByRole('button', { name: 'Re-check' }));

    expect(await screen.findByText('Sealed sandbox: ready')).toBeInTheDocument();
    expect(getRunCodeStatus).toHaveBeenCalledTimes(2);
  });

  it('shows a clear error with a retry when the status cannot be fetched', async () => {
    const getRunCodeStatus = vi
      .fn<() => Promise<RunCodeStatus>>()
      .mockRejectedValueOnce(new Error('Request failed (502).'))
      .mockResolvedValueOnce({ state: 'ready', backend: 'slots' });
    renderPage({ getRunCodeStatus });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check the sandbox status');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The status check did not get an answer from the server. Nothing about the sandbox has changed. Try again in a moment.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('502');
    expect(cardOf('Status').getByText('Request failed (502).')).toBeInTheDocument();
    expect(screen.queryByText('Sealed sandbox: ready')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Sealed sandbox: ready')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says what it is doing while the first check runs', async () => {
    renderPage({ getRunCodeStatus: () => new Promise<RunCodeStatus>(() => {}) });

    expect(await screen.findByText(/Checking the sandbox\. This can take a few seconds/)).toBeInTheDocument();
  });

  it('no longer offers sandbox providers or a runtime upgrade', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready', backend: 'slots' }) });
    await screen.findByText('Sealed sandbox: ready');

    expect(screen.queryByText(/provider/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
  });
});
