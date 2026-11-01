export const EXTERNAL_URL_TRUST_STORAGE_KEY = 'aui-trusted-external-hosts';

// Version 2 stores exact image addresses in `images`, not hosts. A remembered
// image choice must never stand in for every image from the same host, so a
// version 1 store keeps its remembered link hosts and drops its remembered
// images: a host entry cannot be narrowed to the one image the person saw.
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

function parseStore(raw: unknown): StoredExternalUrlTrust {
  if (raw == null || typeof raw !== 'object') return emptyStore();
  if (!('version' in raw)) return emptyStore();
  if (raw.version === 1) {
    const links = 'links' in raw && isStringArray(raw.links) ? raw.links : [];
    return { version: 2, links, images: [] };
  }
  if (raw.version !== 2) return emptyStore();
  const links = 'links' in raw && isStringArray(raw.links) ? raw.links : [];
  const images = 'images' in raw && isStringArray(raw.images) ? raw.images : [];
  return { version: 2, links, images };
}

// The stored value is parsed once and kept until it changes. Reading trust on
// every render used to parse the same text again each time.
let cachedRaw: string | null | undefined = undefined;
let cachedStore: StoredExternalUrlTrust | null = null;

function readStore(): StoredExternalUrlTrust {
  if (typeof window === 'undefined') return emptyStore();
  let rawString: string | null;
  try {
    rawString = window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
  } catch {
    return emptyStore();
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
  return parsed;
}

function writeStore(store: StoredExternalUrlTrust): void {
  cachedRaw = JSON.stringify(store);
  cachedStore = store;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXTERNAL_URL_TRUST_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage can be unavailable or full; in-memory session approvals still work.
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

/** Hostname for http(s) URLs resolved against the page; null for non-http(s) or unparseable. */
export function getHostname(url: string): string | null {
  const parsed = resolveUrl(url);
  if (parsed == null) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname.toLowerCase();
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

export function isTrustedLinkHost(host: string): boolean {
  const normalized = host.toLowerCase();
  const store = readStore();
  return store.links.includes(normalized);
}

export function trustLinkHost(host: string): void {
  const normalized = host.toLowerCase();
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
    images: [...store.images, normalized],
  });
}

// Session trust for images lives in one shared place for the whole page, not
// in a single message. Each Markdown block wraps itself in its own provider,
// so provider state alone forgot the choice as soon as the next message
// rendered. This store is memory only: it ends when the page goes away, which
// is what "for the rest of the session" promises, and it holds exact image
// addresses for the same reason the remembered store does.
const sessionTrustedImageUrls = new Set<string>();
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
  sessionTrustedImageUrls.add(normalized);
  notifySessionTrustListeners();
}

export function isSessionImageUrlTrusted(url: string): boolean {
  const normalized = normalizeImageUrl(url);
  if (normalized == null) return false;
  return sessionTrustedImageUrls.has(normalized);
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
