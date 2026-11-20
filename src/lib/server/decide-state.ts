import { createHash } from "node:crypto";
import { SlidingWindowRateLimiter } from "@/lib/server/rate-limit";
import { BoundedTtlCache } from "@/lib/server/response-cache";

let decideRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  maxEntries: 2000,
});

let decideResponseCache = new BoundedTtlCache<Record<string, unknown>>({
  maxEntries: 500,
  ttlMs: 30_000,
});

export function getDecideRateLimiter(): SlidingWindowRateLimiter {
  return decideRateLimiter;
}

export function getDecideResponseCache(): BoundedTtlCache<
  Record<string, unknown>
> {
  return decideResponseCache;
}

export function resetDecideStateForTests(): void {
  decideRateLimiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    maxEntries: 2000,
  });
  decideResponseCache = new BoundedTtlCache<Record<string, unknown>>({
    maxEntries: 500,
    ttlMs: 30_000,
  });
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = canonicalizeValue(v);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Produces a deterministic SHA-256 cache key for normalized /api/jev/decide
 * inputs so repeated/equivalent board states reuse cached upstream decisions.
 */
export function hashDecideRequest(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalizeValue(input));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
