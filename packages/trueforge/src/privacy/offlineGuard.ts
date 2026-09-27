/**
 * Offline mode: the software equivalent of pulling the network cable.
 *
 * When enabled, every in-process `fetch` to a non-local destination is
 * rejected with an OfflineBlockedError. Local destinations (loopback,
 * RFC 1918 private ranges, link-local, `.local` / `.localhost` names) keep
 * working, so a self-hosted model endpoint on the LAN is unaffected.
 *
 * The flag lives in memory for the hot path (no store read per request) and
 * is mirrored to the `privacy_offline_mode` global setting for durability.
 * The PUT /api/v1/privacy/offline-mode handler keeps both in sync; server
 * boot hydrates the flag from the store.
 */
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/** Global-settings key mirroring the in-memory offline flag. */
export const PRIVACY_OFFLINE_MODE_SETTING_KEY = 'privacy_offline_mode';

let offlineEnabled = false;

export function isOfflineModeEnabled(): boolean {
  return offlineEnabled;
}

export function setOfflineModeEnabled(enabled: boolean): void {
  offlineEnabled = enabled;
}

/** Hydrates the in-memory flag from the persisted setting at server boot. */
export async function hydrateOfflineModeFromStore<TTransaction>(options: {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
}): Promise<void> {
  const record = await options.globalSettingsStore.getSetting({ key: PRIVACY_OFFLINE_MODE_SETTING_KEY });
  offlineEnabled = record?.value === 'true';
}

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function ipv4Octets(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

/**
 * Whether an IPv6 literal (brackets stripped, lowercased) points at this
 * machine or the local network: loopback, link-local, unique-local, or an
 * IPv4-mapped address whose embedded IPv4 address is local. Global unicast
 * and anything unparseable are remote.
 */
function isLocalIpv6(host: string): boolean {
  if (host === '::1') {
    return true;
  }
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1: judge the embedded IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped?.[1] !== undefined) {
    return isLocalHostname(mapped[1]);
  }
  const first = Number.parseInt(host.split(':')[0] ?? '', 16);
  if (!Number.isInteger(first) || first < 0 || first > 0xffff) {
    return false;
  }
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

/**
 * Whether a hostname points at this machine or the local network.
 * Hostname-based only: a public DNS name that happens to resolve to a
 * private IP is still treated as remote. Documented in privacy-data-flow.mdx.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') {
    return true;
  }
  if (host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host === 'host.docker.internal' || host === 'host.containers.internal') {
    return true;
  }
  if (host.includes(':')) {
    return isLocalIpv6(host);
  }
  if (isIpv4(host)) {
    const octets = ipv4Octets(host);
    if (octets === undefined) {
      return false;
    }
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  return false;
}

/** Rejection for a network call blocked by offline mode. */
export class OfflineBlockedError extends Error {
  readonly code = 'OFFLINE_MODE_BLOCKED';
  readonly url: string;

  constructor(options: { url: string }) {
    super(
      `Offline mode is on: blocked a network request to ${options.url}. ` +
        'Turn off offline mode in Settings > Privacy to allow internet access.',
    );
    this.name = 'OfflineBlockedError';
    this.url = options.url;
  }
}

/** Throws OfflineBlockedError when offline mode blocks this URL. Pure and testable. */
export function assertOnlineAllowed(url: string | URL): void {
  if (!offlineEnabled) {
    return;
  }
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    // Not a parseable URL (relative path, malformed): the underlying fetch
    // would reject it anyway, so there is nothing to gate here.
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return;
  }
  if (!isLocalHostname(parsed.hostname)) {
    throw new OfflineBlockedError({ url: parsed.origin });
  }
}

/** fetch wrapper enforcing offline mode. Reads the flag per call so toggles apply instantly. */
export function createOfflineFetch(options: { baseFetch?: typeof globalThis.fetch } = {}): typeof globalThis.fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    assertOnlineAllowed(url);
    return baseFetch(input, init);
  };
}

let restoreGuard: (() => void) | undefined;

/**
 * Installs the offline guard on `globalThis.fetch` for this process.
 * Idempotent; returns a restore function for tests. Server boot calls this
 * once; the PUT handler only flips the flag.
 */
export function installOfflineFetchGuard(): () => void {
  if (restoreGuard !== undefined) {
    return restoreGuard;
  }
  const originalFetch = globalThis.fetch;
  const guarded = createOfflineFetch({
    baseFetch: (input, init) => originalFetch(input, init),
  });
  globalThis.fetch = guarded;
  restoreGuard = () => {
    globalThis.fetch = originalFetch;
    restoreGuard = undefined;
  };
  return restoreGuard;
}
