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
 * Plain words for a failure the browser reported during a push step, matched to the kind of failure so the next
 * step fits it. A certificate failure reads differently from the rest: the page itself can be opened past a
 * certificate warning, but the browser fetches the notice program only over a connection it fully trusts, so an
 * address whose certificate this device does not trust fails here and nowhere else. Its remedies are the ones the
 * product already has: refresh the addresses recorded on the computer (which re-issues its certificate), and
 * trust that computer on this device.
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
  const message = caught instanceof Error ? caught.message : '';
  const name = caught instanceof Error ? caught.name : '';
  if (/certificate|ssl/i.test(message)) {
    return `This browser does not trust the secure connection at this address, so notices cannot be set up here. On the computer that runs ${assistant}, run: aman doctor network --fix. Then, on this device, open the trust page for that computer (the installer printed its address; it ends in /trust) and follow its steps. Then come back here and try again.`;
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
