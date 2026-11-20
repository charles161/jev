import { describe, expect, it } from "vitest";
import {
  applyForkTakeToBoard,
  buildLocalForkTakes,
  extractSelectedSubgraph,
  validateForkTakesPayload,
  type ForkTake,
} from "@/lib/jev/fork-engine";
import { BoardHistoryController } from "@/lib/jev/board-history";
import { applyLocalElementsChange } from "@/lib/jev/board-sync";
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
});
