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
  default_timeout_seconds: 60,
  max_timeout_seconds: 600,
  memory_mb: 2048,
  disk_mb: 1024,
  stdout_stderr_cap_kb: 256,
  network_egress: false,
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

const STATES: Array<{ status: RunCodeStatus; headline: string; fix: RegExp | null; pill: string }> = [
  { status: { state: 'ready' }, headline: 'Code execution is on', fix: null, pill: 'Ready' },
  {
    status: { state: 'not_configured' },
    headline: 'Code execution is off: the sandbox is not set up',
    fix: /aman doctor sandbox --fix/,
    pill: 'Off',
  },
  {
    status: { state: 'slots_unavailable', detail: 'The sandbox slots are not running.' },
    headline: 'Code execution is off: the sandbox is not running',
    fix: /aman doctor sandbox --fix/,
    pill: 'Off',
  },
  {
    status: { state: 'daemon_unavailable', detail: 'agent unreachable' },
    headline: 'Code execution is off: the sandbox is not running',
    fix: /aman doctor sandbox --fix/,
    pill: 'Off',
  },
  {
    status: { state: 'isolation_refused', detail: 'apparmor: wrong profile' },
    headline: 'Code execution is off: the sandbox could not prove it is safe',
    fix: /aman doctor sandbox --fix/,
    pill: 'Off',
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('SandboxSettings', () => {
  it('names the page and says what the sandbox is for', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'ready' }) });

    expect(screen.getByRole('heading', { name: 'Sandbox' })).toBeInTheDocument();
    expect(screen.getByText(/isolated sandboxes with no network access/)).toBeInTheDocument();
    await screen.findByText('Code execution is on');
    expect(document.body.textContent ?? '').not.toMatch(/docker|image|signature/i);
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

  it('shows no image card and keeps server setting names out of the advice', async () => {
    renderPage({ getRunCodeStatus: async () => ({ state: 'not_configured' }) });

    await screen.findByText(/the sandbox is not set up/);
    expect(screen.queryByRole('heading', { name: 'Image' })).not.toBeInTheDocument();
    const card = cardOf('Status');
    expect(card.getByText('What to do').parentElement).not.toHaveTextContent('SANDBOX_');
    expect(card.getByText('SANDBOX_BACKEND')).toBeInTheDocument();
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
      .mockResolvedValueOnce({ state: 'slots_unavailable' })
      .mockResolvedValueOnce({ state: 'ready' });
    renderPage({ getRunCodeStatus });

    expect(await screen.findByText(/the sandbox is not running/)).toBeInTheDocument();

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
