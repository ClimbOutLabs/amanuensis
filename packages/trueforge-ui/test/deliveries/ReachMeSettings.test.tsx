// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(screen.getByText(/Texts and phone calls are off\./)).toBeTruthy();
  });
});
