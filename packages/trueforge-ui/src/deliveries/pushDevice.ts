import type { DeliveriesApi } from './types.js';

/** Why this browser cannot take push notices, in words the person reads. Null when it can. */
export type PushBlocker = 'unsupported' | 'iphone_needs_home_screen' | 'denied';

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

/** This device's push subscription, or null when it has none or cannot have one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration === undefined ? null : registration.pushManager.getSubscription();
}

/**
 * Turns notices on for this device. Call it from the person's click: the browser asks for permission here.
 */
export async function enablePush({ api, label }: { api: DeliveriesApi; label: string }): Promise<void> {
  const publicKey = await api.pushPublicKey();
  if (publicKey === null) {
    throw new Error('Notices are not set up on this server. Ask the person who runs it to turn them on.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      'This browser did not allow notices. Allow them for this site in the browser settings, then try again.',
    );
  }
  const registration = await navigator.serviceWorker.register(api.pushWorker.url, { scope: api.pushWorker.scope });
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api.savePushDevice({
    endpoint: subscription.endpoint,
    p256dh: bufferToBase64Url(subscription.getKey('p256dh')),
    auth: bufferToBase64Url(subscription.getKey('auth')),
    label,
  });
}

/** Turns notices off for this device, here and on the server. */
export async function disablePush({ api }: { api: DeliveriesApi }): Promise<void> {
  const subscription = await currentPushSubscription();
  if (subscription === null) return;
  await api.removePushDevice(subscription.endpoint);
  await subscription.unsubscribe();
}
