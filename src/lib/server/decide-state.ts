import { createHash } from "node:crypto";
import { SlidingWindowRateLimiter } from "@/lib/server/rate-limit";
import { BoundedTtlCache } from "@/lib/server/response-cache";

const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPSTREAM_MAX_PER_MINUTE = 120;
const DEFAULT_UPSTREAM_MAX_PER_DAY = 5000;

function parseBudgetEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export class UpstreamBudgetTracker {
  private timestamps: number[] = [];

  tryConsume(
    now = Date.now(),
    env: NodeJS.ProcessEnv = process.env
  ): { allowed: true } | { allowed: false; reason: "minute_cap" | "day_cap" } {
    const maxPerMinute = parseBudgetEnv(
      env.JEV_UPSTREAM_MAX_PER_MINUTE,
      DEFAULT_UPSTREAM_MAX_PER_MINUTE
    );
    const maxPerDay = parseBudgetEnv(
      env.JEV_UPSTREAM_MAX_PER_DAY,
      DEFAULT_UPSTREAM_MAX_PER_DAY
    );

    const dayCutoff = now - ONE_DAY_MS;
    if (this.timestamps.length > 0) {
      let firstValid = 0;
      while (
        firstValid < this.timestamps.length &&
        this.timestamps[firstValid] <= dayCutoff
      ) {
        firstValid += 1;
      }
      if (firstValid > 0) {
        this.timestamps = this.timestamps.slice(firstValid);
      }
    }

    if (maxPerDay <= 0 || this.timestamps.length >= maxPerDay) {
      return { allowed: false, reason: "day_cap" };
    }

    const minuteCutoff = now - ONE_MINUTE_MS;
    let minuteCount = 0;
    for (let i = this.timestamps.length - 1; i >= 0; i -= 1) {
      if (this.timestamps[i] > minuteCutoff) {
        minuteCount += 1;
      } else {
        break;
      }
    }

    if (maxPerMinute <= 0 || minuteCount >= maxPerMinute) {
      return { allowed: false, reason: "minute_cap" };
    }

    this.timestamps.push(now);
    return { allowed: true };
  }

  reset(): void {
    this.timestamps = [];
  }
}

let decideRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  maxEntries: 2000,
});

let decideResponseCache = new BoundedTtlCache<Record<string, unknown>>({
  maxEntries: 500,
  ttlMs: 30_000,
});

let decideUpstreamBudget = new UpstreamBudgetTracker();

export function getDecideRateLimiter(): SlidingWindowRateLimiter {
  return decideRateLimiter;
}

export function getDecideResponseCache(): BoundedTtlCache<
  Record<string, unknown>
> {
  return decideResponseCache;
}

export function getDecideUpstreamBudget(): UpstreamBudgetTracker {
  return decideUpstreamBudget;
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
  decideUpstreamBudget = new UpstreamBudgetTracker();
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
