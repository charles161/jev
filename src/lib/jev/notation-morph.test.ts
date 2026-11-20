import { describe, expect, it } from "vitest";
import {
  applyLocalElementsChange,
  mergeRemoteBoardState,
} from "@/lib/jev/board-sync";
import { computeBounds, isShapeElement } from "@/lib/jev/geometry";
import {
  ALL_MORPH_NOTATIONS,
  applyMorphToBoard,
  detectSelectionMorphState,
  extractMorphSemanticSpec,
  morphSelectionToNotation,
  validateMorphSemanticSpec,
  type MorphNotation,
} from "@/lib/jev/notation-morph";
import { validateLayoutElements } from "@/lib/jev/semantic-graph";
import {
  parseStoredBoardSnapshot,
  parseWireMessage,
} from "@/lib/jev/sync-validation";
import type { JevElement } from "@/lib/jev/types";

function makeSketchBoard(): JevElement[] {
  const now = 1_710_000_000_000;
  return [
    {
      id: "ext_client",
      kind: "ellipse",
      x: 40,
      y: 220,
      width: 140,
      height: 70,
      label: "Browser",
      tone: "terracotta",
      seed: 101,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "sk_api",
      kind: "node",
      x: 260,
      y: 220,
      width: 170,
      height: 72,
      label: "Order API",
      tone: "cobalt",
      seed: 102,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "sk_check",
      kind: "diamond",
      x: 500,
      y: 208,
      width: 156,
      height: 96,
      label: "In Stock?",
      tone: "plum",
      seed: 103,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "sk_db",
      kind: "database",
      x: 730,
      y: 212,
      width: 164,
      height: 86,
      label: "Orders DB",
      tone: "teal",
      seed: 104,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "ext_analytics",
      kind: "node",
      x: 980,
      y: 220,
      width: 160,
      height: 72,
      label: "Analytics",
      tone: "slate",
      seed: 105,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "arr_ext_in",
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: "POST /orders",
      tone: "ink",
      seed: 201,
      fromId: "ext_client",
      toId: "sk_api",
      arrowStyle: "curved",
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "arr_int_1",
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: "validate",
      tone: "ink",
      seed: 202,
      fromId: "sk_api",
      toId: "sk_check",
      arrowStyle: "curved",
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "arr_int_2",
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: "Yes",
      tone: "ink",
      seed: 203,
      fromId: "sk_check",
      toId: "sk_db",
      arrowStyle: "curved",
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "arr_ext_out",
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: "cdc",
      tone: "ochre",
      seed: 204,
      fromId: "sk_db",
      toId: "ext_analytics",
      arrowStyle: "curved",
      dashed: true,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
  ];
}

describe("Chunk 5b: Notation Morph — reversible in-place semantic morphing", () => {
  it("extracts a rich shared semantic spec covering actors/messages, steps, states/transitions, and entities/relations", () => {
    const board = makeSketchBoard();
    const spec = extractMorphSemanticSpec(["sk_api", "sk_check", "sk_db"], board);

    expect(spec).not.toBeNull();
    expect(spec!.actors.length).toBeGreaterThanOrEqual(3);
    expect(spec!.messages.length).toBeGreaterThanOrEqual(2);
    expect(spec!.steps.length).toBeGreaterThanOrEqual(3);
    expect(spec!.states.length).toBeGreaterThanOrEqual(3);
    expect(spec!.transitions.length).toBeGreaterThanOrEqual(2);
    expect(spec!.entities.length).toBeGreaterThanOrEqual(2);
    expect(spec!.relations.length).toBeGreaterThanOrEqual(1);
    expect(spec!.entities[0].attributes.some((a) => /PK/i.test(a))).toBe(true);
  });

  it("produces genuinely distinct, overlap-free native layouts for all 5 notations", () => {
    const board = makeSketchBoard();
    const sel = ["sk_api", "sk_check", "sk_db"];
    const originalBounds = computeBounds(
      board.filter((e) => sel.includes(e.id))
    )!;
    const externalIds = new Set(["ext_client", "ext_analytics"]);

    expect(ALL_MORPH_NOTATIONS).toEqual([
      "sketch",
      "sequence",
      "flowchart",
      "state",
      "er",
    ]);

    // 1) Sequence: top actor headers + vertical dashed lifelines + horizontal labeled message arrows
    const seqRes = morphSelectionToNotation(sel, board, "sequence");
    expect(seqRes).not.toBeNull();
    expect(seqRes!.notation).toBe("sequence");
    const seqActors = seqRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "actor"
    );
    const seqLifelines = seqRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "lifeline"
    );
    const seqMessages = seqRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "message"
    );
    expect(seqActors.length).toBeGreaterThanOrEqual(3);
    expect(seqLifelines.length).toBe(seqActors.length);
    expect(seqLifelines.every((l) => l.dashed === true)).toBe(true);
    expect(seqMessages.length).toBeGreaterThanOrEqual(2);
    // Horizontal message arrows ordered top-to-bottom
    for (let i = 1; i < seqMessages.length; i++) {
      expect(seqMessages[i].fromPoint!.y).toBeGreaterThan(
        seqMessages[i - 1].fromPoint!.y
      );
    }
    const seqValidation = validateLayoutElements(seqRes!.addedElements, {
      externalElementIds: externalIds,
    });
    expect(seqValidation.ok, seqValidation.errors.join("; ")).toBe(true);

    // 2) Flowchart: Start/End ellipses, process rectangles, decision diamond with Yes/No branches
    const flowRes = morphSelectionToNotation(sel, board, "flowchart");
    expect(flowRes).not.toBeNull();
    const flowEllipses = flowRes!.addedElements.filter(
      (e) => e.kind === "ellipse"
    );
    const flowDiamonds = flowRes!.addedElements.filter(
      (e) => e.kind === "diamond"
    );
    const flowArrows = flowRes!.addedElements.filter((e) => e.kind === "arrow");
    expect(flowEllipses.length).toBeGreaterThanOrEqual(2);
    expect(flowDiamonds.length).toBeGreaterThanOrEqual(1);
    expect(flowArrows.some((a) => /yes/i.test(a.label))).toBe(true);
    expect(flowArrows.some((a) => /no|fail|retry/i.test(a.label))).toBe(true);
    const flowValidation = validateLayoutElements(flowRes!.addedElements, {
      externalElementIds: externalIds,
    });
    expect(flowValidation.ok, flowValidation.errors.join("; ")).toBe(true);

    // 3) State: initial indicator, state nodes, labeled event transition arrows
    const stateRes = morphSelectionToNotation(sel, board, "state");
    expect(stateRes).not.toBeNull();
    const stateNodes = stateRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "state"
    );
    const stateTransitions = stateRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "transition"
    );
    expect(stateNodes.length).toBeGreaterThanOrEqual(3);
    expect(stateTransitions.length).toBeGreaterThanOrEqual(2);
    expect(stateTransitions.every((t) => t.label.trim().length > 0)).toBe(true);
    const stateValidation = validateLayoutElements(stateRes!.addedElements, {
      externalElementIds: externalIds,
    });
    expect(stateValidation.ok, stateValidation.errors.join("; ")).toBe(true);

    // 4) ER: entity cards with PK/attribute sublabels + cardinality-labeled relationship connectors
    const erRes = morphSelectionToNotation(sel, board, "er");
    expect(erRes).not.toBeNull();
    const erEntities = erRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "entity"
    );
    const erRelations = erRes!.addedElements.filter(
      (e) => e.morphMeta?.role === "relation"
    );
    expect(erEntities.length).toBeGreaterThanOrEqual(2);
    expect(erEntities.every((e) => Boolean(e.sublabel && /PK/i.test(e.sublabel)))).toBe(
      true
    );
    expect(erRelations.length).toBeGreaterThanOrEqual(1);
    expect(
      erRelations.every((r) => /(1:N|1:1|N:M|N:1)/.test(r.label))
    ).toBe(true);
    const erValidation = validateLayoutElements(erRes!.addedElements, {
      externalElementIds: externalIds,
    });
    expect(erValidation.ok, erValidation.errors.join("; ")).toBe(true);

    // Anchored in place near original selection bounds center
    const origCenterX = originalBounds.x + originalBounds.width / 2;
    const origCenterY = originalBounds.y + originalBounds.height / 2;
    for (const res of [seqRes!, flowRes!, stateRes!, erRes!]) {
      const b = computeBounds(
        res.addedElements.filter((e) => isShapeElement(e))
      )!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      expect(Math.abs(cx - origCenterX)).toBeLessThan(180);
      expect(Math.abs(cy - origCenterY)).toBeLessThan(180);
    }
  });

  it("supports true reversible round-trip Sketch -> Sequence -> Flowchart -> State -> ER -> Sketch in place", () => {
    let board = makeSketchBoard();
    let selection = ["sk_api", "sk_check", "sk_db"];

    const originalApi = board.find((e) => e.id === "sk_api")!;
    const originalCheck = board.find((e) => e.id === "sk_check")!;
    const originalDb = board.find((e) => e.id === "sk_db")!;

    const sequence: MorphNotation[] = [
      "sequence",
      "flowchart",
      "state",
      "er",
      "sketch",
    ];
    let groupId: string | null = null;

    for (const target of sequence) {
      const morph = morphSelectionToNotation(selection, board, target);
      expect(morph, `morph to ${target}`).not.toBeNull();
      if (groupId === null) {
        groupId = morph!.groupId;
      } else {
        expect(morph!.groupId).toBe(groupId);
      }

      board = applyMorphToBoard(board, morph!);
      selection = morph!.nextSelectedIds;

      // External boundary nodes stay untouched and rewired
      expect(board.some((e) => e.id === "ext_client")).toBe(true);
      expect(board.some((e) => e.id === "ext_analytics")).toBe(true);
      expect(
        board.some((e) => e.kind === "arrow" && e.fromId === "ext_client")
      ).toBe(true);
      expect(
        board.some((e) => e.kind === "arrow" && e.toId === "ext_analytics")
      ).toBe(true);

      const detected = detectSelectionMorphState(selection, board);
      expect(detected.notation).toBe(target);
      expect(detected.groupId).toBe(groupId);
    }

    // Back in Sketch: exact original sketch shapes & geometry restored cleanly!
    const restoredApi = board.find((e) => e.id === "sk_api");
    const restoredCheck = board.find((e) => e.id === "sk_check");
    const restoredDb = board.find((e) => e.id === "sk_db");

    expect(restoredApi).toBeDefined();
    expect(restoredCheck).toBeDefined();
    expect(restoredDb).toBeDefined();
    expect(restoredApi!.x).toBe(originalApi.x);
    expect(restoredApi!.y).toBe(originalApi.y);
    expect(restoredApi!.label).toBe(originalApi.label);
    expect(restoredCheck!.kind).toBe("diamond");
    expect(restoredCheck!.x).toBe(originalCheck.x);
    expect(restoredCheck!.y).toBe(originalCheck.y);
    expect(restoredDb!.kind).toBe("database");
    expect(restoredDb!.x).toBe(originalDb.x);
    expect(restoredDb!.y).toBe(originalDb.y);
    // Internal arrows restored too
    expect(
      board.some(
        (e) => e.kind === "arrow" && e.fromId === "sk_api" && e.toId === "sk_check"
      )
    ).toBe(true);
  });

  it("propagates label edits made in a structured notation back to Sketch on round-trip", () => {
    let board = makeSketchBoard();
    const morphToSeq = morphSelectionToNotation(
      ["sk_api", "sk_check", "sk_db"],
      board,
      "sequence"
    )!;
    board = applyMorphToBoard(board, morphToSeq);

    // User renames the first actor in Sequence diagram from "Order API" -> "Checkout API"
    const apiActor = board.find(
      (e) => e.morphMeta?.role === "actor" && e.label === "Order API"
    )!;
    expect(apiActor).toBeDefined();
    board = board.map((e) =>
      e.id === apiActor.id ? { ...e, label: "Checkout API" } : e
    );

    // Morph back to Sketch by selecting only that single edited actor
    const morphBack = morphSelectionToNotation([apiActor.id], board, "sketch")!;
    expect(morphBack).not.toBeNull();
    board = applyMorphToBoard(board, morphBack);

    const restoredApi = board.find((e) => e.id === "sk_api")!;
    expect(restoredApi.label).toBe("Checkout API");
  });

  it("works cleanly even when only 1 single node is selected", () => {
    const board = makeSketchBoard();
    const single = morphSelectionToNotation(["sk_api"], board, "er");
    expect(single).not.toBeNull();
    expect(single!.addedElements.some((e) => e.morphMeta?.role === "entity")).toBe(
      true
    );

    const nextBoard = applyMorphToBoard(board, single!);
    const back = morphSelectionToNotation(
      single!.nextSelectedIds,
      nextBoard,
      "sketch"
    );
    expect(back).not.toBeNull();
    const restoredBoard = applyMorphToBoard(nextBoard, back!);
    expect(restoredBoard.find((e) => e.id === "sk_api")?.label).toBe("Order API");
  });

  it("preserves morphMeta cleanly through sync-validation, localStorage, and WebRTC P2P merge", () => {
    const board = makeSketchBoard();
    const morph = morphSelectionToNotation(
      ["sk_api", "sk_check", "sk_db"],
      board,
      "sequence"
    )!;
    const morphedBoard = applyMorphToBoard(board, morph);

    // Local change stamps revs & tombstones replaced sketch IDs
    const stamped = applyLocalElementsChange(
      board,
      morphedBoard,
      {},
      "peer_a",
      1_710_000_005_000
    );
    expect(stamped.tombstones["sk_api"]).toBeDefined();

    // Wire validation preserves morphMeta & groupRecord
    const wire = parseWireMessage({
      kind: "sync_state",
      peerId: "peer_a",
      boardTitle: "Orders",
      ts: 1_710_000_005_000,
      hasLocalEdits: true,
      elements: stamped.elements,
      tombstones: stamped.tombstones,
    });
    expect(wire).not.toBeNull();
    expect(wire?.kind).toBe("sync_state");
    if (wire && wire.kind === "sync_state") {
      const syncedActor = wire.elements.find(
        (e) => e.morphMeta?.groupRecord !== undefined
      );
      expect(syncedActor).toBeDefined();
      expect(syncedActor?.morphMeta?.groupId).toBe(morph.groupId);
      expect(syncedActor?.morphMeta?.groupRecord?.sketchSnapshot.length).toBeGreaterThanOrEqual(
        3
      );

      // Peer B merges and can independently morph back to Sketch!
      const merged = mergeRemoteBoardState(
        {
          elements: board,
          boardTitle: "Orders",
          tombstones: {},
          hasLocalEdits: false,
        },
        {
          elements: wire.elements,
          boardTitle: wire.boardTitle,
          tombstones: wire.tombstones,
          hasLocalEdits: true,
          senderPeerId: "peer_a",
          verifiedSenderPeerId: "peer_a",
        },
        "peer_b",
        { authoritativePeerId: "peer_a", now: 1_710_000_006_000 }
      );
      expect(merged.changed).toBe(true);
      const peerBMorphBack = morphSelectionToNotation(
        [syncedActor!.id],
        merged.state.elements,
        "sketch"
      );
      expect(peerBMorphBack).not.toBeNull();
    }

    // localStorage snapshot round-trip preserves morphMeta
    const stored = parseStoredBoardSnapshot(
      JSON.stringify({
        elements: stamped.elements,
        boardTitle: "Orders",
        tombstones: stamped.tombstones,
        hasLocalEdits: true,
      })
    );
    expect(stored).not.toBeNull();
    expect(
      stored!.elements.some((e) => e.morphMeta?.groupRecord !== undefined)
    ).toBe(true);

    // Rejects prototype-polluting morph specs
    const poisoned = JSON.parse(
      '{"__proto__":{"polluted":true},"summary":"Bad","actors":[],"messages":[],"steps":[],"states":[],"transitions":[],"entities":[],"relations":[]}'
    );
    expect(validateMorphSemanticSpec(poisoned).ok).toBe(false);
  });
});
