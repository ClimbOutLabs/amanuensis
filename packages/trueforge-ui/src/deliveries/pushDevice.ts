import type { DeliveriesApi } from './types.js';

/** Why this browser cannot take push notices, in words the person reads. Null when it can. */
export type PushBlocker = 'needs_https' | 'unsupported' | 'iphone_needs_home_screen' | 'denied';

export type PushSupport = { blocker: PushBlocker | null; permission: NotificationPermission | 'unsupported' };

function isIphone(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isHomeScreenApp(): boolean {
  const standalone: unknown = Reflect.get(navigator, 'standalone');
  return standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

/** What this browser can do about push right now. */
export function pushSupport(): PushSupport {
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  // Browsers hide the push parts on a plain http address other than localhost, such as one on the home network.
  if (window.isSecureContext === false) return { blocker: 'needs_https', permission };
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && permission !== 'unsupported';
  if (!capable) {
    // On an iPhone the push parts only exist once Aman is on the Home Screen.
    return { blocker: isIphone() && !isHomeScreenApp() ? 'iphone_needs_home_screen' : 'unsupported', permission };
  }
  if (permission === 'denied') return { blocker: 'denied', permission };
  return { blocker: null, permission };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (buffer === null) return '';
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The name and message of a browser failure. The browser steps below throw DOMExceptions, which are not Error
 * instances in every browser, so read the two fields off whatever was thrown.
 */
function failureShape(caught: unknown): { name: string; message: string } {
  if (typeof caught !== 'object' || caught === null) return { name: '', message: '' };
  const name = Reflect.get(caught, 'name');
  const message = Reflect.get(caught, 'message');
  return {
    name: typeof name === 'string' ? name : '',
    message: typeof message === 'string' ? message : '',
  };
}

/**
 * Plain words for a trust failure. The page itself can be opened past a certificate warning, but the browser fetches
 * the notice program only over a connection it fully trusts, so a device that has not trusted this computer fails here
 * and nowhere else. The one next step is the trust step on this device, the same one the phone help describes.
 */
function trustFailureWords({ assistant, turningOn }: { assistant: string; turningOn: boolean }): string {
  const consequence = turningOn ? 'notices cannot be turned on here' : 'notices cannot be turned off here';
  return `This device does not trust the computer that runs ${assistant} yet, so ${consequence}. On this device, open the "Trust this computer" link the installer printed, follow its steps, then try again.`;
}

/**
 * Plain words for a failure the browser reported during a push step, matched to the kind of failure so the next
 * step fits it. A certificate failure, and a SecurityError raised while subscribing, both mean the browser does
 * not trust this address, so both get the trust words.
 */
function browserFailureWords({
  caught,
  assistant,
  turningOn,
}: {
  caught: unknown;
  assistant: string;
  turningOn: boolean;
}): string {
  const { name, message } = failureShape(caught);
  if (/certificate|ssl/i.test(message) || name === 'SecurityError') {
    return trustFailureWords({ assistant, turningOn });
  }
  if (name === 'NotAllowedError') {
    return 'This browser did not allow notices. Allow them for this site in the browser settings, then try again.';
  }
  if (name === 'AbortError') {
    return "The notice service could not be reached. Check this device's connection, then try again.";
  }
  if (turningOn && /register|script/i.test(message)) {
    return 'This browser could not load the small program notices need. Reload the page, then try again.';
  }
  return turningOn
    ? 'Notices could not be turned on. Reload the page, then try again.'
    : 'Notices could not be turned off. Reload the page, then try again.';
}

/** Runs one browser push step. A raw browser failure leaves as plain words, with the raw error kept as the cause. */
async function browserStep<T>({
  run,
  assistant,
  turningOn,
}: {
  run: () => Promise<T>;
  assistant: string;
  turningOn: boolean;
}): Promise<T> {
  try {
    return await run();
  } catch (caught) {
    throw new Error(browserFailureWords({ caught, assistant, turningOn }), { cause: caught });
  }
}

/** This device's push subscription, or null when it has none or cannot have one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration === undefined ? null : registration.pushManager.getSubscription();
}

/** Whether this subscription was made with the server's current key. One made with an older key gets no notices. */
export function subscribedWithKey({
  subscription,
  publicKey,
}: {
  subscription: PushSubscription;
  publicKey: string;
}): boolean {
  const current = subscription.options.applicationServerKey;
  return current !== null && bufferToBase64Url(current) === publicKey.replace(/=+$/, '');
}

/** Whether push works on the server, and whether this device gets notices now. */
export type PushStatus = { serverReady: boolean; on: boolean };

/**
 * Notices are on only when this browser has a subscription made with the server's current key and the server still
 * has it: a device the server dropped, for a newer one or because its push service said it is gone, reads as off.
 * When the server cannot be asked, the browser's own answer stands, so a failed check never flips a working device off.
 */
export async function pushStatus({ api }: { api: DeliveriesApi }): Promise<PushStatus> {
  const [subscription, key] = await Promise.all([
    currentPushSubscription().catch(() => null),
    api.pushPublicKey().catch(() => null),
  ]);
  if (key === null) return { serverReady: false, on: false };
  if (subscription === null || !subscribedWithKey({ subscription, publicKey: key })) {
    return { serverReady: true, on: false };
  }
  const saved = await api.pushDeviceSaved(subscription.endpoint).catch(() => true);
  return { serverReady: true, on: saved };
}

function deviceOf({ subscription, label }: { subscription: PushSubscription; label: string }) {
  return {
    endpoint: subscription.endpoint,
    p256dh: bufferToBase64Url(subscription.getKey('p256dh')),
    auth: bufferToBase64Url(subscription.getKey('auth')),
    label,
  };
}

/**
 * Turns notices on for this device. Call it from the person's click: the browser asks for permission here. A
 * subscription made with an older server key, or one whose address another account holds, is replaced.
 */
export async function enablePush({
  api,
  label,
  assistant,
}: {
  api: DeliveriesApi;
  label: string;
  assistant: string;
}): Promise<void> {
  const publicKey = await api.pushPublicKey();
  if (publicKey === null) {
    throw new Error('Notices are not set up on this server. Ask the person who runs it to turn them on.');
  }
  const permission = await browserStep({ run: () => Notification.requestPermission(), assistant, turningOn: true });
  if (permission !== 'granted') {
    throw new Error(
      'This browser did not allow notices. Allow them for this site in the browser settings, then try again.',
    );
  }
  const registration = await browserStep({
    run: () => navigator.serviceWorker.register(api.pushWorker.url, { scope: api.pushWorker.scope }),
    assistant,
    turningOn: true,
  });
  await browserStep({ run: () => navigator.serviceWorker.ready, assistant, turningOn: true });
  const subscribe = () =>
    browserStep({
      run: () =>
        registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }),
      assistant,
      turningOn: true,
    });
  let subscription = await browserStep({
    run: () => registration.pushManager.getSubscription(),
    assistant,
    turningOn: true,
  });
  if (subscription !== null && !subscribedWithKey({ subscription, publicKey })) {
    const stale = subscription;
    await browserStep({ run: () => stale.unsubscribe(), assistant, turningOn: true });
    subscription = null;
  }
  subscription ??= await subscribe();
  if ((await api.savePushDevice(deviceOf({ subscription, label }))) === 'saved') return;
  // Another account on this server holds this address. A fresh subscription gets an address of its own.
  const held = subscription;
  await browserStep({ run: () => held.unsubscribe(), assistant, turningOn: true });
  const fresh = await subscribe();
  if ((await api.savePushDevice(deviceOf({ subscription: fresh, label }))) === 'taken') {
    await browserStep({ run: () => fresh.unsubscribe(), assistant, turningOn: true });
    throw new Error('Notices could not be turned on for this browser. Reload the page, then try again.');
  }
}

/** Turns notices off for this device, here and on the server. */
export async function disablePush({ api, assistant }: { api: DeliveriesApi; assistant: string }): Promise<void> {
  const subscription = await browserStep({ run: () => currentPushSubscription(), assistant, turningOn: false });
  if (subscription === null) return;
  await api.removePushDevice(subscription.endpoint);
  await browserStep({ run: () => subscription.unsubscribe(), assistant, turningOn: false });
}
