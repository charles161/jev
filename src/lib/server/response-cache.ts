export interface BoundedTtlCacheConfig {
  maxEntries: number;
  ttlMs: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

/**
 * Bounded LRU + TTL cache for server-side decision responses.
 * Caps total entries so memory cannot grow unboundedly and expires stale
 * responses automatically.
 */
export class BoundedTtlCache<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(config: BoundedTtlCacheConfig) {
    this.maxEntries = config.maxEntries;
    this.ttlMs = config.ttlMs;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (now >= entry.expiresAtMs) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh LRU position
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      this.pruneExpired(now);
      if (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
        }
      }
    }

    this.store.set(key, {
      value,
      expiresAtMs: now + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private pruneExpired(now: number): void {
    for (const [k, entry] of this.store.entries()) {
      if (now >= entry.expiresAtMs) {
        this.store.delete(k);
      }
    }
  }
}
