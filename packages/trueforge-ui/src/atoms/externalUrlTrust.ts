export const EXTERNAL_URL_TRUST_STORAGE_KEY = 'aui-trusted-external-urls';

// Stores written before this key was renamed live under the hosts name. A
// store found there moves to the new key when it is read and upgraded, so a
// remembered choice is not lost in the rename.
const LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY = 'aui-trusted-external-hosts';

/** How many remembered image addresses are kept; the oldest drop off past this. */
export const REMEMBERED_IMAGE_URL_LIMIT = 100;

// Version 2 stores link origins in `links` and exact image addresses in
// `images`, not hosts. A remembered image choice must never stand in for
// every image from the same host, and a remembered link choice must never
// stand in for another scheme or port on the same host. Older stores name
// only a host, with no scheme or port and no single image, so no older entry
// can be turned into the one origin or image the person saw: those entries
// drop in the upgrade instead of being guessed at.
type StoredExternalUrlTrust = {
  version: 2;
  links: string[];
  images: string[];
};

function emptyStore(): StoredExternalUrlTrust {
  return { version: 2, links: [], images: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Canonical origin (scheme, host and port) named by a stored link entry, or
 * null when the entry is not a full http(s) address or origin. A bare host
 * name returns null: it carries no scheme or port to match an origin against.
 */
function normalizeStoredOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizedOrigins(values: string[]): string[] {
  const origins: string[] = [];
  for (const value of values) {
    const origin = normalizeStoredOrigin(value);
    if (origin != null && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

function capRememberedImages(images: string[]): string[] {
  return images.slice(-REMEMBERED_IMAGE_URL_LIMIT);
}

function parseStore(raw: unknown): StoredExternalUrlTrust {
  if (raw == null || typeof raw !== 'object') return emptyStore();
  if (!('version' in raw)) return emptyStore();
  if (raw.version === 1) {
    const links = 'links' in raw && isStringArray(raw.links) ? raw.links : [];
    return { version: 2, links: normalizedOrigins(links), images: [] };
  }
  if (raw.version !== 2) return emptyStore();
  const links = 'links' in raw && isStringArray(raw.links) ? raw.links : [];
  const images = 'images' in raw && isStringArray(raw.images) ? raw.images : [];
  return { version: 2, links: normalizedOrigins(links), images: capRememberedImages(images) };
}

// The stored value is parsed once and kept until it changes. Reading trust on
// every render used to parse the same text again each time.
let cachedRaw: string | null | undefined = undefined;
let cachedStore: StoredExternalUrlTrust | null = null;

function readStore(): StoredExternalUrlTrust {
  if (typeof window === 'undefined') return emptyStore();
  let rawString: string | null;
  let legacyRawString: string | null = null;
  try {
    rawString = window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
  } catch {
    return emptyStore();
  }
  if (rawString == null) {
    try {
      legacyRawString = window.localStorage.getItem(LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY);
    } catch {
      return emptyStore();
    }
    if (legacyRawString != null) rawString = legacyRawString;
  }
  if (cachedStore != null && cachedRaw === rawString) return cachedStore;
  let parsed: StoredExternalUrlTrust;
  try {
    const raw: unknown = JSON.parse(rawString ?? 'null');
    parsed = parseStore(raw);
  } catch {
    parsed = emptyStore();
  }
  cachedRaw = rawString;
  cachedStore = parsed;
  if (legacyRawString != null) {
    // The upgrade to version 2 is where a store under the old key moves: the
    // upgraded store is written under the new key and the old key is removed,
    // but only once the new copy is safely stored.
    if (writeStore(parsed)) {
      try {
        window.localStorage.removeItem(LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY);
      } catch {
        // The new copy is stored either way; a leftover old key is ignored.
      }
    }
  }
  return parsed;
}

function writeStore(store: StoredExternalUrlTrust): boolean {
  cachedRaw = JSON.stringify(store);
  cachedStore = store;
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(EXTERNAL_URL_TRUST_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    // Storage can be unavailable or full; in-memory session approvals still work.
    return false;
  }
}

function resolveUrl(url: string): URL | null {
  try {
    // Base required so protocol-relative (`//host/path`) and relative URLs parse.
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Origin (scheme, host and port) for http(s) URLs resolved against the page; null for non-http(s) or unparseable. */
export function getOrigin(url: string): string | null {
  const parsed = resolveUrl(url);
  if (parsed == null) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * True when `url` resolves to http(s) on a different origin than the page.
 * Origin covers scheme, host and port, so another port on the same host still
 * counts as external. Same-origin, data:, blob:, and other non-http(s)
 * schemes return false.
 */
export function isExternalHttpUrl(url: string): boolean {
  const parsed = resolveUrl(url);
  if (parsed == null) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (typeof window === 'undefined') return true;
  return parsed.origin !== window.location.origin;
}

/**
 * True when the origin named by `origin` was remembered. The argument may be
 * an origin or a full http(s) address; only its origin part is matched, so a
 * remembered origin never covers another scheme or port on the same host.
 */
export function isTrustedLinkOrigin(origin: string): boolean {
  const normalized = normalizeStoredOrigin(origin);
  if (normalized == null) return false;
  const store = readStore();
  return store.links.includes(normalized);
}

export function trustLinkOrigin(origin: string): void {
  const normalized = normalizeStoredOrigin(origin);
  if (normalized == null) return;
  const store = readStore();
  if (store.links.includes(normalized)) return;
  writeStore({
    ...store,
    links: [...store.links, normalized],
  });
}

/** Canonical form of one image address, used so the same address always matches itself. */
function normalizeImageUrl(url: string): string | null {
  const parsed = resolveUrl(url.trim());
  if (parsed == null) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

export function isTrustedImageUrl(url: string): boolean {
  const normalized = normalizeImageUrl(url);
  if (normalized == null) return false;
  const store = readStore();
  return store.images.includes(normalized);
}

export function trustImageUrl(url: string): void {
  const normalized = normalizeImageUrl(url);
  if (normalized == null) return;
  const store = readStore();
  if (store.images.includes(normalized)) return;
  writeStore({
    ...store,
    // The remembered list is capped so it cannot grow without limit in local
    // storage; the entries kept are the most recently remembered ones.
    images: capRememberedImages([...store.images, normalized]),
  });
}

// Session trust for images lives in one shared place for the whole page, not
// in a single message. Each Markdown block wraps itself in its own provider,
// so provider state alone forgot the choice as soon as the next message
// rendered. This store is memory only: it ends when the page goes away, which
// is what "for the rest of the session" promises, and it holds exact image
// addresses for the same reason the remembered store does.
// Each entry records the session trust version at which it was trusted, so a
// caller can ask what was trusted as of the version it is rendering from.
const sessionTrustedImageUrls = new Map<string, number>();
const sessionTrustListeners = new Set<() => void>();
let sessionTrustVersion = 0;

function notifySessionTrustListeners(): void {
  sessionTrustVersion += 1;
  for (const listener of [...sessionTrustListeners]) {
    listener();
  }
}

export function trustSessionImageUrl(url: string): void {
  const normalized = normalizeImageUrl(url);
  if (normalized == null) return;
  if (sessionTrustedImageUrls.has(normalized)) return;
  sessionTrustedImageUrls.set(normalized, sessionTrustVersion + 1);
  notifySessionTrustListeners();
}

/**
 * True when this exact image was trusted for the session as of `version`.
 * Callers that render from a session trust snapshot pass their version in, so
 * the answer matches that snapshot instead of a later choice. Without a
 * version, the current state of the session store answers.
 */
export function isSessionImageUrlTrusted(url: string, version?: number): boolean {
  const normalized = normalizeImageUrl(url);
  if (normalized == null) return false;
  const trustedAtVersion = sessionTrustedImageUrls.get(normalized);
  if (trustedAtVersion == null) return false;
  return trustedAtVersion <= (version ?? sessionTrustVersion);
}

export function subscribeToSessionImageTrust(listener: () => void): () => void {
  sessionTrustListeners.add(listener);
  return () => {
    sessionTrustListeners.delete(listener);
  };
}

export function getSessionImageTrustVersion(): number {
  return sessionTrustVersion;
}

export function clearSessionImageTrust(): void {
  if (sessionTrustedImageUrls.size === 0) return;
  sessionTrustedImageUrls.clear();
  notifySessionTrustListeners();
}

/** Open http(s) URLs in a new tab; no-op for non-http(s) schemes (e.g. javascript:). */
export function openExternalHttpUrl(url: string): void {
  const parsed = resolveUrl(url);
  if (parsed == null) return;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
