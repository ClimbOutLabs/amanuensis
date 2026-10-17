// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GoogleSetupPanel from '@/containers/SettingsBuilder/GoogleSetupPanel.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi } from '@/sentinel/types.js';
import type { GoogleConnectionStatus, GoogleSetupPort } from '@/server/googleSetup.js';

// jsdom does not implement <dialog>.showModal()/close(); CenteredModal calls both.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

/** A stand-in for the tab the panel opens: a window whose location, opener and close the test can read. */
function makeTab() {
  const fake: Window = Object.create(window);
  Object.defineProperty(fake, 'location', { value: { href: '' } });
  Object.defineProperty(fake, 'opener', { value: 'original', writable: true });
  Object.defineProperty(fake, 'close', { value: vi.fn() });
  return fake;
}

let tab = makeTab();

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
  tab = makeTab();
  vi.spyOn(window, 'open').mockImplementation(() => tab);
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
const PASTE_SETUP = { mode: 'paste', clientType: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' } as const;
const WEB_SETUP = {
  mode: 'web',
  clientType: 'web',
  redirectUri: 'https://aman.example.org/api/v1/user/settings/google/oauth/callback',
} as const;

function statusOf(overrides: Partial<GoogleConnectionStatus> = {}): GoogleConnectionStatus {
  return {
    state: 'not_connected',
    accountEmail: null,
    features: [
      { feature: 'gmail_read', label: 'Read and search your email', granted: false },
      { feature: 'gmail_compose', label: 'Save drafts and send email you approve', granted: false },
    ],
    hasSavedClient: false,
    locked: false,
    setup: PASTE_SETUP,
    ...overrides,
  };
}

function connectedStatus(overrides: Partial<GoogleConnectionStatus> = {}): GoogleConnectionStatus {
  return statusOf({
    state: 'connected',
    accountEmail: 'ada@example.com',
    hasSavedClient: true,
    features: [
      { feature: 'gmail_read', label: 'Read and search your email', granted: true },
      { feature: 'gmail_compose', label: 'Save drafts and send email you approve', granted: false },
    ],
    ...overrides,
  });
}

function makePort(overrides: Partial<GoogleSetupPort> = {}) {
  const begin = vi.fn<GoogleSetupPort['beginGoogleConsent']>(async () => ({
    authorizationUrl: 'https://accounts.example.test/auth',
    setup: PASTE_SETUP,
  }));
  const complete = vi.fn<GoogleSetupPort['completeGoogleConsent']>(async () => connectedStatus());
  const port: GoogleSetupPort = {
    getGoogleStatus: async () => statusOf(),
    checkGoogleClient: async () => ({ ok: true, problems: [] }),
    beginGoogleConsent: begin,
    completeGoogleConsent: complete,
    testGoogleConnection: async () => ({ result: 'ok', accountEmail: 'ada@example.com' }),
    disconnectGoogle: async () => ({ revocationConfirmed: true }),
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
    expect(screen.getByText('On the page, click Enable.')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Testing \(what you have now\): nothing more to do\. Google asks you to sign in again every 7 days\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/For application type, choose Desktop app\./)).toBeInTheDocument();
    expect(screen.getByText('Click Create, then Download JSON.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Application type')).not.toBeInTheDocument();
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

    expect(await screen.findByText(/For application type, choose Web application\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Redirect URI')).toHaveTextContent(WEB_SETUP.redirectUri);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Redirect URI' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(WEB_SETUP.redirectUri);
    });
  });

  it('names the unverified-app screen before consent', async () => {
    renderPanel(makePort().port);
    expect(await screen.findByText(/Google will say it hasn't verified this app/)).toBeInTheDocument();
    expect(screen.getByText(/Click Advanced, then Go to your app, then Continue/)).toBeInTheDocument();
    expect(screen.getByText(/allow pop-ups for this site/)).toBeInTheDocument();
  });

  it('says the client secret goes to Aman once and is never shown again', async () => {
    renderPanel(makePort().port);
    expect(
      await screen.findByText('Your client secret goes to Aman once, to start sign-in, and is never shown again.'),
    ).toBeInTheDocument();
  });

  it('explains why the buttons are disabled until a client is entered', async () => {
    renderPanel(makePort().port);
    await screen.findByLabelText('Client ID');
    expect(screen.getByRole('button', { name: 'Connect Google' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check my client' })).toBeDisabled();
    expect(screen.getAllByText('Add your client ID and secret first.')).toHaveLength(2);
    fillClient();
    expect(screen.queryByText('Add your client ID and secret first.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Google' })).toBeEnabled();
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That file isn't the sign-in file from Google Cloud. Download it again from the client you created.",
    );
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
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('https://accounts.example.test/auth');
    expect(tab.opener).toBeNull();
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
    fireEvent.change(await screen.findByLabelText('Address from the address bar'), { target: { value: address } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith({ address }));
    expect(await screen.findByRole('status')).toHaveTextContent('Google is connected.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('takes the pasted address in a plain text field, tells the user the failed page is expected, and offers a link', async () => {
    renderPanel(makePort().port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    const field = await screen.findByLabelText('Address from the address bar');
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.getByText(/This site can't be reached/)).toBeInTheDocument();
    expect(screen.getByText(/That's expected\./)).toBeInTheDocument();
    expect(screen.getByText(/Select All, then Copy, so you get the whole address/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'open Google sign-in here' });
    expect(link).toHaveAttribute('href', 'https://accounts.example.test/auth');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('button', { name: 'Finish connecting' })).toBeDisabled();
    expect(screen.getByText('Paste the address first.')).toBeInTheDocument();
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
    fireEvent.change(await screen.findByLabelText('Address from the address bar'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no code or state');
  });

  it('waits by itself instead of asking for a paste when the browser returns to this server', async () => {
    renderPanel(
      makePort({
        beginGoogleConsent: async () => ({
          authorizationUrl: 'https://accounts.example.test/auth',
          setup: { ...PASTE_SETUP, mode: 'loopback' },
        }),
      }).port,
    );
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(await screen.findByText(/This panel updates by itself/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Address from the address bar')).not.toBeInTheDocument();
  });

  it('shows the account and what is on, and offers drafts and sending once', async () => {
    const { port, begin } = makePort({ getGoogleStatus: async () => connectedStatus() });
    renderPanel(port);
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Read and search your email: allowed/)).toBeInTheDocument();
    expect(screen.getByText(/Save drafts and send email you approve: not allowed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow drafts and sending' }));
    await waitFor(() => expect(begin).toHaveBeenCalledWith({ client: null, features: ['gmail_compose'] }));
  });

  it('says plainly that Google needs reconnecting and reconnects with the saved client and granted features', async () => {
    const { port, begin } = makePort({ getGoogleStatus: async () => connectedStatus({ state: 'needs_reconnect' }) });
    renderPanel(port);
    expect(await screen.findByText('Reconnect needed')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Google sign-in expired\. Mail is paused, and other parts of Aman keep working\. Select Reconnect to sign in again\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/open Audience and choose Publish app, then reconnect once\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(begin).toHaveBeenCalledWith({ client: null, features: ['gmail_read'] }));
  });

  it('reports a test result in plain words', async () => {
    renderPanel(makePort({ getGoogleStatus: async () => connectedStatus() }).port);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Working. Connected as ada@example.com/)).toBeInTheDocument();
  });

  it('asks before disconnecting, and says when Google did not confirm that the connection is gone here anyway', async () => {
    const disconnectGoogle = vi.fn(async () => ({ revocationConfirmed: false }));
    let connected = true;
    const { port } = makePort({
      getGoogleStatus: async () => (connected ? connectedStatus() : statusOf()),
      disconnectGoogle: async () => {
        connected = false;
        return disconnectGoogle();
      },
    });
    const { onChanged } = renderPanel(port);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('everywhere it is used');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Emails already sent stay in Gmail.');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Google didn't confirm. Aman removed the connection here; you can also remove access in your Google account settings.",
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByText('Add yourself as a test user')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('says access was revoked when Google confirmed', async () => {
    const { port } = makePort({ getGoogleStatus: async () => connectedStatus() });
    renderPanel(port);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect(await screen.findByText('Google is disconnected and its access was revoked.')).toBeInTheDocument();
  });

  it('writes no em dashes', async () => {
    const { container } = render(
      <GoogleSetupPanel open onOpenChange={() => undefined} port={makePort().port} onChanged={() => undefined} />,
    );
    await screen.findByLabelText('Client ID');
    expect(container.textContent).not.toContain('—');
    expect(document.body.textContent).not.toContain('—');
  });

  it('tells the user to add themselves as a test user, and offers Testing and Production in plain words', async () => {
    renderPanel(makePort().port);
    expect(await screen.findByText('Add yourself as a test user')).toBeInTheDocument();
    expect(
      screen.getByText(
        /under Test users, click Add users and add the Gmail address you will connect as\. Without it, Google shows an "Access blocked" page when you try to sign in\./,
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('access_denied');
    expect(screen.getByText('Choose Testing or Production')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Production: on the Audience page, click Publish app\. Google then shows an "unverified app" screen once; click Advanced, then continue\./,
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Publish app\. Until then/);
  });

  it('tells Mac and iPhone users how to copy the whole address, since Safari hides http://', async () => {
    renderPanel(makePort().port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await screen.findByLabelText('Address from the address bar');
    expect(
      screen.getByText(
        /In Safari on a Mac, click the address bar, then Select All \(Cmd\+A\) and Copy \(Cmd\+C\), because Safari hides "http:\/\/"/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/On an iPhone or iPad, tap the address bar, choose Select All, then Copy/),
    ).toBeInTheDocument();
  });

  it('opens the Google tab inside the click, before the server answers, and points it at Google afterwards', async () => {
    let answer: (start: Awaited<ReturnType<GoogleSetupPort['beginGoogleConsent']>>) => void = () => undefined;
    const { port } = makePort({
      beginGoogleConsent: () =>
        new Promise(resolve => {
          answer = resolve;
        }),
    });
    renderPanel(port);
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
    await act(async () => {
      answer({ authorizationUrl: 'https://accounts.example.test/auth', setup: PASTE_SETUP });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(tab.location.href).toBe('https://accounts.example.test/auth');
    });
    expect(tab.opener).toBeNull();
    expect(screen.getByRole('link', { name: 'open Google sign-in here' })).toHaveAttribute(
      'href',
      'https://accounts.example.test/auth',
    );
  });

  it('closes the tab it opened when the server refuses to start the sign-in, and keeps the error', async () => {
    renderPanel(
      makePort({
        beginGoogleConsent: async () => {
          throw new Error('That client cannot be used.');
        },
      }).port,
    );
    await screen.findByLabelText('Client ID');
    fillClient();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That client cannot be used.');
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  describe('with the clock under test control', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops waiting after ten minutes and says so, with the form to try again', async () => {
      vi.useFakeTimers();
      const { port } = makePort({
        beginGoogleConsent: async () => ({
          authorizationUrl: 'https://accounts.example.test/auth',
          setup: { ...PASTE_SETUP, mode: 'loopback' },
        }),
      });
      await act(async () => {
        render(<GoogleSetupPanel open onOpenChange={() => undefined} port={port} onChanged={() => undefined} />);
        await vi.advanceTimersByTimeAsync(0);
      });
      fillClient();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/This panel updates by itself/)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      });
      expect(screen.getByText(/This panel updates by itself/)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61 * 1000);
      });
      expect(screen.getByRole('alert')).toHaveTextContent('Sign-in timed out. Select Connect to try again.');
      expect(screen.getByRole('button', { name: 'Connect Google' })).toBeInTheDocument();
    });

    it('does not say it timed out after the user cancelled the wait', async () => {
      vi.useFakeTimers();
      const { port } = makePort({
        beginGoogleConsent: async () => ({
          authorizationUrl: 'https://accounts.example.test/auth',
          setup: { ...PASTE_SETUP, mode: 'loopback' },
        }),
      });
      await act(async () => {
        render(<GoogleSetupPanel open onOpenChange={() => undefined} port={port} onChanged={() => undefined} />);
        await vi.advanceTimersByTimeAsync(0);
      });
      fillClient();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('leaves no copy-confirmation timer running after the panel is gone', async () => {
      vi.useFakeTimers();
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => undefined) },
      });
      let view: ReturnType<typeof render> | undefined;
      await act(async () => {
        view = render(
          <GoogleSetupPanel open onOpenChange={() => undefined} port={makePort().port} onChanged={() => undefined} />,
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy Gmail API link' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: 'Copy Gmail API link' })).toHaveTextContent('Copied');
      view?.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('in offline mode', () => {
    const OFFLINE = 'Gmail needs network access. Turn off offline mode in Settings to connect.';
    const offlineApi = (offlineMode: boolean): SentinelApi => ({
      listAuditEntries: async () => [],
      getUserSettings: async () => ({ offline_mode: offlineMode, tier2_auto_allow: [], search_without_asking: true }),
      updateUserSettings: async () => ({
        offline_mode: offlineMode,
        tier2_auto_allow: [],
        search_without_asking: true,
      }),
      listSentinelSessionContext: async () => ({ approvals: [] }),
    });
    const renderWithSentinel = (port: GoogleSetupPort, offlineMode: boolean) =>
      render(
        <SentinelApiProvider api={offlineApi(offlineMode)}>
          <GoogleSetupPanel open onOpenChange={() => undefined} port={port} onChanged={() => undefined} />
        </SentinelApiProvider>,
      );

    it('says so and will not start a sign-in', async () => {
      const { port, begin } = makePort();
      renderWithSentinel(port, true);
      expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
      await screen.findByLabelText('Client ID');
      fillClient();
      expect(screen.getByRole('button', { name: 'Connect Google' })).toBeDisabled();
      expect(begin).not.toHaveBeenCalled();
    });

    it('also blocks Reconnect, Test connection and Allow drafts and sending for a saved login', async () => {
      const { port } = makePort({ getGoogleStatus: async () => connectedStatus() });
      renderWithSentinel(port, true);
      expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Allow drafts and sending' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    });

    it('says nothing when offline mode is off', async () => {
      renderWithSentinel(makePort().port, false);
      await screen.findByLabelText('Client ID');
      expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();
      fillClient();
      expect(screen.getByRole('button', { name: 'Connect Google' })).toBeEnabled();
    });
  });

  it('says what the panel is for and that the user brings their own project, with no verification needed', async () => {
    renderPanel(makePort().port);
    expect(
      await screen.findByText('Not connected. Connect your own Google account to read your email.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Use a Google Cloud project you created yourself. Aman uses your project, not a shared one, so no verification or security review is needed for your own use.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/After you publish, reconnect once, so the saved sign-in is issued in production mode\./),
    ).toBeInTheDocument();
  });

  it("says a connected login is on the user's own project, and warns about Testing mode", async () => {
    renderPanel(makePort({ getGoogleStatus: async () => connectedStatus() }).port);
    expect(await screen.findByText(/Connected with your own Google project\./)).toBeInTheDocument();
    expect(screen.getByText(/choose Advanced, then continue\./)).toBeInTheDocument();
    expect(
      screen.getByText(
        /If your Google project is in Testing mode, Google will disconnect this sign-in 7 days after you connect\. In Google Cloud, open Audience and choose Publish app to keep it connected, then reconnect once/,
      ),
    ).toBeInTheDocument();
  });
});
