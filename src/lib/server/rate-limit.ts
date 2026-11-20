export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  maxEntries?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

/**
 * Bounded per-key sliding-window rate limiter.
 * Keeps memory capped at `maxEntries` by pruning stale windows and evicting
 * least-recently-used keys when full.
 */
export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxEntries: number;
  private readonly buckets = new Map<string, number[]>();
  private lastPruneMs = 0;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this.maxEntries = config.maxEntries ?? 2000;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const cutoff = now - this.windowMs;

    if (now - this.lastPruneMs > this.windowMs || this.buckets.size >= this.maxEntries) {
      this.prune(cutoff);
      this.lastPruneMs = now;
    }

    const existing = this.buckets.get(key);
    const active = existing ? existing.filter((ts) => ts > cutoff) : [];

    // Refresh insertion order for LRU eviction
    if (existing !== undefined) {
      this.buckets.delete(key);
    } else if (this.buckets.size >= this.maxEntries) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      }
    }

    if (active.length >= this.maxRequests) {
      this.buckets.set(key, active);
      const oldestInWindow = active[0] ?? now;
      const resetAtMs = oldestInWindow + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAtMs,
        retryAfterSeconds,
      };
    }

    active.push(now);
    this.buckets.set(key, active);

    const oldestInWindow = active[0] ?? now;
    const resetAtMs = oldestInWindow + this.windowMs;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - active.length),
      resetAtMs,
      retryAfterSeconds: 0,
    };
  }

  private prune(cutoff: number): void {
    for (const [key, timestamps] of this.buckets.entries()) {
      const filtered = timestamps.filter((ts) => ts > cutoff);
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else if (filtered.length !== timestamps.length) {
        this.buckets.set(key, filtered);
      }
    }
  }
}

export function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAtMs / 1000)),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}
