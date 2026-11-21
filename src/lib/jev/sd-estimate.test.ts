import { describe, expect, it } from "vitest";
import {
  ESTIMATE_DEFAULTS,
  estimate,
  formatBytes,
  formatCount,
  formatEstimateCard,
  parseEstimateText,
} from "./sd-estimate";

describe("unit formatting", () => {
  it("formats counts with K / M / B at three significant figures", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(7)).toBe("7");
    expect(formatCount(2.5)).toBe("2.5");
    expect(formatCount(950)).toBe("950");
    expect(formatCount(11574.07)).toBe("11.6K");
    expect(formatCount(115740.7)).toBe("116K");
    expect(formatCount(100_000_000)).toBe("100M");
    expect(formatCount(1_000_000_000)).toBe("1B");
    expect(formatCount(1_250_000_000_000)).toBe("1.25T");
  });

  it("formats bytes in decimal units (back-of-envelope: 1 KB = 1000 B)", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(11_574_074)).toBe("11.6 MB");
    expect(formatBytes(1e12)).toBe("1 TB");
    expect(formatBytes(1.825e15)).toBe("1.83 PB");
  });
});

describe("estimate: hand-checked numbers", () => {
  // 100M DAU, 10 writes/user/day, 10:1 reads, 1 KB, 5 years, peak x3.
  const r = estimate({ dau: 100e6, writesPerUser: 10, readWriteRatio: 10, payloadBytes: 1000, retentionYears: 5, peakFactor: 3 });

  it("write QPS: 1e9 writes/day / 86 400 s = 11 574 avg, x3 = 34 722 peak", () => {
    expect(r.writesPerDay).toBe(1e9);
    expect(r.avgWriteQps).toBeCloseTo(11574.07, 1);
    expect(r.peakWriteQps).toBeCloseTo(34722.2, 1);
  });

  it("read QPS: 10 x the writes = 115 741 avg, 347 222 peak", () => {
    expect(r.avgReadQps).toBeCloseTo(115740.7, 1);
    expect(r.peakReadQps).toBeCloseTo(347222.2, 1);
  });

  it("storage: 1e9 x 1 KB = 1 TB/day, 365 TB/year, 1.825 PB over 5 years", () => {
    expect(r.storagePerDay).toBe(1e12);
    expect(r.storagePerYear).toBe(365e12);
    expect(r.storageTotal).toBe(1825e12);
  });

  it("bandwidth: ingress 11.6 MB/s, egress 116 MB/s (reads x payload)", () => {
    expect(r.ingressBytesPerSec).toBeCloseTo(11_574_074, 0);
    expect(r.egressBytesPerSec).toBeCloseTo(115_740_741, 0);
  });

  it("cache: 20% of a day's read volume = 0.2 x 1e10 reads x 1 KB = 2 TB", () => {
    expect(r.cacheBytes).toBe(2e12);
  });

  it("is deterministic and never NaN for zero inputs", () => {
    expect(estimate({ ...ESTIMATE_DEFAULTS, dau: 5e6 })).toEqual(estimate({ ...ESTIMATE_DEFAULTS, dau: 5e6 }));
    const zero = estimate({ ...ESTIMATE_DEFAULTS, dau: 0 });
    expect(Object.values(zero).every((v) => typeof v !== "number" || Number.isFinite(v))).toBe(true);
  });

  it("states its defaults", () => {
    expect(ESTIMATE_DEFAULTS).toEqual({
      dau: 1e6,
      writesPerUser: 10,
      readWriteRatio: 10,
      payloadBytes: 1000,
      retentionYears: 5,
      peakFactor: 3,
    });
  });
});

describe("parseEstimateText", () => {
  it("reads the classic one-liner", () => {
    const p = parseEstimateText("100M DAU, 10 writes/user/day, 1KB, 5y");
    expect(p.input).toEqual({ dau: 100e6, writesPerUser: 10, readWriteRatio: 10, payloadBytes: 1000, retentionYears: 5, peakFactor: 3 });
    expect(p.assumed).toEqual(["readWriteRatio", "peakFactor"]);
  });

  it("reads ratios, peaks, byte sizes and spelled-out units", () => {
    const p = parseEstimateText("50m daily active users, 2 posts per user per day, read:write 100:1, 500 bytes, 3 years, peak 2x");
    expect(p.input).toEqual({ dau: 50e6, writesPerUser: 2, readWriteRatio: 100, payloadBytes: 500, retentionYears: 3, peakFactor: 2 });
    expect(p.assumed).toEqual([]);
    expect(parseEstimateText("1.5B DAU 2.5 KB 10x peak 20 reads per write").input).toMatchObject({
      dau: 1.5e9,
      payloadBytes: 2500,
      peakFactor: 10,
      readWriteRatio: 20,
    });
  });

  it("does not read the M of 100M DAU as megabytes", () => {
    expect(parseEstimateText("100M DAU").input.payloadBytes).toBe(ESTIMATE_DEFAULTS.payloadBytes);
  });

  it("falls back to every default for empty text", () => {
    const p = parseEstimateText("");
    expect(p.input).toEqual(ESTIMATE_DEFAULTS);
    expect(p.assumed).toHaveLength(6);
  });
});

describe("formatEstimateCard", () => {
  it("shows each result with its arithmetic, in sane units, within the sublabel limit", () => {
    const card = formatEstimateCard(parseEstimateText("100M DAU, 10 writes/user/day, 1KB, 5y"));
    expect(card.label).toBe("Numbers · 100M DAU");
    const lines = card.sublabel.split("\n");
    expect(lines[0]).toBe("Writes: 100M DAU × 10 / 86 400 s ≈ 11.6K QPS (peak ×3 ≈ 34.7K)");
    expect(lines[1]).toBe("Reads: 11.6K × 10 ≈ 116K QPS (peak ≈ 347K)");
    expect(lines[2]).toBe("Storage: 1B writes/day × 1 KB ≈ 1 TB/day, 365 TB/yr");
    expect(lines[3]).toBe("Total over 5 y: 365 TB × 5 ≈ 1.83 PB");
    expect(lines[4]).toBe("Bandwidth: in ≈ 11.6 MB/s, out 116K × 1 KB ≈ 116 MB/s");
    expect(lines[5]).toBe("Cache (20% hot): 10B reads/day × 1 KB × 0.2 ≈ 2 TB");
    expect(lines[6]).toBe("Assumed: read:write 10:1, peak ×3");
    expect(card.sublabel.length).toBeLessThanOrEqual(500);
  });

  it("omits the assumptions line when everything was stated", () => {
    const card = formatEstimateCard(parseEstimateText("1M DAU 1 writes/user/day 100:1 2KB 1y peak 4x"));
    expect(card.sublabel).not.toContain("Assumed");
  });
});
