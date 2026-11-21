import { describe, expect, it } from "vitest";
import {
  applyForkTakeToBoard,
  buildLocalForkTakes,
  deriveDomainSubject,
  extractSelectedSubgraph,
  validateForkTakesPayload,
  type ForkTake,
} from "@/lib/jev/fork-engine";
import { BoardHistoryController } from "@/lib/jev/board-history";
import { applyLocalElementsChange } from "@/lib/jev/board-sync";
import { computeBounds, rectsOverlap } from "@/lib/jev/geometry";
import { validateLayoutElements } from "@/lib/jev/semantic-graph";
import type { JevElement } from "@/lib/jev/types";

function makeEl(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: overrides.id ?? "el_1",
    kind: overrides.kind ?? "node",
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    width: overrides.width ?? 168,
    height: overrides.height ?? 72,
    label: overrides.label ?? "API Server",
    tone: overrides.tone ?? "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 2,
    ...overrides,
  };
}

describe("fork-engine: 3 distinct architectural takes & atomic in-place swap", () => {
  const browser = makeEl({ id: "ext_client", kind: "ellipse", x: 0, y: 180, label: "Mobile App" });
  const api = makeEl({ id: "sel_api", kind: "node", x: 260, y: 180, label: "Orders API" });
  const db = makeEl({ id: "sel_db", kind: "database", x: 520, y: 180, label: "Orders Postgres" });
  const analytics = makeEl({ id: "ext_sink", kind: "database", x: 780, y: 180, label: "Snowflake" });

  const extIn = makeEl({ id: "arr_in", kind: "arrow", fromId: "ext_client", toId: "sel_api", label: "HTTPS" });
  const internalArr = makeEl({ id: "arr_mid", kind: "arrow", fromId: "sel_api", toId: "sel_db", label: "SQL" });
  const extOut = makeEl({ id: "arr_out", kind: "arrow", fromId: "sel_db", toId: "ext_sink", label: "CDC" });

  const boardElements: JevElement[] = [browser, api, db, analytics, extIn, internalArr, extOut];

  it("extracts the selected subgraph including internal and external boundary edges", () => {
    const subgraph = extractSelectedSubgraph(["sel_api", "sel_db"], boardElements);
    expect(subgraph).not.toBeNull();
    expect(subgraph!.selectedShapes.map((s) => s.id)).toEqual(["sel_api", "sel_db"]);
    expect(subgraph!.internalArrows.map((a) => a.id)).toEqual(["arr_mid"]);
    expect(subgraph!.incomingExternal.map((a) => a.id)).toEqual(["arr_in"]);
    expect(subgraph!.outgoingExternal.map((a) => a.id)).toEqual(["arr_out"]);
    expect(subgraph!.replacedIds).toContain("sel_api");
    expect(subgraph!.replacedIds).toContain("sel_db");
    expect(subgraph!.replacedIds).toContain("arr_mid");
    expect(subgraph!.replacedIds).toContain("arr_in");
    expect(subgraph!.replacedIds).toContain("arr_out");
    expect(subgraph!.replacedIds).not.toContain("ext_client");
    expect(subgraph!.replacedIds).not.toContain("ext_sink");
  });

  it("generates 3 genuinely distinct, context-tailored architectural takes with valid non-overlapping layouts", () => {
    const result = buildLocalForkTakes(["sel_api", "sel_db"], boardElements);
    expect(result).not.toBeNull();
    expect(result!.isHeuristic).toBe(true);
    expect(result!.takes).toHaveLength(3);

    // 3 distinct archetypes & titles
    const archetypes = new Set(result!.takes.map((t) => t.archetype));
    const titles = new Set(result!.takes.map((t) => t.title));
    expect(archetypes.size).toBe(3);
    expect(titles.size).toBe(3);

    // Each take references the actual selected labels (not generic unrelated boilerplate)
    const externalIds = new Set(["ext_client", "ext_sink"]);
    for (const take of result!.takes) {
      expect(take.rationale.length).toBeGreaterThan(10);
      expect(take.tradeoffTag.length).toBeGreaterThan(3);
      expect(take.probability).toBeUndefined();

      const labels = take.elements
        .filter((e) => e.kind !== "arrow")
        .map((e) => e.label)
        .join(" ");
      expect(labels).toMatch(/Orders/i);

      // Rewires external incoming and outgoing connections seamlessly
      const hasRewiredIn = take.elements.some(
        (e) => e.kind === "arrow" && e.fromId === "ext_client"
      );
      const hasRewiredOut = take.elements.some(
        (e) => e.kind === "arrow" && e.toId === "ext_sink"
      );
      expect(hasRewiredIn).toBe(true);
      expect(hasRewiredOut).toBe(true);

      // Zero overlaps and valid arrow references
      const validation = validateLayoutElements(take.elements, {
        externalElementIds: externalIds,
      });
      expect(validation.ok).toBe(true);
    }

    // The 3 takes have genuinely different graph topologies (node label sets differ)
    const sigs = result!.takes.map((t) =>
      t.graph.nodes
        .map((n) => n.label)
        .sort()
        .join("|")
    );
    expect(new Set(sigs).size).toBe(3);
  });

  it("handles single-shape selection cleanly and returns null when no shapes are selected", () => {
    expect(buildLocalForkTakes([], boardElements)).toBeNull();
    expect(buildLocalForkTakes(["arr_mid"], boardElements)).toBeNull();

    const single = buildLocalForkTakes(["sel_api"], boardElements);
    expect(single).not.toBeNull();
    expect(single!.takes).toHaveLength(3);
    for (const take of single!.takes) {
      expect(take.graph.nodes.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("swaps selected elements in place with tombstones, bumped revs, and single-step Undo restoration", () => {
    const fork = buildLocalForkTakes(["sel_api", "sel_db"], boardElements)!;
    const chosenTake: ForkTake = fork.takes[0];

    const history = new BoardHistoryController(boardElements);
    const swappedRaw = applyForkTakeToBoard(boardElements, fork.replacedIds, chosenTake);

    // Apply through sync engine so replaced IDs are tombstoned and new IDs get bumped revs
    const syncApplied = applyLocalElementsChange(
      boardElements,
      swappedRaw,
      {},
      "peer_local",
      5000,
      0
    );
    history.commitLocal(syncApplied.elements, { recordUndo: true });

    // Replaced IDs are removed & tombstoned with bumped rev > old rev (2)
    for (const rid of fork.replacedIds) {
      expect(syncApplied.elements.some((e) => e.id === rid)).toBe(false);
      expect(syncApplied.tombstones[rid]).toBeDefined();
      expect(syncApplied.tombstones[rid].rev).toBeGreaterThanOrEqual(3);
    }

    // Untouched external elements remain intact
    expect(syncApplied.elements.some((e) => e.id === "ext_client")).toBe(true);
    expect(syncApplied.elements.some((e) => e.id === "ext_sink")).toBe(true);

    // New elements exist with valid rev >= 1
    for (const added of chosenTake.elements) {
      const present = syncApplied.elements.find((e) => e.id === added.id);
      expect(present).toBeDefined();
      expect(present!.rev).toBeGreaterThanOrEqual(1);
    }

    // Single-step Undo restores the exact original selection cleanly
    const undone = history.undo();
    expect(undone).not.toBeNull();
    expect(undone!.map((e) => e.id).sort()).toEqual(
      boardElements.map((e) => e.id).sort()
    );
  });

  it("validates structured fork takes payloads from upstream LLMs and rejects malformed ones", () => {
    const valid = validateForkTakesPayload({
      takes: [
        {
          archetype: "queue_event_driven",
          title: "Queue-Decoupled Orders",
          rationale: "Buffers write spikes asynchronously",
          tradeoffTag: "Eventual consistency",
          graph: {
            notation: "architecture",
            summary: "Queue-Decoupled Orders",
            nodes: [
              { id: "api", label: "Orders API", kind: "node" },
              { id: "q", label: "Order Queue", kind: "node" },
              { id: "db", label: "Orders Postgres", kind: "database" },
            ],
            edges: [
              { from: "api", to: "q", label: "enqueue", dashed: true },
              { from: "q", to: "db", label: "persist" },
            ],
          },
        },
        {
          archetype: "cache_read_replica",
          title: "Cache-First Orders",
          rationale: "Serves hot reads from Redis",
          tradeoffTag: "Cache invalidation",
          graph: {
            notation: "architecture",
            summary: "Cache-First Orders",
            nodes: [
              { id: "api", label: "Orders API", kind: "node" },
              { id: "cache", label: "Redis Cache", kind: "database" },
              { id: "db", label: "Orders Postgres", kind: "database" },
            ],
            edges: [
              { from: "api", to: "cache", label: "read" },
              { from: "cache", to: "db", label: "miss", dashed: true },
            ],
          },
        },
        {
          archetype: "gateway_edge_split",
          title: "Edge Gateway Split",
          rationale: "Isolates read and write paths behind gateway",
          tradeoffTag: "Extra network hop",
          graph: {
            notation: "architecture",
            summary: "Edge Gateway Split",
            nodes: [
              { id: "gw", label: "Edge Gateway", kind: "node" },
              { id: "api", label: "Orders API", kind: "node" },
              { id: "db", label: "Orders Postgres", kind: "database" },
            ],
            edges: [
              { from: "gw", to: "api", label: "route" },
              { from: "api", to: "db", label: "sql" },
            ],
          },
        },
      ],
    });
    expect(valid.ok).toBe(true);

    // Must have 3 takes; fewer or malformed fails cleanly
    expect(validateForkTakesPayload({ takes: [] }).ok).toBe(false);
    expect(validateForkTakesPayload({ takes: [{ title: "bad" }] }).ok).toBe(false);
  });

  it("places fork preview ghosts beside the selection (+120px right, or below for very wide selections) while keeping accepted elements anchored in place", () => {
    const fork = buildLocalForkTakes(["sel_api", "sel_db"], boardElements)!;
    const selBounds = fork.subgraph.bounds;

    for (const take of fork.takes) {
      expect(take.previewElements.length).toBeGreaterThan(0);
      expect(take.previewPlacement).toBe("right");

      const previewBounds = computeBounds(take.previewElements)!;
      expect(previewBounds).not.toBeNull();
      // Never overlaps originals and sits at least 120px to the right
      expect(rectsOverlap(selBounds, previewBounds, 0)).toBe(false);
      expect(previewBounds.x).toBeGreaterThanOrEqual(
        selBounds.x + selBounds.width + 120 - 1
      );

      // Accepted materialized elements remain anchored around the original selection bounds
      const acceptedShapes = take.elements.filter(
        (e) => e.kind !== "arrow" && e.kind !== "frame"
      );
      const acceptedBounds = computeBounds(acceptedShapes)!;
      const selCenterX = selBounds.x + selBounds.width / 2;
      const acceptedCenterX = acceptedBounds.x + acceptedBounds.width / 2;
      expect(Math.abs(acceptedCenterX - selCenterX)).toBeLessThan(120);
    }

    // Very wide horizontal selection (>= 820px wide, aspect ratio >= 3.5) places preview BELOW with +120px gap
    const wideChain: JevElement[] = [
      makeEl({ id: "w1", x: 0, y: 200, width: 170, height: 72, label: "Checkout UI" }),
      makeEl({ id: "w2", x: 250, y: 200, width: 170, height: 72, label: "Checkout API" }),
      makeEl({ id: "w3", x: 500, y: 200, width: 170, height: 72, label: "Fraud Engine" }),
      makeEl({ id: "w4", x: 750, y: 200, width: 170, height: 72, label: "Ledger DB", kind: "database" }),
    ];
    const wideFork = buildLocalForkTakes(["w1", "w2", "w3", "w4"], wideChain)!;
    for (const take of wideFork.takes) {
      expect(take.previewPlacement).toBe("below");
      const previewBounds = computeBounds(take.previewElements)!;
      expect(rectsOverlap(wideFork.subgraph.bounds, previewBounds, 0)).toBe(false);
      expect(previewBounds.y).toBeGreaterThanOrEqual(
        wideFork.subgraph.bounds.y + wideFork.subgraph.bounds.height + 120 - 1
      );
    }
  });

  it("strips pronouns/stopwords, prefers service/domain nodes, and never generates 'You Queue' or 'You Worker'", () => {
    const pronounOnly = [
      makeEl({ id: "p1", kind: "ellipse", x: 100, y: 200, label: "You & Peers" }),
    ];
    expect(deriveDomainSubject(pronounOnly)).toBeNull();

    const pronounFork = buildLocalForkTakes(["p1"], pronounOnly)!;
    const allPronounLabels = pronounFork.takes
      .flatMap((t) => [t.title, t.rationale, ...t.elements.map((e) => e.label)])
      .join(" | ");
    expect(allPronounLabels).not.toMatch(/\bYou\s+(Event\s+)?(Queue|Worker|Redis|Read|Edge|Fallback)\b/i);
    expect(allPronounLabels).not.toMatch(/\bPeers\s+(Queue|Worker)\b/i);
    // Uses crisp domain role fallback names
    expect(allPronounLabels).toMatch(/Ingest Queue|Async Worker|Dead-Letter Queue/i);
    expect(allPronounLabels).toMatch(/Read Cache/i);
    expect(allPronounLabels).toMatch(/Edge Gateway/i);

    // Mixed selection with pronoun actor + domain service prefers the domain service
    const mixed = [
      makeEl({ id: "m1", kind: "ellipse", x: 80, y: 200, label: "You & Peers" }),
      makeEl({ id: "m2", kind: "node", x: 320, y: 200, label: "Checkout Service" }),
      makeEl({ id: "m3", kind: "database", x: 560, y: 200, label: "Postgres" }),
    ];
    expect(deriveDomainSubject(mixed)).toBe("Checkout");

    const mixedFork = buildLocalForkTakes(["m1", "m2", "m3"], mixed)!;
    const mixedLabels = mixedFork.takes
      .flatMap((t) => t.elements.map((e) => e.label))
      .join(" | ");
    expect(mixedLabels).toMatch(/Checkout/i);
    expect(mixedLabels).not.toMatch(/\bYou\s+(Queue|Worker|Cache|Edge)/i);

    // Gateway subject should never produce duplicated "Gateway Edge Gateway"
    const gwOnly = [
      makeEl({ id: "g1", kind: "ellipse", x: 80, y: 200, label: "Users" }),
      makeEl({ id: "g2", kind: "node", x: 300, y: 200, label: "API Gateway" }),
    ];
    const gwFork = buildLocalForkTakes(["g1", "g2"], gwOnly)!;
    const gwLabels = gwFork.takes
      .flatMap((t) => t.elements.map((e) => e.label))
      .join(" | ");
    expect(gwLabels).not.toMatch(/Gateway Edge Gateway/i);
    expect(gwLabels).not.toMatch(/\bUsers?\s+(Queue|Worker)/i);
  });
});

describe("fork-engine: accepted swap never overlaps neighbouring shapes", () => {
  const isNode = (e: JevElement) =>
    e.kind !== "arrow" && e.kind !== "freedraw" && e.kind !== "frame";

  function overlappingPairs(board: JevElement[], newIds: Set<string>): string[] {
    const nodes = board.filter(isNode);
    const frames = board.filter((e) => e.kind === "frame" && newIds.has(e.id));
    const hits: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (rectsOverlap(nodes[i], nodes[j])) hits.push(`${nodes[i].label} x ${nodes[j].label}`);
      }
    }
    for (const frame of frames) {
      for (const n of nodes) {
        if (!newIds.has(n.id) && rectsOverlap(frame, n)) hits.push(`frame ${frame.label} x ${n.label}`);
      }
    }
    return hits;
  }

  it("Fork my architecture starter: every take swaps in with no two node bounding boxes intersecting", async () => {
    const { createForkArchitectureStarterElements } = await import("@/lib/jev/templates");
    const board = createForkArchitectureStarterElements();
    const fork = buildLocalForkTakes(["arch_orders_api", "arch_orders_db"], board)!;
    expect(fork.takes).toHaveLength(3);
    for (const take of fork.takes) {
      const next = applyForkTakeToBoard(board, fork.replacedIds, take);
      const newIds = new Set(take.elements.map((e) => e.id));
      expect({ take: take.title, overlaps: overlappingPairs(next, newIds) }).toEqual({
        take: take.title,
        overlaps: [],
      });
      expect(next.some((e) => e.id === "arch_client")).toBe(true);
    }
  });

  it("makes room on a crowded board: neighbours left, right, above and below stay clear after the swap", () => {
    const left = makeEl({ id: "n_left", kind: "ellipse", x: 60, y: 300, width: 150, label: "Client" });
    const sel1 = makeEl({ id: "s1", x: 260, y: 300, label: "Orders API" });
    const sel2 = makeEl({ id: "s2", kind: "database", x: 470, y: 300, label: "Orders DB" });
    const right = makeEl({ id: "n_right", x: 690, y: 300, label: "Billing" });
    const above = makeEl({ id: "n_above", x: 360, y: 180, label: "Auth" });
    const below = makeEl({ id: "n_below", x: 360, y: 420, label: "Metrics" });
    const arrows = [
      makeEl({ id: "a1", kind: "arrow", fromId: "n_left", toId: "s1" }),
      makeEl({ id: "a2", kind: "arrow", fromId: "s1", toId: "s2" }),
      makeEl({ id: "a3", kind: "arrow", fromId: "s2", toId: "n_right" }),
    ];
    const board = [left, sel1, sel2, right, above, below, ...arrows];
    const fork = buildLocalForkTakes(["s1", "s2"], board)!;
    for (const take of fork.takes) {
      const next = applyForkTakeToBoard(board, fork.replacedIds, take);
      const newIds = new Set(take.elements.map((e) => e.id));
      expect({ take: take.title, overlaps: overlappingPairs(next, newIds) }).toEqual({
        take: take.title,
        overlaps: [],
      });
    }
  });
});

describe("fork-engine: new notation kinds", () => {
  it("keeps the kind of selected HLD shapes in every take instead of flattening them to boxes", () => {
    const api = makeEl({ id: "k_api", kind: "node", x: 0, y: 0, label: "Orders API" });
    const kafka = makeEl({ id: "k_q", kind: "queue", x: 260, y: 0, width: 176, height: 64, label: "Kafka" });
    const redis = makeEl({ id: "k_c", kind: "cache", x: 520, y: 0, width: 140, height: 76, label: "Redis" });
    const zone = makeEl({ id: "k_z", kind: "zone", x: -40, y: -40, width: 800, height: 200, label: "VPC" });
    const arrows = [
      makeEl({ id: "k_a1", kind: "arrow", fromId: "k_api", toId: "k_q", label: "publish" }),
      makeEl({ id: "k_a2", kind: "arrow", fromId: "k_api", toId: "k_c", label: "read" }),
    ];
    const result = buildLocalForkTakes(["k_api", "k_q", "k_c"], [zone, api, kafka, redis, ...arrows], 1);
    expect(result?.takes).toHaveLength(3);
    for (const take of result!.takes) {
      const kinds = new Map(take.elements.map((e) => [e.label, e.kind]));
      expect(kinds.get("Kafka")).toBe("queue");
      expect(kinds.get("Redis")).toBe("cache");
    }
  });
});
