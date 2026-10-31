// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliveriesProvider } from '@/deliveries/DeliveriesContext.js';
import { ReachMeSettings } from '@/deliveries/ReachMeSettings.js';

import { fakeServer } from './fakeDeliveriesApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(window, 'PushManager');
});

function stubPushBrowser() {
  const subscription = {
    endpoint: 'https://push.example.test/device',
    getKey: (name: string) => new TextEncoder().encode(name).buffer,
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  let current: typeof subscription | null = null;
  const registration = {
    pushManager: {
      getSubscription: vi.fn(() => Promise.resolve(current)),
      subscribe: vi.fn(() => {
        current = subscription;
        return Promise.resolve(subscription);
      }),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(() => Promise.resolve(registration)),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(() => Promise.resolve(current === null ? undefined : registration)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
  const requestPermission = vi.fn(() => {
    stub.permission = 'granted';
    return Promise.resolve<NotificationPermission>('granted');
  });
  const stub = class {
    static permission: NotificationPermission = 'default';
    static requestPermission = requestPermission;
  };
  vi.stubGlobal('Notification', stub);
  return { registration, subscription, requestPermission };
}

function renderSettings() {
  const server = fakeServer([]);
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
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(browser.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(button);

    await waitFor(() => expect(api.savePushDevice).toHaveBeenCalled());
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.savePushDevice).toHaveBeenCalledWith({
      endpoint: 'https://push.example.test/device',
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
    await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(on);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off on this device' }));

    await waitFor(() => expect(api.removePushDevice).toHaveBeenCalledWith('https://push.example.test/device'));
    expect(await screen.findByRole('button', { name: 'Turn on for this device' })).toBeTruthy();
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
