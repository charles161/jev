import { describe, expect, it } from "vitest";
import {
  getDecideRateLimiter,
  getDecideResponseCache,
  getDecideUpstreamBudget,
  hashDecideRequest,
  resetDecideStateForTests,
  UpstreamBudgetTracker,
} from "@/lib/server/decide-state";

function makeEnv(
  vars: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

describe("decide-state (UpstreamBudgetTracker & hashDecideRequest)", () => {
  it("enforces per-minute and per-day caps without consuming slots on rejected attempts", () => {
    const tracker = new UpstreamBudgetTracker();
    const env = makeEnv({
      JEV_UPSTREAM_MAX_PER_MINUTE: "2",
      JEV_UPSTREAM_MAX_PER_DAY: "3",
    });

    expect(tracker.tryConsume(1_000, env)).toEqual({ allowed: true });
    expect(tracker.tryConsume(2_000, env)).toEqual({ allowed: true });
    // 3rd call in same minute is blocked by minute_cap
    expect(tracker.tryConsume(3_000, env)).toEqual({
      allowed: false,
      reason: "minute_cap",
    });

    // After 1 minute passes (t = 61_000, minuteCutoff = 1_000 -> t=1_000 expires), 1 slot opens
    expect(tracker.tryConsume(61_000, env)).toEqual({ allowed: true });
    // Now 3 total calls within the day -> hits day_cap even after minute clears
    expect(tracker.tryConsume(200_000, env)).toEqual({
      allowed: false,
      reason: "day_cap",
    });

    // After 24h elapses past t=1_000, day window slides and allows another call
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(tracker.tryConsume(1_000 + oneDayMs, env)).toEqual({
      allowed: true,
    });
  });

  it("handles zero caps, invalid env values (fallback to defaults), and reset()", () => {
    const tracker = new UpstreamBudgetTracker();

    // Zero caps block immediately
    expect(
      tracker.tryConsume(
        1000,
        makeEnv({
          JEV_UPSTREAM_MAX_PER_MINUTE: "0",
          JEV_UPSTREAM_MAX_PER_DAY: "100",
        })
      )
    ).toEqual({ allowed: false, reason: "minute_cap" });

    expect(
      tracker.tryConsume(
        1000,
        makeEnv({
          JEV_UPSTREAM_MAX_PER_MINUTE: "100",
          JEV_UPSTREAM_MAX_PER_DAY: "0",
        })
      )
    ).toEqual({ allowed: false, reason: "day_cap" });

    // Negative / non-numeric / blank values fall back to defaults (120/min, 5000/day)
    const malformedEnv = makeEnv({
      JEV_UPSTREAM_MAX_PER_MINUTE: "-5",
      JEV_UPSTREAM_MAX_PER_DAY: "not-a-number",
    });
    for (let i = 0; i < 120; i += 1) {
      expect(tracker.tryConsume(10_000 + i, malformedEnv)).toEqual({
        allowed: true,
      });
    }
    expect(tracker.tryConsume(10_500, malformedEnv)).toEqual({
      allowed: false,
      reason: "minute_cap",
    });

    tracker.reset();
    expect(tracker.tryConsume(10_500, malformedEnv)).toEqual({ allowed: true });
  });

  it("hashes normalized decide requests deterministically across key order, casing, whitespace, and undefined fields", () => {
    const h1 = hashDecideRequest({
      mode: "classify_prompt",
      prompt: "  OAuth   Login Flow ",
      meta: { b: 2, a: "  API   Gateway ", omitted: undefined },
      list: ["  First ", "SECOND"],
    });
    const h2 = hashDecideRequest({
      list: ["first", "second"],
      meta: { a: "api gateway", b: 2 },
      prompt: "oauth login flow",
      mode: "CLASSIFY_PROMPT",
    });

    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);

    const h3 = hashDecideRequest({
      mode: "classify_prompt",
      prompt: "different prompt",
    });
    expect(h3).not.toBe(h1);
  });

  it("resetDecideStateForTests replaces rate limiter, response cache, and upstream budget singletons", () => {
    const prevLimiter = getDecideRateLimiter();
    const prevCache = getDecideResponseCache();
    const prevBudget = getDecideUpstreamBudget();

    prevCache.set("k", { ok: true });
    resetDecideStateForTests();

    expect(getDecideRateLimiter()).not.toBe(prevLimiter);
    expect(getDecideResponseCache()).not.toBe(prevCache);
    expect(getDecideResponseCache().get("k")).toBeUndefined();
    expect(getDecideUpstreamBudget()).not.toBe(prevBudget);
  });
});
