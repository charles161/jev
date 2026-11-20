import { describe, expect, it } from "vitest";
import { createStarterElements } from "@/lib/jev/templates";
import type { JevElement } from "@/lib/jev/types";
import {
  applyLocalElementsChange,
  BoardSyncState,
  computeBoardContentRev,
  electAuthoritativePeer,
  mergeRemoteBoardState,
  pruneTombstonesWithHorizon,
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

describe("Fix 3: connection-bound sender identity, untrusted authoritative flag & rev clamping", () => {
  it("binds tie-breaks to verifiedSenderPeerId and ignores spoofed updatedBy/peerId", () => {
    const localState: BoardSyncState = {
      elements: [
        makeNode("el_tie", "Honest Edit", {
          rev: 2,
          updatedAt: 5000,
          updatedBy: "p_mmm_honest",
        }),
      ],
      boardTitle: "Board",
      titleRev: 1,
      titleUpdatedBy: "p_mmm_honest",
      tombstones: {},
      hasLocalEdits: true,
    };

    // Mallory is on connection "p_aaa_mallory" (< "p_mmm_honest") but spoofs peerId & updatedBy as "p_zzz_spoof"
    const merged = mergeRemoteBoardState(
      localState,
      {
        elements: [
          makeNode("el_tie", "Spoofed Edit", {
            rev: 2,
            updatedAt: 5000,
            updatedBy: "p_zzz_spoof",
          }),
        ],
        boardTitle: "Board",
        titleRev: 1,
        titleUpdatedBy: "p_zzz_spoof",
        tombstones: {},
        hasLocalEdits: true,
        senderPeerId: "p_zzz_spoof",
        verifiedSenderPeerId: "p_aaa_mallory",
      },
      "p_mmm_honest"
    );

    // Verified peer ID "p_aaa_mallory" < "p_mmm_honest", so honest edit MUST win the tie!
    expect(merged.state.elements[0].label).toBe("Honest Edit");
  });

  it("ignores self-declared authoritative: true from peers and derives authority strictly from roster", () => {
    const hostState: BoardSyncState = {
      elements: [makeNode("host_el", "Real Work", { rev: 4 })],
      boardTitle: "Real Board",
      titleRev: 2,
      titleUpdatedBy: "p_host",
      tombstones: {},
      hasLocalEdits: true,
    };

    // Malicious fresh peer claims authoritative: true to bypass fresh-joiner protection
    const spoofedFresh = mergeRemoteBoardState(
      hostState,
      {
        elements: createStarterElements(),
        boardTitle: "System Sketch",
        titleRev: 0,
        tombstones: {},
        hasLocalEdits: false,
        authoritative: true,
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );

    expect(spoofedFresh.changed).toBe(false);
    expect(spoofedFresh.adoptedAuthoritative).toBe(false);
    expect(spoofedFresh.state.elements.map((e) => e.id)).toEqual(["host_el"]);
  });

  it("clamps incoming rev (e.g. 1e9) per update so a malicious peer cannot permanently lock out edits", () => {
    const localState: BoardSyncState = {
      elements: [
        makeNode("el_1", "Original", {
          rev: 2,
          updatedAt: 2000,
          updatedBy: "p_honest",
        }),
      ],
      boardTitle: "Board",
      titleRev: 1,
      titleUpdatedBy: "p_honest",
      tombstones: {},
      hasLocalEdits: true,
    };

    // Malicious peer sends rev = 1_000_000_000
    const afterAttack = mergeRemoteBoardState(
      localState,
      {
        elements: [
          makeNode("el_1", "Hijacked", {
            rev: 1_000_000_000,
            updatedAt: 3000,
            updatedBy: "p_mallory",
          }),
        ],
        boardTitle: "Board",
        titleRev: 1,
        tombstones: {},
        hasLocalEdits: true,
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      "p_honest"
    );

    // Clamped to at most localMaxRev + 1 = 3 (NOT 1e9!)
    const hijackedEl = afterAttack.state.elements.find((e) => e.id === "el_1")!;
    expect(hijackedEl.rev).toBeLessThanOrEqual(3);

    // Honest peer makes ONE normal local edit -> rev becomes 4, winning cleanly!
    const localRecovery = applyLocalElementsChange(
      afterAttack.state.elements,
      [{ ...hijackedEl, label: "Recovered By Honest" }],
      afterAttack.state.tombstones,
      "p_honest",
      4000
    );
    expect(localRecovery.elements[0].rev).toBe(4);
    expect(localRecovery.elements[0].label).toBe("Recovered By Honest");
  });
});

describe("Fix 4: post-restart host election", () => {
  it("never elects a fresh starter board as authoritative even if it rejoined first after server restart", () => {
    const winner = electAuthoritativePeer([
      {
        peerId: "p_fresh_first",
        joinedAt: 1000,
        hasLocalEdits: false,
        contentRev: 0,
      },
      {
        peerId: "p_edited_second",
        joinedAt: 2000,
        hasLocalEdits: true,
        contentRev: 8,
      },
    ]);
    expect(winner).toBe("p_edited_second");

    // If ONLY fresh peers exist, nobody is authoritative
    expect(
      electAuthoritativePeer([
        { peerId: "p_fresh_1", joinedAt: 1000, hasLocalEdits: false, contentRev: 0 },
        { peerId: "p_fresh_2", joinedAt: 2000, hasLocalEdits: false, contentRev: 0 },
      ])
    ).toBeNull();

    // Among multiple content-bearing peers, highest contentRev wins; joinedAt breaks ties
    expect(
      electAuthoritativePeer([
        { peerId: "p_older_low", joinedAt: 1000, hasLocalEdits: true, contentRev: 4 },
        { peerId: "p_newer_high", joinedAt: 2500, hasLocalEdits: true, contentRev: 12 },
      ])
    ).toBe("p_newer_high");

    expect(
      electAuthoritativePeer([
        { peerId: "p_tied_later", joinedAt: 2500, hasLocalEdits: true, contentRev: 12 },
        { peerId: "p_tied_earlier", joinedAt: 1000, hasLocalEdits: true, contentRev: 12 },
      ])
    ).toBe("p_tied_earlier");

    // computeBoardContentRev returns 0 for fresh boards and >= 1 for edited boards (including blank)
    expect(
      computeBoardContentRev({
        elements: createStarterElements(),
        titleRev: 0,
        tombstones: {},
        hasLocalEdits: false,
      })
    ).toBe(0);
    expect(
      computeBoardContentRev({
        elements: [],
        titleRev: 0,
        tombstones: {},
        hasLocalEdits: true,
      })
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("Fix 5: tombstone horizon, TTL eviction & stale peer full resync", () => {
  it("advances tombstoneHorizonRev on count cap and TTL eviction", () => {
    const map = {
      el_old_1: { deletedAt: 1000, rev: 10, deletedBy: "p_host" },
      el_old_2: { deletedAt: 2000, rev: 25, deletedBy: "p_host" },
      el_recent: { deletedAt: 99_000, rev: 30, deletedBy: "p_host" },
    };

    // Count cap to 1 keeps el_recent and advances horizon to max evicted rev (25)
    const byCount = pruneTombstonesWithHorizon(map, 0, {
      maxTombstones: 1,
      now: 100_000,
    });
    expect(Object.keys(byCount.tombstones)).toEqual(["el_recent"]);
    expect(byCount.tombstoneHorizonRev).toBe(25);

    // TTL eviction (ttlMs = 50_000 at now = 100_000) evicts el_old_1 & el_old_2 and advances horizon to 25
    const byTtl = pruneTombstonesWithHorizon(map, 0, {
      maxTombstones: 500,
      ttlMs: 50_000,
      now: 100_000,
    });
    expect(Object.keys(byTtl.tombstones)).toEqual(["el_recent"]);
    expect(byTtl.tombstoneHorizonRev).toBe(25);
  });

  it("refuses incremental merge from a stale peer (baseRev < tombstoneHorizonRev) or mismatched boardEpoch and requests full resync", () => {
    const hostState: BoardSyncState = {
      elements: [makeNode("el_alive", "Alive", { rev: 600 })],
      boardTitle: "Room",
      titleRev: 1,
      tombstones: {},
      hasLocalEdits: true,
      boardEpoch: "bepoch_abc123",
      tombstoneHorizonRev: 500,
      baseRev: 600,
    };

    // Stale peer still has deleted "el_zombie" (rev 10) and baseRev = 12 < tombstoneHorizonRev (500)
    const staleResult = mergeRemoteBoardState(
      hostState,
      {
        elements: [
          makeNode("el_alive", "Alive", { rev: 12 }),
          makeNode("el_zombie", "Deleted Long Ago", { rev: 10 }),
        ],
        boardTitle: "Room",
        titleRev: 1,
        tombstones: {},
        hasLocalEdits: true,
        boardEpoch: "bepoch_abc123",
        baseRev: 12,
        senderPeerId: "p_stale",
        verifiedSenderPeerId: "p_stale",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );

    expect(staleResult.needsFullResync).toBe(true);
    expect(staleResult.resyncReason).toBe("tombstone_horizon");
    expect(staleResult.changed).toBe(false);
    // Deleted zombie element MUST NOT resurrect!
    expect(staleResult.state.elements.map((e) => e.id)).toEqual(["el_alive"]);

    // Mismatched boardEpoch also refuses incremental merge and triggers resync
    const epochMismatch = mergeRemoteBoardState(
      hostState,
      {
        elements: [makeNode("el_other", "Other Epoch", { rev: 601 })],
        boardTitle: "Other",
        titleRev: 2,
        tombstones: {},
        hasLocalEdits: true,
        boardEpoch: "bepoch_DIFFERENT",
        baseRev: 601,
        senderPeerId: "p_other",
        verifiedSenderPeerId: "p_other",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );
    expect(epochMismatch.needsFullResync).toBe(true);
    expect(epochMismatch.resyncReason).toBe("epoch_mismatch");
    expect(epochMismatch.state.elements.map((e) => e.id)).toEqual(["el_alive"]);

    // Stale peer adopting an authoritative fullResync drops el_zombie and updates horizon + epoch!
    const stalePeerLocal: BoardSyncState = {
      elements: [
        makeNode("el_alive", "Alive", { rev: 12 }),
        makeNode("el_zombie", "Deleted Long Ago", { rev: 10 }),
      ],
      boardTitle: "Room",
      titleRev: 1,
      tombstones: {},
      hasLocalEdits: true,
      boardEpoch: "bepoch_abc123",
      tombstoneHorizonRev: 0,
      baseRev: 12,
    };
    const resynced = mergeRemoteBoardState(
      stalePeerLocal,
      {
        elements: hostState.elements,
        boardTitle: hostState.boardTitle,
        titleRev: 1,
        tombstones: {},
        hasLocalEdits: true,
        boardEpoch: "bepoch_abc123",
        tombstoneHorizonRev: 500,
        baseRev: 600,
        fullResync: true,
        senderPeerId: "p_host",
        verifiedSenderPeerId: "p_host",
      },
      "p_stale",
      { authoritativePeerId: "p_host" }
    );
    expect(resynced.adoptedAuthoritative).toBe(true);
    expect(resynced.needsFullResync).toBe(false);
    expect(resynced.state.elements.map((e) => e.id)).toEqual(["el_alive"]);
    expect(resynced.state.tombstoneHorizonRev).toBe(500);
  });
});

describe("Fix 9: logical titleRev instead of wall-clock titleUpdatedAt", () => {
  it("resolves title conflicts using monotonic titleRev + verified titleUpdatedBy regardless of clock skew, and clamps titleRev", () => {
    const localState: BoardSyncState = {
      elements: [],
      boardTitle: "Newer Logical Title",
      titleRev: 3,
      titleUpdatedBy: "p_alpha",
      titleUpdatedAt: 1_000, // slow local clock
      tombstones: {},
      hasLocalEdits: true,
    };

    // Remote has fast skewed wall clock (9_999_999_999) but lower logical titleRev (2)
    const lowerRev = mergeRemoteBoardState(
      localState,
      {
        elements: [],
        boardTitle: "Stale Fast-Clock Title",
        titleRev: 2,
        titleUpdatedBy: "p_beta",
        titleUpdatedAt: 9_999_999_999,
        tombstones: {},
        hasLocalEdits: true,
        senderPeerId: "p_beta",
        verifiedSenderPeerId: "p_beta",
      },
      "p_alpha"
    );
    expect(lowerRev.state.boardTitle).toBe("Newer Logical Title");
    expect(lowerRev.state.titleRev).toBe(3);

    // Tie on titleRev (3 === 3) uses verified sender peer ID, ignoring spoofed titleUpdatedBy
    const tied = mergeRemoteBoardState(
      localState,
      {
        elements: [],
        boardTitle: "Tie Remote Title",
        titleRev: 3,
        titleUpdatedBy: "p_zzz_spoof",
        titleUpdatedAt: 9_999_999_999,
        tombstones: {},
        hasLocalEdits: true,
        senderPeerId: "p_zzz_spoof",
        verifiedSenderPeerId: "p_aaa_mallory",
      },
      "p_alpha"
    );
    // "p_aaa_mallory" < "p_alpha", so local title MUST win despite spoofed titleUpdatedBy!
    expect(tied.state.boardTitle).toBe("Newer Logical Title");

    // Malicious titleRev = 1_000_000_000 is clamped to local.titleRev + 1 = 4
    const clamped = mergeRemoteBoardState(
      localState,
      {
        elements: [],
        boardTitle: "Clamped Title",
        titleRev: 1_000_000_000,
        tombstones: {},
        hasLocalEdits: true,
        senderPeerId: "p_beta",
        verifiedSenderPeerId: "p_beta",
      },
      "p_alpha"
    );
    expect(clamped.state.boardTitle).toBe("Clamped Title");
    expect(clamped.state.titleRev).toBe(4);
  });
});
