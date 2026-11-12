// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { DeliveriesProvider } from '@/deliveries/DeliveriesContext.js';
import { ReachMeSettings } from '@/deliveries/ReachMeSettings.js';

import { fakeServer, SERVER_KEY } from './fakeDeliveriesApi.js';
import { removePushBrowser, stubPushBrowser } from './fakePushBrowser.js';

afterEach(() => {
  vi.unstubAllGlobals();
  removePushBrowser();
});

function renderSettings({ savedEndpoints = [] }: { savedEndpoints?: string[] } = {}) {
  const server = fakeServer([]);
  for (const endpoint of savedEndpoints) server.state.pushEndpoints.add(endpoint);
  render(
    <DeliveriesProvider api={server.api}>
      <ReachMeSettings />
    </DeliveriesProvider>,
  );
  return server;
}

describe('Settings, Reach me', () => {
  it('turns notices on from the person’s click, then tells the server about this device', async () => {
    const browser = stubPushBrowser();
    const { api } = renderSettings();
    const button = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(browser.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(button);

    await waitFor(() => expect(api.savePushDevice).toHaveBeenCalled());
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.savePushDevice).toHaveBeenCalledWith({
      endpoint: 'https://push.example.test/device-1',
      p256dh: expect.any(String),
      auth: expect.any(String),
      label: 'This device',
    });
    expect(await screen.findByRole('button', { name: 'Turn off on this device' })).toBeTruthy();
  });

  it('turns them off here and on the server', async () => {
    stubPushBrowser();
    const { api } = renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));
    fireEvent.click(on);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off on this device' }));

    await waitFor(() => expect(api.removePushDevice).toHaveBeenCalledWith('https://push.example.test/device-1'));
    expect(await screen.findByRole('button', { name: 'Turn on for this device' })).toBeTruthy();
  });

  it('reads as off after the server keys change, and turning on makes a new subscription', async () => {
    const browser = stubPushBrowser({ existingKey: 'BwgJCgsM' });
    const { api } = renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));
    expect(screen.getByText('Off for this device.')).toBeTruthy();

    fireEvent.click(on);

    await waitFor(() => expect(api.savePushDevice).toHaveBeenCalled());
    expect(browser.unsubscribed).toEqual(['https://push.example.test/device-1']);
    expect(api.savePushDevice).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example.test/device-2' }),
    );
    expect(await screen.findByText('On for this device.')).toBeTruthy();
  });

  it('shows on for a subscription made with the current key that the server still has', async () => {
    stubPushBrowser({ existingKey: SERVER_KEY });
    renderSettings({ savedEndpoints: ['https://push.example.test/device-1'] });
    expect(await screen.findByText('On for this device.')).toBeTruthy();
  });

  it('keeps showing on when the server cannot be asked about this device', async () => {
    stubPushBrowser({ existingKey: SERVER_KEY });
    const server = fakeServer([]);
    vi.mocked(server.api.pushDeviceSaved).mockRejectedValueOnce(new Error('offline'));
    render(
      <DeliveriesProvider api={server.api}>
        <ReachMeSettings />
      </DeliveriesProvider>,
    );
    expect(await screen.findByText('On for this device.')).toBeTruthy();
  });

  it('reads as off once the server dropped this device, and turning on saves it again', async () => {
    stubPushBrowser({ existingKey: SERVER_KEY });
    const { api } = renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));
    expect(screen.getByText('Off for this device.')).toBeTruthy();
    expect(api.pushDeviceSaved).toHaveBeenCalledWith('https://push.example.test/device-1');

    fireEvent.click(on);

    await waitFor(() =>
      expect(api.savePushDevice).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://push.example.test/device-1' }),
      ),
    );
    expect(await screen.findByText('On for this device.')).toBeTruthy();
  });

  it('makes a fresh subscription when another account holds this browser’s address', async () => {
    const browser = stubPushBrowser();
    const { api } = renderSettings();
    vi.mocked(api.savePushDevice).mockResolvedValueOnce('taken');
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    await waitFor(() => expect(api.savePushDevice).toHaveBeenCalledTimes(2));
    expect(browser.unsubscribed).toEqual(['https://push.example.test/device-1']);
    expect(vi.mocked(api.savePushDevice).mock.calls[1]?.[0]).toMatchObject({
      endpoint: 'https://push.example.test/device-2',
    });
    expect(await screen.findByText('On for this device.')).toBeTruthy();
  });

  it('says to use a secure address on a plain http page', () => {
    stubPushBrowser();
    vi.stubGlobal('isSecureContext', false);
    renderSettings();
    expect(screen.getByText(/Notices need a secure address/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull();
  });

  it('says in plain words that an iPhone needs Aman on the Home Screen', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    renderSettings();

    const blocker = screen.getByText(/On an iPhone, notices only work once Aman is on your Home Screen/);
    expect(blocker.textContent).toContain('Add to Home Screen');
    expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull();
  });

  it('says what to do when the browser blocks notices', () => {
    stubPushBrowser();
    vi.stubGlobal(
      'Notification',
      class {
        static permission: NotificationPermission = 'denied';
      },
    );
    renderSettings();
    expect(screen.getByText(/blocking notices for this site/)).toBeTruthy();
  });

  it('says what to do when the server has push off', async () => {
    stubPushBrowser();
    const server = fakeServer([]);
    server.state.pushKey = null;
    render(
      <DeliveriesProvider api={server.api}>
        <ReachMeSettings />
      </DeliveriesProvider>,
    );
    expect(await screen.findByText(/Ask the person who runs it to turn them on/)).toBeTruthy();
  });

  it('never names the assistant in its own words, and keeps texts and calls off', () => {
    stubPushBrowser();
    renderSettings();
    expect(screen.getByText(/Texts and phone calls stay off until they are set up\./)).toBeTruthy();
  });

  it('names the assistant the person chose in the notice words, not the product', async () => {
    stubPushBrowser();
    const server = fakeServer([]);
    const personalizationApi = {
      getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE, assistant_name: 'Testname' }),
      updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
      deleteProfile: async () => {},
    };
    render(
      <PersonalizationProvider api={personalizationApi}>
        <DeliveriesProvider api={server.api}>
          <ReachMeSettings />
        </DeliveriesProvider>
      </PersonalizationProvider>,
    );
    expect(await screen.findByText(/A notice shows even when Testname is closed/)).toBeTruthy();
    expect(screen.getByText(/The details open in Testname\./)).toBeTruthy();
    expect(screen.queryByText(/even when Aman is closed/)).toBeNull();
  });

  it('explains a certificate failure as a trust problem, in readable styling, and keeps the raw error off the page', async () => {
    stubPushBrowser({
      registerError: new Error(
        "Failed to register a ServiceWorker for scope ('https://box.example.ts.net:8444/') with script ('https://box.example.ts.net:8444/sw.js'): An SSL certificate error occurred when fetching the script.",
      ),
    });
    const { api } = renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This device does not trust the computer that runs');
    expect(alert.textContent).toContain('open the "Trust this computer" link the installer printed');
    expect(alert.textContent).not.toContain('aman doctor network');
    expect(alert.textContent).not.toContain('Failed to register a ServiceWorker');
    expect(alert.textContent).not.toContain('SSL');
    expect(alert.className).toContain('text-failure-bg');
    expect(alert.className).not.toContain('text-failure-text');
    expect(api.savePushDevice).not.toHaveBeenCalled();
  });

  it('says to reload when the notice program fails to load for another reason', async () => {
    stubPushBrowser({
      registerError: new Error(
        "Failed to register a ServiceWorker for scope ('https://box.example.test/') with script ('https://box.example.test/sw.js'): A bad HTTP response code (404) was received when fetching the script.",
      ),
    });
    renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not load the small program notices need');
    expect(alert.textContent).not.toContain('does not trust the computer');
  });

  it('treats a SecurityError while subscribing as a trust failure with the same next step', async () => {
    stubPushBrowser({ subscribeError: new DOMException('The operation is not supported.', 'SecurityError') });
    const { api } = renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This device does not trust the computer that runs');
    expect(alert.textContent).toContain('open the "Trust this computer" link the installer printed');
    expect(alert.textContent).not.toContain('could not load the small program');
    expect(api.savePushDevice).not.toHaveBeenCalled();
  });

  it('says what to do when subscribing is refused', async () => {
    stubPushBrowser({ subscribeError: new DOMException('Permission denied.', 'NotAllowedError') });
    renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This browser did not allow notices');
    expect(alert.textContent).toContain('Allow them for this site in the browser settings, then try again.');
  });

  it('says what to do when the notice service cannot be reached while subscribing', async () => {
    stubPushBrowser({ subscribeError: new DOMException('The push service is unavailable.', 'AbortError') });
    renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The notice service could not be reached');
    expect(alert.textContent).toContain("Check this device's connection, then try again.");
  });

  it('says to reload when turning on fails in a way it does not recognise', async () => {
    stubPushBrowser({ registerError: new Error('Something unexpected happened.') });
    renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));

    fireEvent.click(on);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Notices could not be turned on. Reload the page, then try again.');
  });

  it('says to reload when turning off fails in a way it does not recognise', async () => {
    stubPushBrowser({ unsubscribeError: new Error('Something unexpected happened.') });
    const { api } = renderSettings();
    const on = await screen.findByRole('button', { name: 'Turn on for this device' });
    await waitFor(() => expect(on).toHaveProperty('disabled', false));
    fireEvent.click(on);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off on this device' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Notices could not be turned off. Reload the page, then try again.');
    expect(api.removePushDevice).toHaveBeenCalledWith('https://push.example.test/device-1');
  });
});
