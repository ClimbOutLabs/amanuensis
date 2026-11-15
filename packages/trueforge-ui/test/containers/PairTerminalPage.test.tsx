// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TerminalPairingProvider, type TerminalPairingApi } from '@/components/TerminalPairingContext.js';
import PairTerminalPage from '@/containers/PairTerminalPage.js';

const CODE = 'K7QX-42PD';
const REFUSAL_LINE =
  'That pairing code is not right, or it has expired. On the terminal, start pairing again and use the new code.';
const SIGN_IN_LINE = 'Sign in first, then open this link again.';

function apiStub(overrides: Partial<TerminalPairingApi>): TerminalPairingApi {
  return {
    confirmPairing: vi.fn(async () => ({ device_name: 'Pippa', paired_at: '2026-11-15T10:30:00.000Z' })),
    listPairedTerminals: vi.fn(async () => []),
    revokePairedTerminal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPage(api: TerminalPairingApi, code: string | null) {
  return render(
    <TerminalPairingProvider api={api}>
      <PairTerminalPage code={code} />
    </TerminalPairingProvider>,
  );
}

describe('PairTerminalPage', () => {
  it('shows the code from the link and pairs the terminal on confirm', async () => {
    const api = apiStub({});

    renderPage(api, CODE);

    expect(screen.getByRole('heading', { name: 'Pair a terminal' })).toBeInTheDocument();
    expect(screen.getByText(CODE)).toBeInTheDocument();
    expect(screen.queryByText('Pippa')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Terminal paired' })).toBeInTheDocument();
    });
    expect(api.confirmPairing).toHaveBeenCalledWith({ code: CODE });
    expect(screen.getByText(/Pippa is paired and ready to use/)).toBeInTheDocument();
    expect(screen.getByText(/You can close this page/)).toBeInTheDocument();
  });

  it('shows the server one refusal line when the code is refused, and never claims a pairing', async () => {
    const api = apiStub({
      confirmPairing: vi.fn(async () => {
        throw new Error(REFUSAL_LINE);
      }),
    });

    renderPage(api, CODE);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSAL_LINE);
    });
    expect(screen.queryByText(/is paired and ready to use/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Terminal paired' })).not.toBeInTheDocument();
  });

  it('shows the refusal as one line that does not say which of wrong, expired or used it was', async () => {
    const api = apiStub({
      confirmPairing: vi.fn(async () => {
        throw new Error(REFUSAL_LINE);
      }),
    });

    renderPage(api, CODE);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    // The one line covers every cause at once, so the page adds no guess of its own.
    expect(screen.getByRole('alert')).toHaveTextContent('not right, or it has expired');
    expect(screen.queryByText(/already used/)).not.toBeInTheDocument();
  });

  it('shows a plain line and no confirm button when the link carries no code', () => {
    const api = apiStub({});

    renderPage(api, null);

    expect(screen.getByText(/This link has no pairing code in it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm pairing' })).not.toBeInTheDocument();
    expect(api.confirmPairing).not.toHaveBeenCalled();
  });

  it('surfaces a sign-in refusal as a plain line instead of a pairing', async () => {
    const api = apiStub({
      confirmPairing: vi.fn(async () => {
        throw new Error(SIGN_IN_LINE);
      }),
    });

    renderPage(api, CODE);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(SIGN_IN_LINE);
    });
    expect(screen.queryByRole('heading', { name: 'Terminal paired' })).not.toBeInTheDocument();
  });
});
