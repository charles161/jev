import { describe, expect, it } from "vitest";
import { BoundedTtlCache } from "@/lib/server/response-cache";

describe("BoundedTtlCache (Blocker 7: bounded LRU + TTL cache)", () => {
  it("evicts least-recently-used entries when maxEntries is reached", () => {
    const cache = new BoundedTtlCache<string>({ maxEntries: 2, ttlMs: 10_000 });
    cache.set("a", "1", 1000);
    cache.set("b", "2", 1001);
    // Touch "a" so "b" becomes LRU
    expect(cache.get("a", 1002)).toBe("1");
    cache.set("c", "3", 1003);

    expect(cache.size).toBe(2);
    expect(cache.get("b", 1004)).toBeUndefined();
    expect(cache.get("a", 1004)).toBe("1");
    expect(cache.get("c", 1004)).toBe("3");
  });

  it("expires entries strictly after ttlMs", () => {
    const cache = new BoundedTtlCache<string>({ maxEntries: 10, ttlMs: 5_000 });
    cache.set("k", "val", 1000);
    expect(cache.get("k", 5999)).toBe("val");
    expect(cache.get("k", 6000)).toBeUndefined();
  });
});
