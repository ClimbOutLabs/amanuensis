// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GoogleSetupPanel from '@/containers/SettingsBuilder/GoogleSetupPanel.js';
import type { GoogleConnectionStatus, GoogleSetupPort } from '@/server/googleSetup.js';

// jsdom does not implement <dialog>.showModal()/close(); CenteredModal calls both.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  if (originalShowModal === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  else Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  if (originalClose === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  else Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  vi.restoreAllMocks();
});

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-synthetic-secret-value';
const PASTE_SETUP = { mode: 'paste', client_type: 'desktop', redirect_uri: 'http://127.0.0.1:53682/callback' } as const;
const WEB_SETUP = {
  mode: 'web',
  client_type: 'web',
  redirect_uri: 'https://aman.example.org/api/v1/user/settings/google/oauth/callback',
} as const;

function statusOf(overrides: Partial<GoogleConnectionStatus> = {}): GoogleConnectionStatus {
  return {
    state: 'not_connected',
    account_email: null,
    features: [
      { feature: 'gmail_read', label: 'Read and search your email', granted: false },
      { feature: 'gmail_compose', label: 'Save drafts and send email you approve', granted: false },
    ],
    has_saved_client: false,
    setup: PASTE_SETUP,
    ...overrides,
  };
}

function connectedStatus(overrides: Partial<GoogleConnectionStatus> = {}): GoogleConnectionStatus {
  return statusOf({
    state: 'connected',
    account_email: 'ada@example.com',
    has_saved_client: true,
    features: [
      { feature: 'gmail_read', label: 'Read and search your email', granted: true },
      { feature: 'gmail_compose', label: 'Save drafts and send email you approve', granted: false },
    ],
    ...overrides,
  });
}

function makePort(overrides: Partial<GoogleSetupPort> = {}) {
  const begin = vi.fn<GoogleSetupPort['beginGoogleConsent']>(async () => ({
    authorization_url: 'https://accounts.example.test/auth',
    setup: PASTE_SETUP,
  }));
  const complete = vi.fn<GoogleSetupPort['completeGoogleConsent']>(async () => connectedStatus());
  const port: GoogleSetupPort = {
    getGoogleStatus: async () => statusOf(),
    checkGoogleClient: async () => ({ ok: true, problems: [] }),
    beginGoogleConsent: begin,
    completeGoogleConsent: complete,
    testGoogleConnection: async () => ({ result: 'ok', account_email: 'ada@example.com' }),
    disconnectGoogle: async () => ({ disconnected: true }),
    ...overrides,
  };
  return { port, begin, complete };
}

function renderPanel(port: GoogleSetupPort, onChanged = vi.fn()) {
  render(<GoogleSetupPanel open onOpenChange={() => undefined} port={port} onChanged={onChanged} />);
  return { onChanged };
}

function fillClient() {
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: CLIENT_ID } });
  fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: CLIENT_SECRET } });
}

describe('GoogleSetupPanel', () => {
  it('guides a Desktop client with a copy control for each string typed into the Google console', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel(makePort().port);

    expect(await screen.findByLabelText('Gmail API link')).toBeInTheDocument();
    expect(screen.getByText(/set the publishing status to Production/)).toBeInTheDocument();
    expect(screen.getByLabelText('Application type')).toHaveTextContent('Desktop app');
    expect(screen.queryByLabelText('Redirect URI')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Gmail API link' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    });
  });

  it('guides a Web client with the exact public callback when the install has a public https address', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel(makePort({ getGoogleStatus: async () => statusOf({ setup: WEB_SETUP }) }).port);

    expect(await screen.findByLabelText('Application type')).toHaveTextContent('Web application');
    expect(screen.getByLabelText('Redirect URI')).toHaveTextContent(WEB_SETUP.redirect_uri);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Redirect URI' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(WEB_SETUP.redirect_uri);
    });
  });

  it('names the unverified-app screen before consent', async () => {
    renderPanel(makePort().port);
    expect(await screen.findByText(/has not verified this app/)).toBeInTheDocument();
  });

  it('reads a dropped client JSON locally', async () => {
    renderPanel(makePort().port);
    await screen.findByLabelText('Client ID');
    const json = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    const file = new File([json], 'client.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => json });
    fireEvent.change(screen.getByLabelText('Or choose the downloaded client JSON'), { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByLabelText('Client ID')).toHaveValue(CLIENT_ID);
    });
  });

  it('rejects a file that is not a Google client file', async () => {
    renderPanel(makePort().port);
    await screen.findByLabelText('Client ID');
    const file = new File(['{"hello":1}'], 'x.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{"hello":1}' });
    fireEvent.change(screen.getByLabelText('Or choose the downloaded client JSON'), { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not a Google OAuth client file');
  });

  it('shows each problem the client check finds in plain language', async () => {
    renderPanel(
      makePort({
        checkGoogleClient: async () => ({
          ok: false,
          problems: [
            {
              code: 'wrong_client_type',
              message: 'This is a Web application client, but this install needs a Desktop app.',
            },
          ],
        }),
      }).port,
    );
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Check my client' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a Desktop app');
  });

  it('asks for read access by default and adds drafts and sending only when ticked', async () => {
    const { port, begin } = makePort();
    renderPanel(port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
    expect(begin.mock.calls[0]?.[0]).toMatchObject({
      client: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      features: ['gmail_read'],
    });
    expect(window.open).toHaveBeenCalledWith('https://accounts.example.test/auth', '_blank', 'noopener');
  });

  it('asks for both features when drafts and sending are ticked', async () => {
    const { port, begin } = makePort();
    renderPanel(port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByLabelText(/Also let Aman save drafts and send email/));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
    expect(begin.mock.calls[0]?.[0].features).toEqual(['gmail_read', 'gmail_compose']);
  });

  it('never keeps the secret after consent starts', async () => {
    renderPanel(makePort().port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await screen.findByText('Finish in the Google window');
    expect(screen.queryByDisplayValue(CLIENT_SECRET)).not.toBeInTheDocument();
  });

  it('sends the whole pasted address and shows Connected', async () => {
    const { port, complete } = makePort();
    const { onChanged } = renderPanel(port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    const address = 'http://127.0.0.1:53682/callback?state=s&code=c';
    fireEvent.change(await screen.findByLabelText('Address from the browser bar'), { target: { value: address } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith({ address }));
    expect(await screen.findByRole('status')).toHaveTextContent('Google is connected.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the server message when the pasted address is refused', async () => {
    renderPanel(
      makePort({
        completeGoogleConsent: async () => {
          throw new Error('That address has no code or state in it.');
        },
      }).port,
    );
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    fireEvent.change(await screen.findByLabelText('Address from the browser bar'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no code or state');
  });

  it('waits by itself instead of asking for a paste when the browser returns to this server', async () => {
    renderPanel(
      makePort({
        beginGoogleConsent: async () => ({
          authorization_url: 'https://accounts.example.test/auth',
          setup: { ...PASTE_SETUP, mode: 'loopback' },
        }),
      }).port,
    );
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(await screen.findByText(/This panel updates by itself/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Address from the browser bar')).not.toBeInTheDocument();
  });

  it('shows the account and what is on, and offers drafts and sending once', async () => {
    const { port, begin } = makePort({ getGoogleStatus: async () => connectedStatus() });
    renderPanel(port);
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Read and search your email: on/)).toBeInTheDocument();
    expect(screen.getByText(/Save drafts and send email you approve: off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow drafts and sending' }));
    await waitFor(() => expect(begin).toHaveBeenCalledWith({ client: null, features: ['gmail_compose'] }));
  });

  it('says plainly that Google needs reconnecting and reconnects with the saved client and granted features', async () => {
    const { port, begin } = makePort({ getGoogleStatus: async () => connectedStatus({ state: 'needs_reconnect' }) });
    renderPanel(port);
    expect(await screen.findByText('Google needs to be connected again')).toBeInTheDocument();
    expect(screen.getByText(/still in Testing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(begin).toHaveBeenCalledWith({ client: null, features: ['gmail_read'] }));
  });

  it('reports a test result in plain words', async () => {
    renderPanel(makePort({ getGoogleStatus: async () => connectedStatus() }).port);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Working. Connected as ada@example.com/)).toBeInTheDocument();
  });

  it('asks before disconnecting and keeps the login when Google cannot confirm', async () => {
    const disconnectGoogle = vi.fn(async () => ({ disconnected: false }));
    renderPanel(makePort({ getGoogleStatus: async () => connectedStatus(), disconnectGoogle }).port);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('everywhere it is used');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was removed here');
  });

  it('writes no em dashes', async () => {
    const { container } = render(
      <GoogleSetupPanel open onOpenChange={() => undefined} port={makePort().port} onChanged={() => undefined} />,
    );
    await screen.findByLabelText('Client ID');
    expect(container.textContent).not.toContain('—');
    expect(document.body.textContent).not.toContain('—');
  });
});
