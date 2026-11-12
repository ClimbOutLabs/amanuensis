import { vi } from 'vitest';

function keyBuffer(base64url: string): ArrayBuffer {
  const raw = window.atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

type StubSubscription = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  getKey: (name: string) => ArrayBuffer;
  unsubscribe: () => Promise<boolean>;
};

/**
 * A browser that can take push. `existingKey` makes it start with a subscription made with that key.
 * `registerError` makes registering the notice program fail the way the browser reports it;
 * `subscribeError` and `unsubscribeError` make those steps fail the same way.
 */
export function stubPushBrowser({
  existingKey,
  registerError,
  subscribeError,
  unsubscribeError,
}: {
  existingKey?: string;
  registerError?: Error;
  subscribeError?: unknown;
  unsubscribeError?: unknown;
} = {}) {
  let made = 0;
  const unsubscribed: string[] = [];
  const makeSubscription = (key: ArrayBuffer | null): StubSubscription => {
    made += 1;
    const endpoint = `https://push.example.test/device-${String(made)}`;
    return {
      endpoint,
      options: { applicationServerKey: key },
      getKey: (name: string) => new TextEncoder().encode(name).buffer,
      unsubscribe: () => {
        if (unsubscribeError !== undefined) return Promise.reject(unsubscribeError);
        unsubscribed.push(endpoint);
        current = null;
        return Promise.resolve(true);
      },
    };
  };
  let current: StubSubscription | null = existingKey === undefined ? null : makeSubscription(keyBuffer(existingKey));
  const registration = {
    pushManager: {
      getSubscription: vi.fn(() => Promise.resolve(current)),
      subscribe: vi.fn((options: { applicationServerKey: Uint8Array<ArrayBuffer> }) => {
        if (subscribeError !== undefined) return Promise.reject(subscribeError);
        current = makeSubscription(options.applicationServerKey.buffer);
        return Promise.resolve(current);
      }),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register:
        registerError === undefined
          ? vi.fn(() => Promise.resolve(registration))
          : vi.fn(() => Promise.reject(registerError)),
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
  return { registration, requestPermission, unsubscribed };
}

/** Takes away the push parts `stubPushBrowser` added. */
export function removePushBrowser(): void {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(window, 'PushManager');
}
