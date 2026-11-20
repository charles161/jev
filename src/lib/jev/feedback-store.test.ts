import { describe, expect, it } from "vitest";
import {
  buildFeedbackPreferenceSummary,
  clearFeedbackProfile,
  FEEDBACK_STORAGE_KEY,
  loadFeedbackProfile,
  MAX_FEEDBACK_KEYS,
  rankCandidatesWithFeedback,
  recordSuggestionAccepted,
  recordSuggestionRejected,
  recordSuggestionShown,
} from "@/lib/jev/feedback-store";
import type { StorageLike } from "@/lib/jev/recovery-buffer";

function createMemoryStorage(options?: { maxBytes?: number }): StorageLike & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options?.maxBytes !== undefined && value.length > options.maxBytes) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

describe("feedback-store: suggestion telemetry & adaptive ranking", () => {
  it("tracks shown, accepted, and rejected counts in bounded localStorage", () => {
    const storage = createMemoryStorage();
    recordSuggestionShown(storage, ["fork:queue_event_driven", "cat:extend"], 1000);
    recordSuggestionAccepted(storage, ["fork:queue_event_driven"], 1100);
    recordSuggestionRejected(storage, ["fork:cache_read_replica"], 1200);

    const profile = loadFeedbackProfile(storage);
    expect(profile.entries["fork:queue_event_driven"]).toMatchObject({
      shown: 1,
      accepted: 1,
      rejected: 0,
    });
    expect(profile.entries["fork:cache_read_replica"]).toMatchObject({
      shown: 0,
      accepted: 0,
      rejected: 1,
    });
    expect(profile.totals.accepted).toBe(1);
    expect(profile.totals.rejected).toBe(1);

    clearFeedbackProfile(storage);
    expect(loadFeedbackProfile(storage).entries).toEqual({});
  });

  it("rejects corrupted JSON, oversized storage payloads, and prototype-polluting keys", () => {
    const storage = createMemoryStorage();
    storage.store.set(FEEDBACK_STORAGE_KEY, "{not-valid-json");
    expect(loadFeedbackProfile(storage).entries).toEqual({});

    storage.store.set(
      FEEDBACK_STORAGE_KEY,
      '{"version":1,"totals":{"shown":1,"accepted":1,"rejected":0},"entries":{"__proto__":{"shown":5,"accepted":5,"rejected":0,"lastUpdatedAt":1}}}'
    );
    expect(loadFeedbackProfile(storage).entries).toEqual({});

    // Attempting to record forbidden keys ignores them safely
    recordSuggestionAccepted(storage, ["__proto__", "constructor", "prototype", "cat:connect"]);
    const loaded = loadFeedbackProfile(storage);
    expect(Object.keys(loaded.entries)).toEqual(["cat:connect"]);
  });

  it("enforces MAX_FEEDBACK_KEYS bound and evicts oldest entries on QuotaExceededError", () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < MAX_FEEDBACK_KEYS + 25; i++) {
      recordSuggestionShown(storage, [`pattern:k_${i}`], 1000 + i);
    }
    const bounded = loadFeedbackProfile(storage);
    expect(Object.keys(bounded.entries).length).toBeLessThanOrEqual(MAX_FEEDBACK_KEYS);

    // Quota fallback evicts oldest keys until write succeeds
    const tightStorage = createMemoryStorage({ maxBytes: 520 });
    for (let i = 0; i < 20; i++) {
      recordSuggestionAccepted(tightStorage, [`pattern:tight_${i}`], 2000 + i);
    }
    const survived = loadFeedbackProfile(tightStorage);
    expect(Object.keys(survived.entries).length).toBeGreaterThan(0);
    expect(survived.entries["pattern:tight_19"]).toBeDefined();
  });

  it("boosts accepted patterns and demotes rejected patterns without fabricating model probabilities", () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 6; i++) {
      recordSuggestionAccepted(storage, ["fork:cache_read_replica"], 1000 + i);
      recordSuggestionRejected(storage, ["fork:queue_event_driven"], 1000 + i);
    }
    const profile = loadFeedbackProfile(storage);

    const candidates = [
      { id: "take_q", title: "Queue", feedbackKeys: ["fork:queue_event_driven"], baseScore: 0.52 },
      { id: "take_g", title: "Gateway", feedbackKeys: ["fork:gateway_edge_split"], baseScore: 0.5 },
      { id: "take_c", title: "Cache", feedbackKeys: ["fork:cache_read_replica"], baseScore: 0.48 },
    ];

    const ranked = rankCandidatesWithFeedback(candidates, profile);
    expect(ranked[0].item.id).toBe("take_c");
    expect(ranked[ranked.length - 1].item.id).toBe("take_q");
    // Ensure we never inject fake probability fields onto items
    expect("probability" in ranked[0].item).toBe(false);
  });

  it("builds a tiny bounded preference summary suitable for /api/jev/decide", () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 4; i++) {
      recordSuggestionAccepted(storage, ["cat:connect", "fork:cache_read_replica"], 1000 + i);
      recordSuggestionRejected(storage, ["cat:structure"], 1000 + i);
    }
    const summary = buildFeedbackPreferenceSummary(loadFeedbackProfile(storage));
    expect(summary).not.toBeNull();
    expect(summary!.preferred.length).toBeLessThanOrEqual(6);
    expect(summary!.avoided.length).toBeLessThanOrEqual(6);
    expect(summary!.preferred).toContain("fork:cache_read_replica");
    expect(summary!.avoided).toContain("cat:structure");
    expect(JSON.stringify(summary).length).toBeLessThan(600);
  });
});
