import { describe, expect, it } from "vitest";
import {
  generateCandidatePool,
  generatePredictions,
  serializeCanvasStateForJev,
} from "@/lib/jev/prediction-engine";
import type { JevElement, SpatialIntent } from "@/lib/jev/types";

function makeEl(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: overrides.id ?? "el_1",
    kind: overrides.kind ?? "node",
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    width: overrides.width ?? 160,
    height: overrides.height ?? 72,
    label: overrides.label ?? "API Gateway",
    tone: overrides.tone ?? "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<SpatialIntent>): SpatialIntent {
  return {
    kind: overrides.kind ?? "domain_continue",
    headline: overrides.headline ?? "Test intent",
    detail: overrides.detail ?? "Detail",
    relatedIds: overrides.relatedIds ?? [],
    timestamp: 1000,
    ...overrides,
  };
}

describe("prediction-engine", () => {
  it("returns empty arrays for null intent, empty elements, or arrow-only boards", () => {
    const node = makeEl({ id: "n1" });
    expect(generatePredictions(null, [node])).toEqual([]);
    expect(generatePredictions(makeIntent({ subjectId: "n1" }), [])).toEqual([]);
    expect(generateCandidatePool(null, [node])).toEqual([]);

    const arrowOnly = makeEl({ id: "a1", kind: "arrow", fromId: "x", toId: "y" });
    expect(
      generatePredictions(makeIntent({ kind: "domain_continue" }), [arrowOnly])
    ).toEqual([]);
  });

  it("generates splice, parallel branch, and wrapper frame actions for splice_into_edge", () => {
    const a = makeEl({ id: "a", x: 0, y: 100, label: "Client" });
    const b = makeEl({ id: "b", x: 500, y: 100, label: "Postgres" });
    const mid = makeEl({ id: "m", x: 250, y: 100, label: "Cache" });
    const edge = makeEl({ id: "e1", kind: "arrow", fromId: "a", toId: "b" });

    const preds = generatePredictions(
      makeIntent({
        kind: "splice_into_edge",
        subjectId: "m",
        relatedIds: ["e1", "a", "b"],
      }),
      [a, b, mid, edge]
    );

    expect(preds).toHaveLength(3);
    expect(preds[0].removeIds).toEqual(["e1"]);
    expect(preds[0].addElements).toHaveLength(2);
    expect(preds[0].addElements[0].fromId).toBe("a");
    expect(preds[0].addElements[0].toId).toBe("m");
    expect(preds[0].addElements[1].fromId).toBe("m");
    expect(preds[0].addElements[1].toId).toBe("b");
    expect(preds[1].addElements[0].dashed).toBe(true);
    expect(preds[2].addElements[0].kind).toBe("frame");
  });

  it("generates domain-aware gap insertion, decision gate, and frame for open_pipeline_gap", () => {
    const api = makeEl({ id: "api", x: 0, y: 100, label: "API Server" });
    const db = makeEl({ id: "db", x: 520, y: 100, label: "Postgres DB", kind: "database" });
    const edge = makeEl({ id: "e1", kind: "arrow", fromId: "api", toId: "db" });

    const preds = generatePredictions(
      makeIntent({
        kind: "open_pipeline_gap",
        subjectId: "db",
        relatedIds: ["api", "e1"],
      }),
      [api, db, edge]
    );

    expect(preds).toHaveLength(3);
    expect(preds[0].title).toContain("Redis Cache");
    expect(preds[0].removeIds).toEqual(["e1"]);
    expect(preds[1].addElements.some((e) => e.kind === "diamond")).toBe(true);
    expect(preds[2].addElements[0].kind).toBe("frame");
  });

  it("generates Yes/No split, error handler, and audit log for decision_branch", () => {
    const check = makeEl({ id: "chk", kind: "diamond", label: "Authorized?" });
    const preds = generatePredictions(
      makeIntent({ kind: "decision_branch", subjectId: "chk" }),
      [check]
    );

    expect(preds).toHaveLength(3);
    expect(preds[0].addElements.filter((e) => e.kind === "arrow")).toHaveLength(2);
    expect(preds[1].title).toContain("Error Handler");
    expect(preds[2].addElements[0].kind).toBe("database");
  });

  it("handles align_pipeline (unlinked vs already-linked), branch_out, align_column, and connect_nearby", () => {
    const peer = makeEl({ id: "p", x: 100, y: 100, label: "Client" });
    const subject = makeEl({ id: "s", x: 350, y: 112, label: "API Gateway" });

    // Unlinked align_pipeline snaps y and wires arrow
    const unlinkedAlign = generatePredictions(
      makeIntent({ kind: "align_pipeline", subjectId: "s", relatedIds: ["p"] }),
      [peer, subject]
    );
    expect(unlinkedAlign).toHaveLength(3);
    expect(unlinkedAlign[0].patchElements?.[0]).toEqual({ id: "s", y: 100 });
    expect(unlinkedAlign[0].addElements[0].kind).toBe("arrow");

    // Already linked align_pipeline extends downstream instead of duplicating edge
    const link = makeEl({ id: "lnk", kind: "arrow", fromId: "p", toId: "s" });
    const linkedAlign = generatePredictions(
      makeIntent({ kind: "align_pipeline", subjectId: "s", relatedIds: ["p"] }),
      [peer, subject, link]
    );
    expect(linkedAlign).toHaveLength(3);
    expect(linkedAlign[0].category).toBe("extend");

    // branch_out without peer attaches a context-named store below as 3rd option
    const soloBranch = generatePredictions(
      makeIntent({ kind: "branch_out", subjectId: "s", relatedIds: [] }),
      [subject]
    );
    expect(soloBranch.length).toBeGreaterThanOrEqual(2);
    const storeOption = soloBranch.find((a) => /^Attach .+ below$/.test(a.title));
    expect(storeOption?.addElements[0].kind).toBe("database");
    expect(storeOption?.title).not.toContain("Data Store");

    // connect_nearby offers one-way, bidirectional, and frame
    const nearby = generatePredictions(
      makeIntent({ kind: "connect_nearby", subjectId: "s", relatedIds: ["p"] }),
      [peer, subject]
    );
    expect(nearby).toHaveLength(3);
    expect(nearby[1].addElements[0].bidirectional).toBe(true);
    expect(nearby[2].addElements[0].kind).toBe("frame");
  });

  it("frames a 3+ node cluster on domain_continue when no frame exists and avoids duplicating existing labels", () => {
    const n1 = makeEl({ id: "n1", x: 0, y: 0, label: "Redis Cache" });
    const n2 = makeEl({ id: "n2", x: 250, y: 0, label: "Core Service" });
    const n3 = makeEl({ id: "n3", x: 500, y: 0, label: "API Gateway" });

    const preds = generatePredictions(
      makeIntent({ kind: "domain_continue", subjectId: "n3" }),
      [n1, n2, n3]
    );

    expect(preds).toHaveLength(3);
    // Should not suggest "Redis Cache" or "Core Service" since they already exist on canvas
    const addedLabels = preds
      .flatMap((p) => p.addElements)
      .filter((e) => e.kind !== "arrow" && e.kind !== "frame")
      .map((e) => e.label);
    expect(addedLabels).not.toContain("Redis Cache");
    expect(addedLabels).not.toContain("Core Service");
    // 3rd option wraps cluster in Core Architecture frame
    expect(preds[2].addElements[0].kind).toBe("frame");
  });

  it("generateCandidatePool expands diverse unique titles without fabricating probabilities", () => {
    const n1 = makeEl({ id: "n1", label: "User Browser" });
    const pool = generateCandidatePool(
      makeIntent({ kind: "domain_continue", subjectId: "n1" }),
      [n1]
    );

    expect(pool.length).toBeGreaterThanOrEqual(3);
    expect(pool.length).toBeLessThanOrEqual(6);
    const titles = pool.map((a) => a.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const action of pool) {
      expect(action.probability).toBeUndefined();
    }
  });

  it("serializes canvas state concisely for Jev and caps node/edge/frame counts", () => {
    const manyNodes = Array.from({ length: 30 }, (_, i) =>
      makeEl({ id: `n_${i}`, x: i * 10, y: 0, label: `Node ${i}` })
    );
    const manyArrows = Array.from({ length: 30 }, (_, i) =>
      makeEl({
        id: `a_${i}`,
        kind: "arrow",
        fromId: `n_${i}`,
        toId: `n_${(i + 1) % 30}`,
        label: i === 0 ? "rpc" : "",
        bidirectional: i === 1,
      })
    );
    const manyFrames = Array.from({ length: 10 }, (_, i) =>
      makeEl({ id: `f_${i}`, kind: "frame", label: `Zone ${i}` })
    );

    const summary = serializeCanvasStateForJev(
      makeIntent({
        kind: "align_pipeline",
        subjectId: "n_0",
        headline: "Aligned row",
        detail: "Moved +120px right",
        delta: { dx: 120.4, dy: -2.2, distance: 120.4 },
      }),
      [...manyNodes, ...manyArrows, ...manyFrames]
    );

    expect(summary).toContain("Nodes (30):");
    expect(summary).toContain("Connections (30):");
    expect(summary).toContain('Subject: [node] "Node 0"');
    expect(summary).toContain("Drag delta: dx=120px, dy=-2px");
    // Capped at 24 nodes, 24 edges, 8 zones
    expect(summary).not.toContain('"Node 25"');
    expect(summary).not.toContain('Zone "Zone 9"');
  });
});
