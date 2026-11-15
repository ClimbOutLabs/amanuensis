// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LocalAccountProvider, type LocalAccountApi } from '@/components/LocalAccountContext.js';
import {
  TerminalPairingProvider,
  type PairedTerminal,
  type TerminalPairingApi,
} from '@/components/TerminalPairingContext.js';
import AccountSettings from '@/containers/SettingsBuilder/AccountSettings.js';

const PIPPA: PairedTerminal = {
  id: 'key-pippa',
  device_name: 'Pippa',
  paired_at: '2026-11-14T09:15:00.000Z',
  last_used_at: '2026-11-15T08:02:00.000Z',
  revoked_at: null,
};

const accountStub: LocalAccountApi = {
  changePassword: vi.fn(async () => undefined),
};

function pairingStub(): TerminalPairingApi {
  return {
    confirmPairing: vi.fn(async () => ({ device_name: 'Pippa', paired_at: PIPPA.paired_at })),
    listPairedTerminals: vi.fn(async () => [PIPPA]),
    revokePairedTerminal: vi.fn(async () => undefined),
  };
}

describe('AccountSettings', () => {
  it('shows the password card and the paired terminals card when the host offers both', async () => {
    render(
      <LocalAccountProvider api={accountStub}>
        <TerminalPairingProvider api={pairingStub()}>
          <AccountSettings />
        </TerminalPairingProvider>
      </LocalAccountProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Paired terminals' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Pippa')).toBeInTheDocument();
    });
  });

  it('shows the paired terminals card without the password card when there is no local account', async () => {
    render(
      <TerminalPairingProvider api={pairingStub()}>
        <AccountSettings />
      </TerminalPairingProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Paired terminals' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change password' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Pippa')).toBeInTheDocument();
    });
  });

  it('renders nothing when the host offers neither surface', () => {
    const { container } = render(<AccountSettings />);
    expect(container.firstChild).toBeNull();
  });
});
