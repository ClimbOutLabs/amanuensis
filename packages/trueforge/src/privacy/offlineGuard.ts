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
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return undefined;
  }
  return [a, b, c, d];
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
  if (host === '169.254.169.254') {
    // Cloud instance metadata endpoint: never local, even though it sits
    // inside the 169.254.0.0/16 link-local range matched below.
    return false;
  }
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

/** Cap on the redirect hops the offline guard follows on its own. */
const MAX_GUARD_REDIRECTS = 5;

/** Credential headers native fetch drops when a redirect changes origin. */
const REDIRECT_CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Rebuilds a RequestInit without credential headers. Used when a redirect
 * hop changes origin, so the original request's credentials are never
 * forwarded to a different origin the response bounced to.
 */
function stripCredentialHeaders(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  for (const name of REDIRECT_CREDENTIAL_HEADERS) {
    headers.delete(name);
  }
  return { ...init, headers };
}

/**
 * fetch wrapper enforcing offline mode. Reads the flag per call so toggles
 * apply instantly.
 *
 * Redirect-aware: requests go out with `redirect: 'manual'` and every
 * redirect hop is validated with `assertOnlineAllowed` before following.
 * fetch's default `follow` would let a permitted local URL bounce to a
 * remote destination unchecked, which is exactly the exfiltration path
 * offline mode exists to close. Follows the same manual-redirect pattern as
 * document ingestion's URL snapshots.
 */
export function createOfflineFetch(options: { baseFetch?: typeof globalThis.fetch } = {}): typeof globalThis.fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const startUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    assertOnlineAllowed(startUrl);
    // Follow-up hops re-issue as (url, init): seed the init from a Request
    // input so its method and headers survive a redirect. The body stream
    // cannot be re-sent, so a 307/308 that must preserve it fails closed below.
    const followInit: RequestInit | undefined =
      typeof input === 'string' || input instanceof URL
        ? init
        : { method: input.method, headers: input.headers, ...(init ?? {}) };
    let currentInput: string | URL | Request = input;
    let currentInit = init;
    let url = startUrl;
    for (let hop = 0; ; hop += 1) {
      const response = await baseFetch(currentInput, { ...currentInit, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null) {
        return response;
      }
      // Drain the redirect response so its connection can be reused.
      await response.arrayBuffer().catch(() => undefined);
      if (hop >= MAX_GUARD_REDIRECTS) {
        throw new Error(
          `Blocked a request starting at ${startUrl}: more than ${String(MAX_GUARD_REDIRECTS)} redirects.`,
        );
      }
      const previousUrl = url;
      url = new URL(location, url).toString();
      assertOnlineAllowed(url);
      const method = (currentInit?.method ?? (currentInput instanceof Request ? currentInput.method : 'GET')).toUpperCase();
      // 301/302/303 become a GET without a body; 307/308 repeat the request.
      const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST');
      if (!toGet && (response.status === 307 || response.status === 308) && currentInput instanceof Request) {
        throw new Error(`Blocked a request starting at ${startUrl}: cannot re-send a Request body across a redirect.`);
      }
      // Native fetch strips credential headers on cross-origin redirects so
      // the original request's credentials never leak to a new origin.
      const crossOrigin = new URL(url).origin !== new URL(previousUrl).origin;
      let nextInit: RequestInit | undefined = followInit;
      if (toGet) {
        nextInit = { ...nextInit, method: 'GET' };
        delete nextInit.body;
      }
      currentInput = url;
      currentInit = crossOrigin ? stripCredentialHeaders(nextInit) : nextInit;
    }
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
