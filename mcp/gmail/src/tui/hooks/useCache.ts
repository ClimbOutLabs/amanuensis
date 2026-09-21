// Simple in-memory LRU keyed by string. Bytes estimated via JSON.stringify.
// Two separate caches per consumer (messages + threads) — instantiate once at
// the app root and pass via context / props.

interface CacheEntry<T> {
  value: T;
  bytes: number;
  lastAccess: number;
}

export class LruCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;
  constructor(public readonly capacityBytes: number) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    // Re-insert to mark as most-recent (Map preserves insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  put(key: string, value: T): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const existing = this.map.get(key);
    if (existing) this.totalBytes -= existing.bytes;
    this.map.set(key, { value, bytes, lastAccess: Date.now() });
    this.totalBytes += bytes;
    while (this.totalBytes > this.capacityBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      if (oldest) this.totalBytes -= oldest.bytes;
      this.map.delete(oldestKey);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  stats(): { entries: number; bytes: number; capacityBytes: number } {
    return { entries: this.map.size, bytes: this.totalBytes, capacityBytes: this.capacityBytes };
  }
}

export function accountScopedCacheKey(accountId: string | null | undefined, id: string): string {
  return `${accountId || "unknown"}:${id}`;
}

export function defaultCacheBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GMAIL_TUI_CACHE_MB;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const mb = Number.isFinite(n) && n > 0 ? n : 50;
  return mb * 1024 * 1024;
}
