import { describe, expect, it } from "vitest";
import {
  buildRateLimitHeaders,
  SlidingWindowRateLimiter,
} from "@/lib/server/rate-limit";

describe("SlidingWindowRateLimiter & buildRateLimitHeaders", () => {
  it("allows requests up to maxRequests and blocks excess with accurate Retry-After and resetAtMs", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 10_000,
      maxRequests: 3,
    });

    const r1 = limiter.check("ip:1", 1000);
    expect(r1).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetAtMs: 11_000,
      retryAfterSeconds: 0,
    });

    const r2 = limiter.check("ip:1", 2000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check("ip:1", 3000);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request within window is denied; oldest in window is 1000 so resetAtMs is 11000
    const r4 = limiter.check("ip:1", 3500);
    expect(r4).toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAtMs: 11_000,
      retryAfterSeconds: 8, // ceil((11000 - 3500) / 1000)
    });

    // Separate key is completely unaffected
    expect(limiter.check("ip:2", 3500).allowed).toBe(true);
  });

  it("slides the window cleanly as old requests expire at ts + windowMs", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 10_000,
      maxRequests: 2,
    });

    expect(limiter.check("k", 1000).allowed).toBe(true);
    expect(limiter.check("k", 5000).allowed).toBe(true);
    expect(limiter.check("k", 10_999).allowed).toBe(false);

    // At t = 11_000, cutoff = 1000, strict `ts > cutoff` expires the t=1000 hit
    const afterFirstExpires = limiter.check("k", 11_000);
    expect(afterFirstExpires.allowed).toBe(true);
    expect(afterFirstExpires.remaining).toBe(0);
    expect(afterFirstExpires.resetAtMs).toBe(15_000);

    // Next hit is blocked until t=5000 expires at t=15_000
    expect(limiter.check("k", 14_999).allowed).toBe(false);
    expect(limiter.check("k", 15_000).allowed).toBe(true);
  });

  it("evicts the least-recently-used active key when maxEntries is reached", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxEntries: 2,
    });

    // Fill key A (1 hit) and key B (2 hits -> full)
    limiter.check("A", 1000);
    limiter.check("B", 1001);
    limiter.check("B", 1002);
    expect(limiter.check("B", 1003).allowed).toBe(false);

    // Touch A so B is now LRU? No: B was just touched at 1003, so touch A at 1004 to make B LRU
    expect(limiter.check("A", 1004).allowed).toBe(true);
    expect(limiter.check("A", 1005).allowed).toBe(false);

    // Insert C at 1006 -> should evict B (LRU), keeping A (which remains blocked)
    expect(limiter.check("C", 1006).allowed).toBe(true);
    expect(limiter.check("A", 1007).allowed).toBe(false);
    // B was evicted so its bucket was cleared and starts fresh
    expect(limiter.check("B", 1008).allowed).toBe(true);
  });

  it("prunes expired buckets before evicting active keys when full", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 5_000,
      maxRequests: 1,
      maxEntries: 2,
    });

    limiter.check("stale", 1000);
    limiter.check("active", 4000);

    // At t = 7000, "stale" expired (7000 - 5000 = 2000 >= 1000) while "active" is still valid
    expect(limiter.check("fresh", 7000).allowed).toBe(true);
    // "active" must NOT have been evicted because "stale" was pruned first
    expect(limiter.check("active", 7001).allowed).toBe(false);
  });

  it("handles maxRequests = 0 safely without allowing any request", () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 10_000,
      maxRequests: 0,
    });
    const res = limiter.check("k", 5000);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("formats X-RateLimit-* headers and includes Retry-After only when blocked", () => {
    const allowedHeaders = buildRateLimitHeaders({
      allowed: true,
      limit: 30,
      remaining: 29,
      resetAtMs: 1_700_000_000_123,
      retryAfterSeconds: 0,
    });
    expect(allowedHeaders).toEqual({
      "X-RateLimit-Limit": "30",
      "X-RateLimit-Remaining": "29",
      "X-RateLimit-Reset": "1700000001",
    });
    expect(allowedHeaders["Retry-After"]).toBeUndefined();

    const blockedHeaders = buildRateLimitHeaders({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAtMs: 1_700_000_060_000,
      retryAfterSeconds: 45,
    });
    expect(blockedHeaders).toEqual({
      "X-RateLimit-Limit": "30",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1700000060",
      "Retry-After": "45",
    });
  });
});
