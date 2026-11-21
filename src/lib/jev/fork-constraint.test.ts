import { describe, expect, it } from "vitest";
import {
  describeForkConstraint,
  FORK_PRESSURES,
  forkConstraintSchema,
  parseForkConstraint,
  targetPerSecond,
} from "@/lib/jev/fork-constraint";

describe("fork-constraint: parsing a stated pressure into a structured constraint", () => {
  it("reads latency targets with comparators and units, normalising seconds to ms", () => {
    expect(parseForkConstraint("p99 < 100 ms")).toEqual({
      pressure: "latency",
      target: { metric: "p99", comparator: "<", value: 100, unit: "ms", text: "p99 < 100 ms" },
      text: "p99 < 100 ms",
    });
    expect(parseForkConstraint("p95 under 250ms")?.target).toMatchObject({ metric: "p95", comparator: "<", value: 250 });
    expect(parseForkConstraint("latency <= 1.5 s")?.target).toMatchObject({
      metric: "latency",
      comparator: "<=",
      value: 1500,
      unit: "ms",
    });
    expect(parseForkConstraint("200 ms")?.target).toMatchObject({ metric: "latency", value: 200 });
  });

  it("reads throughput targets as scale, with magnitude suffixes and a per-second rate", () => {
    const c = parseForkConstraint("10M writes/day");
    expect(c?.pressure).toBe("scale");
    expect(c?.target).toMatchObject({ metric: "writes", value: 10_000_000, unit: "/day", text: "10M writes/day" });
    expect(Math.round(targetPerSecond(c!.target!)!)).toBe(116);

    expect(parseForkConstraint("50k rps")?.target).toMatchObject({ metric: "requests", value: 50_000, unit: "/s" });
    expect(parseForkConstraint("2 billion reads per month")?.target).toMatchObject({
      metric: "reads",
      value: 2_000_000_000,
      unit: "/month",
    });
    expect(parseForkConstraint("5k qps")?.pressure).toBe("scale");
  });

  it("reads budgets as cost, normalised to dollars per month", () => {
    expect(parseForkConstraint("$500/mo")).toEqual({
      pressure: "cost",
      target: { metric: "budget", comparator: "<=", value: 500, unit: "USD/mo", text: "$500/mo" },
      text: "$500/mo",
    });
    expect(parseForkConstraint("under $6k per year")?.target).toMatchObject({ value: 500, unit: "USD/mo" });
    expect(parseForkConstraint("$1.2k/month")?.target).toMatchObject({ value: 1200 });
  });

  it("reads uptime percentages and 'nines' as availability", () => {
    expect(parseForkConstraint("99.99%")).toEqual({
      pressure: "availability",
      target: { metric: "uptime", comparator: ">=", value: 99.99, unit: "%", text: "99.99%" },
      text: "99.99%",
    });
    expect(parseForkConstraint("five nines")?.target).toMatchObject({ value: 99.999 });
    expect(parseForkConstraint("99.9% uptime")?.pressure).toBe("availability");
  });

  it("reads consistency levels", () => {
    expect(parseForkConstraint("strong consistency")).toEqual({
      pressure: "consistency",
      target: { metric: "consistency", level: "strong", text: "strong consistency" },
      text: "strong consistency",
    });
    expect(parseForkConstraint("linearizable writes")?.target).toMatchObject({ level: "strong" });
    expect(parseForkConstraint("read-your-writes")?.target).toMatchObject({ level: "read-your-writes" });
    expect(parseForkConstraint("no double charge, exactly once")?.pressure).toBe("consistency");
  });

  it("falls back to a bare pressure for keywords, and returns null for text it cannot read", () => {
    expect(parseForkConstraint("make it cheaper")).toEqual({ pressure: "cost", text: "make it cheaper" });
    expect(parseForkConstraint("survive an AZ outage")).toEqual({
      pressure: "availability",
      text: "survive an AZ outage",
    });
    expect(parseForkConstraint("feels slow")?.pressure).toBe("latency");
    expect(parseForkConstraint("")).toBeNull();
    expect(parseForkConstraint("hello there")).toBeNull();
  });

  it("produces constraints the request schema accepts, and a short human label", () => {
    for (const text of ["p99 < 100 ms", "10M writes/day", "$500/mo", "99.99%", "strong consistency", "cheap"]) {
      const c = parseForkConstraint(text);
      expect(c, text).not.toBeNull();
      expect(forkConstraintSchema.safeParse(c).success, text).toBe(true);
    }
    expect(describeForkConstraint({ pressure: "latency" })).toBe("Latency");
    expect(describeForkConstraint(parseForkConstraint("p99 < 100 ms")!)).toBe("Latency · p99 < 100 ms");
    expect(FORK_PRESSURES).toEqual(["latency", "cost", "consistency", "scale", "availability"]);
  });
});
