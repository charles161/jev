import { describe, expect, it } from "vitest";
import {
  buildConstraintForkTakes,
  buysLine,
  FORK_PATTERN_CATALOGUE,
  rankForkPatterns,
} from "@/lib/jev/fork-catalogue";
import { FORK_COST_AXES, FORK_PRESSURES, parseForkConstraint, type ForkPressure } from "@/lib/jev/fork-constraint";
import { applyForkTakeToBoard, validateForkTakesPayload } from "@/lib/jev/fork-engine";
import { rectsOverlap } from "@/lib/jev/geometry";
import { validateLayoutElements, validateSemanticGraph } from "@/lib/jev/semantic-graph";
import type { JevElement } from "@/lib/jev/types";

function el(overrides: Partial<JevElement>): JevElement {
  return {
    id: "x",
    kind: "node",
    x: 0,
    y: 0,
    width: 168,
    height: 72,
    label: "",
    tone: "cobalt",
    seed: 1,
    createdAt: 1,
    updatedAt: 1,
    rev: 1,
    ...overrides,
  };
}

const board: JevElement[] = [
  el({ id: "client", kind: "actor", x: 0, y: 180, label: "Mobile App" }),
  el({ id: "api", x: 260, y: 180, label: "Orders API" }),
  el({ id: "db", kind: "database", x: 520, y: 180, label: "Orders DB" }),
  el({ id: "a_in", kind: "arrow", fromId: "client", toId: "api", label: "HTTPS" }),
  el({ id: "a_mid", kind: "arrow", fromId: "api", toId: "db", label: "SQL" }),
];

const EXPECTED_FIRST_CHOICES: Record<ForkPressure, string[]> = {
  latency: ["cache_aside", "cdn_edge", "read_replicas", "fanout_on_write", "regional_deploy"],
  scale: ["sharding", "queue_workers", "fanout_on_read", "fanout_on_write"],
  consistency: ["single_leader_sync", "outbox_cdc", "idempotency_saga"],
  cost: ["serverless_batch", "tiered_storage", "autoscale"],
  availability: ["multi_az_lb", "circuit_breaker_fallback", "queue_buffering"],
};

describe("fork-catalogue: real patterns mapped to the pressures they serve and what they cost", () => {
  it("every pattern lists all five cost axes with a 1-3 severity, a failure mode, and draws a valid graph", () => {
    expect(FORK_PATTERN_CATALOGUE.length).toBeGreaterThanOrEqual(17);
    for (const p of FORK_PATTERN_CATALOGUE) {
      expect(p.costs.map((c) => c.axis), p.id).toEqual([...FORK_COST_AXES]);
      for (const c of p.costs) {
        expect([1, 2, 3], `${p.id}.${c.axis}`).toContain(c.severity);
        expect(c.text.length, `${p.id}.${c.axis}`).toBeGreaterThan(3);
        expect(c.text.length, `${p.id}.${c.axis}: keep cost lines short enough to read in a HUD column`).toBeLessThanOrEqual(34);
      }
      expect(p.failureMode.length, p.id).toBeGreaterThan(10);
      expect(Object.keys(p.serves).length, p.id).toBeGreaterThan(0);
    }
  });

  it("ranks three distinct patterns that primarily serve the stated pressure", () => {
    for (const pressure of FORK_PRESSURES) {
      const ranked = rankForkPatterns({ pressure });
      expect(ranked, pressure).toHaveLength(3);
      expect(new Set(ranked.map((p) => p.id)).size).toBe(3);
      for (const p of ranked) {
        expect(EXPECTED_FIRST_CHOICES[pressure], `${pressure} -> ${p.id}`).toContain(p.id);
        expect(p.serves[pressure], `${pressure} -> ${p.id}`).toBe(3);
      }
    }
  });

  it("lets the stated number reorder the ranking", () => {
    expect(rankForkPatterns(parseForkConstraint("p99 < 20 ms")!)[0].id).toBe("cache_aside");
    expect(rankForkPatterns(parseForkConstraint("1B writes/day")!)[0].id).toBe("sharding");
    expect(rankForkPatterns(parseForkConstraint("1B reads/day")!).map((p) => p.id)).toContain("fanout_on_write");
    expect(rankForkPatterns(parseForkConstraint("strong consistency")!)[0].id).toBe("single_leader_sync");
  });

  it("builds three takes whose buy line answers the stated number as a typical range", () => {
    const latency = buildConstraintForkTakes(["api", "db"], board, parseForkConstraint("p99 < 100 ms")!, 1000)!;
    expect(latency.takes).toHaveLength(3);
    expect(latency.isHeuristic).toBe(true);
    expect(latency.constraint?.pressure).toBe("latency");
    const cache = latency.takes.find((t) => t.archetype === "cache_aside")!;
    expect(cache.tradeoffs!.buys).toMatch(/5-20 ms/);
    expect(cache.tradeoffs!.buys).toMatch(/50-150 ms/);
    expect(cache.tradeoffs!.buys).toMatch(/100 ms/);
    expect(cache.tradeoffs!.buys.toLowerCase()).toContain("typical");

    const scale = buildConstraintForkTakes(["api", "db"], board, parseForkConstraint("10M writes/day")!, 1000)!;
    expect(scale.takes[0].tradeoffs!.buys).toMatch(/116/);

    const avail = buildConstraintForkTakes(["api", "db"], board, parseForkConstraint("99.99%")!, 1000)!;
    expect(avail.takes.find((t) => t.archetype === "multi_az_lb")!.tradeoffs!.buys).toMatch(/52\.6 min/);

    const cost = buildConstraintForkTakes(["api", "db"], board, parseForkConstraint("$500/mo")!, 1000)!;
    expect(cost.takes.some((t) => t.tradeoffs!.buys.includes("$500/mo"))).toBe(true);
  });

  it("keeps every buy line short enough to read in three lines of a HUD column", () => {
    const samples = ["p99 < 100 ms", "10M writes/day", "$500/mo", "99.99%", "strong consistency"];
    for (const text of samples) {
      const c = parseForkConstraint(text)!;
      for (const p of FORK_PATTERN_CATALOGUE) {
        expect(buysLine(p, c).length, `${p.id} @ ${text}: ${buysLine(p, c)}`).toBeLessThanOrEqual(120);
      }
    }
  });

  it("draws takes with the HLD kinds, valid non-overlapping layouts, and zones for multi-AZ", () => {
    const kindsSeen = new Set<string>();
    for (const pressure of FORK_PRESSURES) {
      const result = buildConstraintForkTakes(["api", "db"], board, { pressure }, 1000)!;
      for (const take of result.takes) {
        expect(validateSemanticGraph(take.graph).ok, take.archetype).toBe(true);
        expect(validateLayoutElements(take.elements, { externalElementIds: new Set(["client"]) }).ok, take.archetype).toBe(true);
        for (const e of take.elements) kindsSeen.add(e.kind);
        const shapes = take.elements.filter((e) => e.kind !== "arrow" && e.kind !== "frame" && e.kind !== "zone");
        for (let i = 0; i < shapes.length; i++) {
          for (let j = i + 1; j < shapes.length; j++) {
            expect(rectsOverlap(shapes[i], shapes[j]), `${take.archetype}: ${shapes[i].label} / ${shapes[j].label}`).toBe(false);
          }
        }
        expect(take.feedbackKeys).toContain(`fork:${take.archetype}`);
        expect(take.tradeoffTag.length).toBeGreaterThan(2);
      }
    }
    for (const kind of ["queue", "cache", "lb", "blob", "zone", "database"]) {
      expect(kindsSeen, kind).toContain(kind);
    }
  });

  it("keeps the selected nodes and rewires boundary arrows when a take is accepted", () => {
    const result = buildConstraintForkTakes(["api", "db"], board, { pressure: "availability" }, 1000)!;
    const take = result.takes.find((t) => t.archetype === "multi_az_lb")!;
    const next = applyForkTakeToBoard(board, result.replacedIds, take);
    const labels = next.filter((e) => e.kind !== "arrow").map((e) => e.label);
    expect(labels).toContain("Orders API");
    expect(labels).toContain("Mobile App");
    const zoneIdx = next.findIndex((e) => e.kind === "zone");
    const firstShapeIdx = next.findIndex((e) => e.kind !== "zone" && e.kind !== "frame");
    expect(zoneIdx).toBeGreaterThanOrEqual(0);
    expect(zoneIdx).toBeLessThan(firstShapeIdx);
    const ids = new Set(next.map((e) => e.id));
    expect(next.some((e) => e.kind === "arrow" && e.fromId === "client" && ids.has(e.toId ?? ""))).toBe(true);
  });

  it("works for a single selected node", () => {
    for (const pressure of FORK_PRESSURES) {
      const result = buildConstraintForkTakes(["api"], board, { pressure }, 1000);
      expect(result?.takes, pressure).toHaveLength(3);
    }
  });
});

describe("fork-engine: model takes must carry buys/costs/failure when a constraint is stated", () => {
  const graph = {
    notation: "architecture",
    summary: "s",
    nodes: [
      { id: "a", label: "API", kind: "node" },
      { id: "c", label: "Redis", kind: "cache" },
    ],
    edges: [{ from: "a", to: "c" }],
  };
  const costs = FORK_COST_AXES.map((axis) => ({ axis, text: `${axis} cost`, severity: 2 }));
  const take = (extra: Record<string, unknown>) => ({
    archetype: "cache_aside",
    title: "Cache-aside",
    rationale: "Serves hot reads from Redis",
    tradeoffTag: "Stale reads",
    graph,
    ...extra,
  });

  it("accepts complete trade-offs and maps them onto the take with the stated pressure", () => {
    const full = take({ buys: "p99 ≈ 5-20 ms on hit (typical)", costs, failureMode: "Stampede on cold cache" });
    const res = validateForkTakesPayload({ takes: [full, full, full] }, { constraint: { pressure: "latency" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.takes[0].tradeoffs).toEqual({
      pressure: "latency",
      buys: "p99 ≈ 5-20 ms on hit (typical)",
      costs,
      failureMode: "Stampede on cold cache",
    });
  });

  it("rejects takes missing trade-offs, or with a missing axis or out-of-range severity", () => {
    const opts = { constraint: { pressure: "latency" as const } };
    expect(validateForkTakesPayload({ takes: [take({}), take({}), take({})] }, opts).ok).toBe(false);
    const fourAxes = take({ buys: "b uys", costs: costs.slice(0, 4), failureMode: "fails badly" });
    expect(validateForkTakesPayload({ takes: [fourAxes, fourAxes, fourAxes] }, opts).ok).toBe(false);
    const badSeverity = take({
      buys: "b uys",
      costs: costs.map((c) => ({ ...c, severity: 4 })),
      failureMode: "fails badly",
    });
    expect(validateForkTakesPayload({ takes: [badSeverity, badSeverity, badSeverity] }, opts).ok).toBe(false);
    expect(validateForkTakesPayload({ takes: [take({}), take({}), take({})] }).ok).toBe(true);
  });
});
