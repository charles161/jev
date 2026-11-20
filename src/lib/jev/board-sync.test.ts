import { describe, expect, it } from "vitest";
import { createStarterElements } from "@/lib/jev/templates";
import type { JevElement } from "@/lib/jev/types";
import {
  applyLocalElementsChange,
  BoardSyncState,
  mergeRemoteBoardState,
} from "@/lib/jev/board-sync";

function makeNode(
  id: string,
  label: string,
  overrides: Partial<JevElement> = {}
): JevElement {
  return {
    id,
    kind: "node",
    x: 100,
    y: 100,
    width: 160,
    height: 70,
    label,
    tone: "cobalt",
    seed: 101,
    createdAt: 1700000001000,
    updatedAt: 1700000001000,
    rev: 1,
    ...overrides,
  };
}

describe("Blocker 3: authoritative handshake & deterministic element-level merge", () => {
  it("never lets an unmodified fresh joiner overwrite a host's board", () => {
    const hostState: BoardSyncState = {
      elements: [makeNode("host_el_1", "Host Service")],
      boardTitle: "Production Architecture",
      titleUpdatedAt: 1700000005000,
      tombstones: {},
      hasLocalEdits: true,
    };

    const freshJoinerPayload = {
      elements: createStarterElements(),
      boardTitle: "System Sketch",
      titleUpdatedAt: 0,
      tombstones: {},
      hasLocalEdits: false,
      authoritative: false,
      senderPeerId: "p_joiner_new",
    };

    const result = mergeRemoteBoardState(hostState, freshJoinerPayload, "p_host");
    expect(result.changed).toBe(false);
    expect(result.state.elements.map((e) => e.id)).toEqual(["host_el_1"]);
    expect(result.state.boardTitle).toBe("Production Architecture");
  });

  it("fresh joiner adopts host's authoritative board wholesale (including an intentionally blank board)", () => {
    const joinerState: BoardSyncState = {
      elements: createStarterElements(),
      boardTitle: "System Sketch",
      titleUpdatedAt: 0,
      tombstones: {},
      hasLocalEdits: false,
    };

    const hostCustom = mergeRemoteBoardState(
      joinerState,
      {
        elements: [makeNode("host_el_1", "Host Custom")],
        boardTitle: "Host Room",
        titleUpdatedAt: 1700000009000,
        tombstones: {},
        hasLocalEdits: true,
        authoritative: true,
        senderPeerId: "p_host",
      },
      "p_joiner"
    );
    expect(hostCustom.changed).toBe(true);
    expect(hostCustom.adoptedAuthoritative).toBe(true);
    expect(hostCustom.state.elements.map((e) => e.id)).toEqual(["host_el_1"]);
    expect(hostCustom.state.boardTitle).toBe("Host Room");

    // Even if host clicked "Blank Sheet", fresh joiner adopts the blank board (starter elements do not resurrect)
    const hostBlank = mergeRemoteBoardState(
      joinerState,
      {
        elements: [],
        boardTitle: "Blank Design",
        titleUpdatedAt: 1700000010000,
        tombstones: {},
        hasLocalEdits: true,
        authoritative: true,
        senderPeerId: "p_host",
      },
      "p_joiner"
    );
    expect(hostBlank.changed).toBe(true);
    expect(hostBlank.state.elements).toEqual([]);
    expect(hostBlank.state.boardTitle).toBe("Blank Design");
  });

  it("merges concurrent additions and concurrent edits deterministically & commutatively", () => {
    const shared = makeNode("el_shared", "Shared", {
      rev: 1,
      updatedAt: 1700000001000,
      updatedBy: "p_host",
    });

    const stateA: BoardSyncState = {
      elements: [
        {
          ...shared,
          x: 220,
          rev: 2,
          updatedAt: 1700000002000,
          updatedBy: "p_alpha",
        },
        makeNode("el_only_a", "From A", {
          rev: 1,
          createdAt: 1700000002100,
          updatedAt: 1700000002100,
          updatedBy: "p_alpha",
        }),
      ],
      boardTitle: "Alpha Title",
      titleUpdatedAt: 1700000002000,
      tombstones: {},
      hasLocalEdits: true,
    };

    const stateB: BoardSyncState = {
      elements: [
        {
          ...shared,
          x: 340,
          rev: 2,
          updatedAt: 1700000002500,
          updatedBy: "p_beta",
        },
        makeNode("el_only_b", "From B", {
          rev: 1,
          createdAt: 1700000002200,
          updatedAt: 1700000002200,
          updatedBy: "p_beta",
        }),
      ],
      boardTitle: "Beta Title",
      titleUpdatedAt: 1700000002600,
      tombstones: {},
      hasLocalEdits: true,
    };

    const mergedAB = mergeRemoteBoardState(
      stateA,
      {
        ...stateB,
        authoritative: false,
        senderPeerId: "p_beta",
      },
      "p_alpha"
    );
    const mergedBA = mergeRemoteBoardState(
      stateB,
      {
        ...stateA,
        authoritative: false,
        senderPeerId: "p_alpha",
      },
      "p_beta"
    );

    // Both additions preserved, newer edit wins, and both sides converge identically
    expect(mergedAB.state.elements.map((e) => e.id)).toEqual([
      "el_shared",
      "el_only_a",
      "el_only_b",
    ]);
    expect(mergedAB.state.elements).toEqual(mergedBA.state.elements);
    expect(mergedAB.state.elements.find((e) => e.id === "el_shared")?.x).toBe(
      340
    );
    expect(mergedAB.state.boardTitle).toBe("Beta Title");
    expect(mergedBA.state.boardTitle).toBe("Beta Title");
  });

  it("propagates deletions via tombstones without resurrecting deleted elements", () => {
    const initial = [
      makeNode("el_1", "Keep", { rev: 1, updatedAt: 1000 }),
      makeNode("el_2", "Delete Me", { rev: 1, updatedAt: 1000 }),
    ];

    const afterDelete = applyLocalElementsChange(
      initial,
      [initial[0]],
      {},
      "p_host",
      2000
    );
    expect(afterDelete.elements.map((e) => e.id)).toEqual(["el_1"]);
    expect(afterDelete.tombstones.el_2).toBeDefined();
    expect(afterDelete.tombstones.el_2.rev).toBe(2);

    // Peer B still has el_2 at rev 1; merging host's state deletes el_2 on Peer B
    const peerBState: BoardSyncState = {
      elements: initial,
      boardTitle: "Room",
      titleUpdatedAt: 1000,
      tombstones: {},
      hasLocalEdits: true,
    };
    const merged = mergeRemoteBoardState(
      peerBState,
      {
        elements: afterDelete.elements,
        boardTitle: "Room",
        titleUpdatedAt: 1000,
        tombstones: afterDelete.tombstones,
        hasLocalEdits: true,
        authoritative: false,
        senderPeerId: "p_host",
      },
      "p_peer"
    );
    expect(merged.state.elements.map((e) => e.id)).toEqual(["el_1"]);
    expect(merged.state.tombstones.el_2).toBeDefined();
  });
});
