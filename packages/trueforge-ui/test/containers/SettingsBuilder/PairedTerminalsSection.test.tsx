// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  TerminalPairingProvider,
  type PairedTerminal,
  type TerminalPairingApi,
} from '@/components/TerminalPairingContext.js';
import PairedTerminalsSection from '@/containers/SettingsBuilder/PairedTerminalsSection.js';

const formatWhen = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const PIPPA: PairedTerminal = {
  id: 'key-pippa',
  device_name: 'Pippa',
  paired_at: '2026-11-14T09:15:00.000Z',
  last_used_at: '2026-11-15T08:02:00.000Z',
  revoked_at: null,
};

const OLD_TERMINAL: PairedTerminal = {
  id: 'key-old',
  device_name: "Nora's old laptop",
  paired_at: '2026-10-02T12:00:00.000Z',
  last_used_at: '2026-10-20T12:00:00.000Z',
  revoked_at: '2026-11-01T12:00:00.000Z',
};

function apiStub(overrides: Partial<TerminalPairingApi>): TerminalPairingApi {
  return {
    lookupPairing: vi.fn(async () => null),
    confirmPairing: vi.fn(async () => ({ device_name: 'Pippa', paired_at: PIPPA.paired_at })),
    listPairedTerminals: vi.fn(async () => [PIPPA]),
    revokePairedTerminal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderSection(api: TerminalPairingApi) {
  return render(
    <TerminalPairingProvider api={api}>
      <PairedTerminalsSection />
    </TerminalPairingProvider>,
  );
}

describe('PairedTerminalsSection', () => {
  it('lists each terminal with its name, when it paired and when it was last used', async () => {
    renderSection(apiStub({ listPairedTerminals: vi.fn(async () => [PIPPA, OLD_TERMINAL]) }));

    await waitFor(() => {
      expect(screen.getByText('Pippa')).toBeInTheDocument();
    });
    expect(screen.getByText(`Paired ${formatWhen.format(new Date(PIPPA.paired_at))}`)).toBeInTheDocument();
    expect(screen.getByText(`Last used ${formatWhen.format(new Date(PIPPA.last_used_at))}`)).toBeInTheDocument();
    expect(screen.getByText("Nora's old laptop")).toBeInTheDocument();
    expect(
      screen.getByText(`Revoked ${formatWhen.format(new Date(OLD_TERMINAL.revoked_at ?? ''))}`),
    ).toBeInTheDocument();
    // Only the live terminal can be revoked.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('says plainly that a paired terminal can answer approval cards', async () => {
    renderSection(apiStub({}));

    await waitFor(() => {
      expect(screen.getByText('Pippa')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/can reach your chats and answer approval cards in them, and nothing else/),
    ).toBeInTheDocument();
  });

  it('shows a plain empty state when no terminal is paired', async () => {
    renderSection(apiStub({ listPairedTerminals: vi.fn(async () => []) }));

    await waitFor(() => {
      expect(screen.getByText(/No terminal is paired yet/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('asks first when revoking, then takes the row off the list', async () => {
    const api = apiStub({});
    renderSection(api);

    await waitFor(() => {
      expect(screen.getByText('Pippa')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(screen.getByText(/Revoke this terminal\?/)).toBeInTheDocument();
    expect(api.revokePairedTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.queryByText('Pippa')).not.toBeInTheDocument();
    });
    expect(api.revokePairedTerminal).toHaveBeenCalledWith({ terminal_key_id: 'key-pippa' });
    expect(screen.getByText(/No terminal is paired yet/)).toBeInTheDocument();
  });

  it('keeps the row and shows a plain error when the revoke is refused', async () => {
    const api = apiStub({
      revokePairedTerminal: vi.fn(async () => {
        throw new Error('That terminal could not be revoked. Try again in a moment.');
      }),
    });
    renderSection(api);

    await waitFor(() => {
      expect(screen.getByText('Pippa')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('That terminal could not be revoked. Try again in a moment.');
    });
    expect(screen.getByText('Pippa')).toBeInTheDocument();
  });

  it('shows a plain error and a way to try again when the list cannot be loaded', async () => {
    const api = apiStub({
      listPairedTerminals: vi.fn(async () => {
        throw new Error('The paired terminals could not be loaded. Try again in a moment.');
      }),
    });
    renderSection(api);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The paired terminals could not be loaded. Try again in a moment.',
      );
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders nothing when the host offers no pairing surface', () => {
    const { container } = render(<PairedTerminalsSection />);
    expect(container.firstChild).toBeNull();
  });
});
