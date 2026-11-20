import { describe, expect, it } from "vitest";
import {
  buildLocalSemanticGraphFromPrompt,
  computeBoardGraphHash,
  layoutSemanticGraphToElements,
  parseSemanticGraphJson,
  semanticGraphSchema,
  serializeBoardToGraph,
  validateLayoutElements,
  validateSemanticGraph,
  type BoardEditDelta,
  type SemanticGraph,
} from "@/lib/jev/semantic-graph";
import { getElementRect, isShapeElement, rectsOverlap } from "@/lib/jev/geometry";
import type { JevElement } from "@/lib/jev/types";

function makeEl(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: overrides.id ?? "el_1",
    kind: overrides.kind ?? "node",
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    width: overrides.width ?? 168,
    height: overrides.height ?? 72,
    label: overrides.label ?? "API Gateway",
    tone: overrides.tone ?? "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 1,
    ...overrides,
  };
}

describe("semantic-graph: schema, serializer, layout, and local builder", () => {
  it("validates a complete multi-notation semantic graph with Zod", () => {
    const raw: SemanticGraph = {
      notation: "architecture",
      summary: "Payments Checkout Pipeline",
      nodes: [
        { id: "client", label: "Web Client", kind: "ellipse", tone: "terracotta", layer: 0 },
        { id: "api", label: "Checkout API", sublabel: "REST", kind: "node", tone: "cobalt", layer: 1 },
        { id: "db", label: "Ledger DB", sublabel: "Postgres", kind: "database", tone: "teal", layer: 2 },
      ],
      edges: [
        { from: "client", to: "api", label: "POST /pay", kind: "flow" },
        { from: "api", to: "db", label: "commit", kind: "sync" },
      ],
      labels: [{ targetId: "api", text: "idempotent", position: "bottom" }],
      messages: [{ from: "client", to: "api", text: "authorize()", order: 1 }],
      states: [
        {
          id: "pending",
          label: "Pending",
          initial: true,
          transitions: [{ to: "settled", trigger: "capture_ok" }],
        },
        { id: "settled", label: "Settled", terminal: true },
      ],
      entities: [
        {
          id: "payment",
          name: "Payment",
          fields: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "amount_cents", type: "int" },
          ],
        },
      ],
      groups: [{ id: "grp_core", label: "Core Payments", nodeIds: ["api", "db"] }],
    };

    const parsed = validateSemanticGraph(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.graph.nodes).toHaveLength(3);
      expect(parsed.graph.edges).toHaveLength(2);
      expect(parsed.graph.groups).toHaveLength(1);
      expect(parsed.graph.messages).toHaveLength(1);
      expect(parsed.graph.states).toHaveLength(2);
      expect(parsed.graph.entities).toHaveLength(1);
    }
  });

  it("rejects prototype-polluting keys, oversized payloads, and dangling self-loops", () => {
    const poisoned = JSON.parse(
      '{"summary":"Evil","nodes":[{"id":"__proto__","label":"Bad","kind":"node"}],"edges":[]}'
    );
    expect(validateSemanticGraph(poisoned).ok).toBe(false);

    const tooManyNodes = {
      summary: "Huge",
      nodes: Array.from({ length: 80 }, (_, i) => ({
        id: `n_${i}`,
        label: `Node ${i}`,
        kind: "node",
      })),
      edges: [],
    };
    expect(semanticGraphSchema.safeParse(tooManyNodes).success).toBe(false);

    // Dangling edges and self-loops are cleaned/filtered out safely when nodes exist
    const withDangling = validateSemanticGraph({
      summary: "Partial",
      nodes: [
        { id: "a", label: "Alpha", kind: "node" },
        { id: "b", label: "Beta", kind: "node" },
      ],
      edges: [
        { from: "a", to: "b", label: "ok" },
        { from: "a", to: "a", label: "self" },
        { from: "a", to: "missing", label: "dangling" },
      ],
    });
    expect(withDangling.ok).toBe(true);
    if (withDangling.ok) {
      expect(withDangling.graph.edges).toHaveLength(1);
      expect(withDangling.graph.edges[0].to).toBe("b");
    }
  });

  it("extracts and validates semantic graph JSON from raw or markdown-fenced LLM output", () => {
    const fenced = [
      "Here is the graph:",
      "```json",
      JSON.stringify({
        notation: "architecture",
        summary: "Cache Layer",
        nodes: [
          { id: "app", label: "App", kind: "ellipse" },
          { id: "cache", label: "Redis", kind: "database" },
        ],
        edges: [{ from: "app", to: "cache", label: "get" }],
      }),
      "```",
    ].join("\n");

    const okRes = parseSemanticGraphJson(fenced);
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.graph.nodes).toHaveLength(2);
    }

    expect(parseSemanticGraphJson("not valid json at all").ok).toBe(false);
    expect(parseSemanticGraphJson('{"nodes": []}').ok).toBe(false);
  });

  it("serializes live board elements + recent edit deltas into a compact, bounded graph with stable canonical hash", () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      makeEl({
        id: `n_${i}`,
        label: `Service ${i}`,
        x: i * 200,
        y: (i % 3) * 100,
      })
    );
    const arrows = Array.from({ length: 39 }, (_, i) =>
      makeEl({
        id: `a_${i}`,
        kind: "arrow",
        fromId: `n_${i}`,
        toId: `n_${i + 1}`,
        label: "rpc",
      })
    );
    const frame = makeEl({
      id: "f_1",
      kind: "frame",
      x: -20,
      y: -20,
      width: 600,
      height: 400,
      label: "Core Zone",
    });

    const deltas: BoardEditDelta[] = [
      {
        op: "move",
        elementIds: ["n_38"],
        labels: ["Service 38"],
        dx: 120,
        dy: 0,
        summary: "Moved Service 38 right",
        timestamp: 1000,
      },
    ];

    const serialized = serializeBoardToGraph([...nodes, ...arrows, frame], {
      selectedIds: ["n_38", "n_39"],
      recentDeltas: deltas,
      boardTitle: "Prod Arch",
    });

    expect(serialized.stats.truncated).toBe(true);
    expect(serialized.nodes.length).toBeLessThanOrEqual(32);
    expect(serialized.edges.length).toBeLessThanOrEqual(48);
    // Selected nodes MUST be prioritized and never dropped by truncation
    expect(serialized.nodes.some((n) => n.id === "n_38")).toBe(true);
    expect(serialized.nodes.some((n) => n.id === "n_39")).toBe(true);
    expect(serialized.recentDeltas).toHaveLength(1);

    // Same board state with different delta timestamps or whitespace produces identical canonical hash
    const serializedSame = serializeBoardToGraph([...nodes, ...arrows, frame], {
      selectedIds: ["n_39", "n_38"],
      recentDeltas: [{ ...deltas[0], timestamp: 999999 }],
      boardTitle: "  prod   arch ",
    });
    expect(computeBoardGraphHash(serialized, "fork")).toBe(
      computeBoardGraphHash(serializedSame, "fork")
    );
    expect(computeBoardGraphHash(serialized, "fork")).not.toBe(
      computeBoardGraphHash(serialized, "prompt")
    );
  });

  it("lays out semantic graphs deterministically with zero shape overlaps even with cycles and groups", () => {
    const cyclicGraph: SemanticGraph = {
      notation: "architecture",
      summary: "Cyclic Worker Architecture",
      nodes: [
        { id: "client", label: "Browser", kind: "ellipse" },
        { id: "gw", label: "API Gateway", kind: "node" },
        { id: "auth", label: "Auth Check?", kind: "diamond" },
        { id: "svc", label: "Order Service", kind: "node" },
        { id: "q", label: "Kafka Queue", kind: "node" },
        { id: "worker", label: "Async Worker", kind: "node" },
        { id: "db", label: "Postgres DB", kind: "database" },
      ],
      edges: [
        { from: "client", to: "gw", label: "HTTPS" },
        { from: "gw", to: "auth", label: "verify" },
        { from: "auth", to: "svc", label: "ok" },
        { from: "svc", to: "q", label: "emit", dashed: true },
        { from: "q", to: "worker", label: "consume" },
        { from: "worker", to: "db", label: "write" },
        // Cycle back-edge to ensure topological layering terminates cleanly
        { from: "worker", to: "svc", label: "callback", dashed: true },
      ],
      groups: [
        { id: "g_async", label: "Async Pipeline", nodeIds: ["q", "worker"] },
      ],
    };

    const result = layoutSemanticGraphToElements(cyclicGraph, {
      anchorCenter: { x: 600, y: 400 },
      existingElements: [],
    });

    const validation = validateLayoutElements(result.elements);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);

    const shapes = result.elements.filter((e) => isShapeElement(e) && e.kind !== "frame");
    expect(shapes).toHaveLength(7);

    // Pairwise non-overlap check
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(
          rectsOverlap(getElementRect(shapes[i]), getElementRect(shapes[j]), 4)
        ).toBe(false);
      }
    }

    // Frames render before nodes
    const firstFrameIdx = result.elements.findIndex((e) => e.kind === "frame");
    const firstNodeIdx = result.elements.findIndex((e) => e.kind !== "frame" && e.kind !== "arrow");
    expect(firstFrameIdx).toBe(0);
    expect(firstNodeIdx).toBeGreaterThan(firstFrameIdx);

    // All elements carry valid revision metadata
    for (const el of result.elements) {
      expect(el.rev).toBeGreaterThanOrEqual(1);
    }
  });

  it("builds rich local heuristic semantic graphs for domain prompts without fabricating AI confidence", () => {
    const eventGraph = buildLocalSemanticGraphFromPrompt(
      "event-driven order processing with kafka and dead letter queue"
    );
    expect(eventGraph.isHeuristic).toBe(true);
    expect(eventGraph.confidence).toBeNull();
    expect(eventGraph.graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(eventGraph.graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(validateSemanticGraph(eventGraph.graph).ok).toBe(true);

    const cacheGraph = buildLocalSemanticGraphFromPrompt(
      "high-throughput read API with redis cache and postgres read replica"
    );
    expect(cacheGraph.isHeuristic).toBe(true);
    expect(cacheGraph.graph.nodes.some((n) => /redis|cache/i.test(n.label))).toBe(true);
    expect(cacheGraph.graph.nodes.some((n) => /replica|postgres|db/i.test(n.label))).toBe(true);

    const laidOut = layoutSemanticGraphToElements(cacheGraph.graph);
    expect(validateLayoutElements(laidOut.elements).ok).toBe(true);
  });
});
