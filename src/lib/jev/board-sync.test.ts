import { describe, expect, it } from "vitest";
import { createStarterElements } from "@/lib/jev/templates";
import type { JevElement } from "@/lib/jev/types";
import {
  applyLocalElementsChange,
  BoardSyncState,
  computeBoardContentRev,
  diffBoardElements,
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
        verifiedSenderPeerId: "p_host",
      },
      "p_peer",
      { authoritativePeerId: "p_host" }
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
      },
      {
        peerId: "p_edited_second",
        joinedAt: 2000,
        hasLocalEdits: true,
      },
    ]);
    expect(winner).toBe("p_edited_second");

    // If ONLY fresh peers exist, nobody is authoritative
    expect(
      electAuthoritativePeer([
        { peerId: "p_fresh_1", joinedAt: 1000, hasLocalEdits: false },
        { peerId: "p_fresh_2", joinedAt: 2000, hasLocalEdits: false },
      ])
    ).toBeNull();

    // Among multiple non-fresh peers without active creatorPeerId, earliest server-assigned joinedAt wins; peerId breaks ties
    expect(
      electAuthoritativePeer([
        { peerId: "p_older", joinedAt: 1000, hasLocalEdits: true },
        { peerId: "p_newer", joinedAt: 2500, hasLocalEdits: true },
      ])
    ).toBe("p_older");

    expect(
      electAuthoritativePeer([
        { peerId: "p_tied_later", joinedAt: 2500, hasLocalEdits: true },
        { peerId: "p_tied_earlier", joinedAt: 1000, hasLocalEdits: true },
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

describe("JW-10: server-side authority, bulk-delete guard, per-element tombstone clamp & 24h horizon resync", () => {
  it("1. elects authority strictly from server-side creatorPeerId / joinedAt / peerId, ignoring peer-reported contentRev/baseRev", () => {
    // Active creatorPeerId wins even if another peer exists
    expect(
      electAuthoritativePeer(
        [
          {
            peerId: "p_creator",
            joinedAt: 2000,
            hasLocalEdits: true,
            inServerRoster: true,
          },
          {
            peerId: "p_attacker",
            joinedAt: 1000,
            hasLocalEdits: true,
            inServerRoster: true,
          },
        ],
        { creatorPeerId: "p_creator" }
      )
    ).toBe("p_creator");

    // If creatorPeerId is not in active roster (left), earliest server-assigned joinedAt wins
    expect(
      electAuthoritativePeer(
        [
          {
            peerId: "p_earlier_honest",
            joinedAt: 1500,
            hasLocalEdits: true,
            inServerRoster: true,
          },
          {
            peerId: "p_later_attacker",
            joinedAt: 2500,
            hasLocalEdits: true,
            inServerRoster: true,
          },
        ],
        { creatorPeerId: "p_creator_who_left" }
      )
    ).toBe("p_earlier_honest");

    // Tie on joinedAt breaks deterministically by peerId
    expect(
      electAuthoritativePeer(
        [
          { peerId: "p_zzzz", joinedAt: 1500, hasLocalEdits: true, inServerRoster: true },
          { peerId: "p_aaaa", joinedAt: 1500, hasLocalEdits: true, inServerRoster: true },
        ],
        {}
      )
    ).toBe("p_aaaa");

    // Fresh empty joiner who happens to be creatorPeerId (e.g. post-restart) is NEVER elected
    expect(
      electAuthoritativePeer(
        [
          { peerId: "p_fresh_creator", joinedAt: 1000, hasLocalEdits: false, inServerRoster: true },
          { peerId: "p_edited_peer", joinedAt: 2000, hasLocalEdits: true, inServerRoster: true },
        ],
        { creatorPeerId: "p_fresh_creator" }
      )
    ).toBe("p_edited_peer");

    // Peer not in server roster is never eligible
    expect(
      electAuthoritativePeer(
        [
          { peerId: "p_unrostered", joinedAt: 100, hasLocalEdits: true, inServerRoster: false },
          { peerId: "p_rostered", joinedAt: 2000, hasLocalEdits: true, inServerRoster: true },
        ],
        { creatorPeerId: "p_unrostered" }
      )
    ).toBe("p_rostered");
  });

  it("2. rejects non-authoritative fullResync wipe and >30% bulk-delete (500 tombstones), while allowing authoritative replace/bulk-delete with destructiveChange metadata", () => {
    const localElements = Array.from({ length: 10 }, (_, i) =>
      makeNode(`el_${i}`, `Node ${i}`, {
        rev: 2,
        updatedAt: 5000 + i,
        updatedBy: "p_host",
      })
    );
    const localState: BoardSyncState = {
      elements: localElements,
      boardTitle: "Important Architecture",
      titleRev: 2,
      titleUpdatedBy: "p_host",
      tombstones: {},
      hasLocalEdits: true,
      boardEpoch: "bep_prod_1",
      baseRev: 2,
    };

    // Attack A: non-authoritative peer sends { baseRev: 1e9, fullResync: true, elements: [] }
    const fullWipeAttack = mergeRemoteBoardState(
      localState,
      {
        elements: [],
        boardTitle: "Wiped",
        titleRev: 1,
        tombstones: {},
        baseRev: 1_000_000_000,
        fullResync: true,
        hasLocalEdits: true,
        boardEpoch: "bep_prod_1",
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );
    expect(fullWipeAttack.adoptedAuthoritative).toBe(false);
    expect(fullWipeAttack.state.elements).toHaveLength(10);

    // Attack B: non-authoritative peer sends 500 tombstones attempting to wipe all 10 local elements (>30%)
    const fiveHundredTombstones: Record<
      string,
      { deletedAt: number; rev: number; deletedBy: string }
    > = {};
    for (let i = 0; i < 10; i += 1) {
      fiveHundredTombstones[`el_${i}`] = {
        deletedAt: 9000,
        rev: 1_000_000_000,
        deletedBy: "p_mallory",
      };
    }
    for (let i = 10; i < 500; i += 1) {
      fiveHundredTombstones[`el_fake_${i}`] = {
        deletedAt: 9000,
        rev: 1_000_000_000,
        deletedBy: "p_mallory",
      };
    }

    const bulkTombAttack = mergeRemoteBoardState(
      localState,
      {
        elements: [],
        boardTitle: "Important Architecture",
        titleRev: 2,
        tombstones: fiveHundredTombstones,
        hasLocalEdits: true,
        boardEpoch: "bep_prod_1",
        baseRev: 2,
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );
    expect(bulkTombAttack.changed).toBe(false);
    expect(bulkTombAttack.rejectedReason).toBe("unauthorized_bulk_delete");
    expect(bulkTombAttack.state.elements).toHaveLength(10);

    // Non-authoritative peer deleting <= 30% (e.g. 2 of 10 = 20%) is still allowed
    const smallDelete = mergeRemoteBoardState(
      localState,
      {
        elements: localElements.slice(2),
        boardTitle: "Important Architecture",
        titleRev: 2,
        tombstones: {
          el_0: { deletedAt: 9000, rev: 3, deletedBy: "p_peer" },
          el_1: { deletedAt: 9000, rev: 3, deletedBy: "p_peer" },
        },
        hasLocalEdits: true,
        boardEpoch: "bep_prod_1",
        baseRev: 3,
        senderPeerId: "p_peer",
        verifiedSenderPeerId: "p_peer",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );
    expect(smallDelete.changed).toBe(true);
    expect(smallDelete.state.elements).toHaveLength(8);
    expect(smallDelete.destructiveChange).toBeUndefined();

    // Authoritative peer sending fullResync replace removing >30% IS accepted and flags destructiveChange
    const authReplace = mergeRemoteBoardState(
      localState,
      {
        elements: [],
        boardTitle: "Cleared By Host",
        titleRev: 3,
        tombstones: {},
        hasLocalEdits: true,
        fullResync: true,
        boardEpoch: "bep_prod_1",
        baseRev: 3,
        senderPeerId: "p_host",
        verifiedSenderPeerId: "p_host",
      },
      "p_peer",
      { authoritativePeerId: "p_host" }
    );
    expect(authReplace.adoptedAuthoritative).toBe(true);
    expect(authReplace.state.elements).toEqual([]);
    expect(authReplace.destructiveChange).toMatchObject({
      kind: "full_replace",
      removedCount: 10,
      localCount: 10,
      removalRatio: 1,
    });

    // Authoritative peer bulk-deleting 5 of 10 (50%) via tombstones IS accepted and flags destructiveChange
    const authBulkDelete = mergeRemoteBoardState(
      localState,
      {
        elements: localElements.slice(5),
        boardTitle: "Important Architecture",
        titleRev: 2,
        tombstones: {
          el_0: { deletedAt: 9000, rev: 3, deletedBy: "p_host" },
          el_1: { deletedAt: 9000, rev: 3, deletedBy: "p_host" },
          el_2: { deletedAt: 9000, rev: 3, deletedBy: "p_host" },
          el_3: { deletedAt: 9000, rev: 3, deletedBy: "p_host" },
          el_4: { deletedAt: 9000, rev: 3, deletedBy: "p_host" },
        },
        hasLocalEdits: true,
        boardEpoch: "bep_prod_1",
        baseRev: 3,
        senderPeerId: "p_host",
        verifiedSenderPeerId: "p_host",
      },
      "p_peer",
      { authoritativePeerId: "p_host" }
    );
    expect(authBulkDelete.changed).toBe(true);
    expect(authBulkDelete.state.elements).toHaveLength(5);
    expect(authBulkDelete.destructiveChange).toMatchObject({
      kind: "bulk_delete",
      removedCount: 5,
      localCount: 10,
      removalRatio: 0.5,
    });

    // Restoring the pre-wipe snapshot via applyLocalElementsChange bumps revisions cleanly above tombstones
    const restored = applyLocalElementsChange(
      authBulkDelete.state.elements,
      localElements,
      authBulkDelete.state.tombstones,
      "p_peer",
      12_000,
      authBulkDelete.state.tombstoneHorizonRev
    );
    expect(restored.elements).toHaveLength(10);
    expect(restored.elements.find((e) => e.id === "el_0")?.rev).toBe(4);
    expect(restored.tombstones.el_0).toBeUndefined();
  });

  it("3. clamps incoming tombstone rev per element (localElement.rev + 1, or 1 for unknown), never global localMaxRev + 1", () => {
    const localState: BoardSyncState = {
      elements: [
        makeNode("el_low", "Low Rev Node", {
          rev: 2,
          updatedAt: 2000,
          updatedBy: "p_honest",
        }),
        makeNode("el_high", "High Rev Node", {
          rev: 50,
          updatedAt: 5000,
          updatedBy: "p_honest",
        }),
        makeNode("el_keep_1", "Keep 1", { rev: 5, updatedAt: 3000 }),
        makeNode("el_keep_2", "Keep 2", { rev: 5, updatedAt: 3000 }),
      ],
      boardTitle: "Board",
      titleRev: 1,
      tombstones: {
        el_existing_tomb: { deletedAt: 1000, rev: 4, deletedBy: "p_honest" },
      },
      hasLocalEdits: true,
      baseRev: 50,
    };

    // Incoming tombstone has rev=1e9 for el_low (rev=2), el_unknown (not present), and el_existing_tomb (rev=4)
    // Global localMaxRev is 50! Only 1 of 4 local elements (25% <= 30%) is deleted.
    const merged = mergeRemoteBoardState(
      localState,
      {
        elements: localState.elements.filter((e) => e.id !== "el_low"),
        boardTitle: "Board",
        titleRev: 1,
        tombstones: {
          el_low: { deletedAt: 6000, rev: 1_000_000_000, deletedBy: "p_peer" },
          el_unknown: { deletedAt: 6000, rev: 1_000_000_000, deletedBy: "p_peer" },
          el_existing_tomb: {
            deletedAt: 6000,
            rev: 1_000_000_000,
            deletedBy: "p_peer",
          },
        },
        hasLocalEdits: true,
        baseRev: 50,
        senderPeerId: "p_peer",
        verifiedSenderPeerId: "p_peer",
      },
      "p_honest",
      { authoritativePeerId: "p_honest" }
    );

    // Must clamp per element: 2+1=3 (NOT 51!), unknown -> 1 (NOT 51!), existing tombstone 4+1=5 (NOT 51!)
    expect(merged.state.tombstones.el_low?.rev).toBe(3);
    expect(merged.state.tombstones.el_unknown?.rev).toBe(1);
    expect(merged.state.tombstones.el_existing_tomb?.rev).toBe(5);
  });

  it("4. refuses incremental merge from a peer offline >24h (baseTimestamp predates tombstoneHorizonAt, boardEpochCreatedAt, or 24h TTL) and forces full authoritative resync", () => {
    const HOUR = 60 * 60 * 1000;
    const T0 = 1_750_000_000_000;

    // Host prunes a tombstone deleted at T0 + 1h when now = T0 + 26h (>24h TTL)
    const pruned = pruneTombstonesWithHorizon(
      {
        el_pruned_zombie: {
          deletedAt: T0 + 1 * HOUR,
          rev: 5,
          deletedBy: "p_host",
        },
      },
      0,
      { ttlMs: 24 * HOUR, now: T0 + 26 * HOUR }
    );
    expect(pruned.tombstoneHorizonRev).toBe(5);
    expect(pruned.tombstoneHorizonAt).toBe(T0 + 1 * HOUR);

    const hostState: BoardSyncState = {
      elements: [makeNode("el_alive", "Alive", { rev: 10, updatedAt: T0 + 2 * HOUR })],
      boardTitle: "Room",
      titleRev: 2,
      tombstones: {},
      tombstoneHorizonRev: 5,
      tombstoneHorizonAt: T0 + 1 * HOUR,
      boardEpoch: "bep_horizon_1",
      boardEpochCreatedAt: T0,
      baseRev: 10,
      baseTimestamp: T0 + 26 * HOUR,
      hasLocalEdits: true,
    };

    // Offline peer was last synced at T0 (>24h ago), made offline edits bumping its local baseRev to 99 (>5!),
    // and still holds el_pruned_zombie! Timestamp horizon MUST still refuse incremental merge!
    const offlineMerge = mergeRemoteBoardState(
      hostState,
      {
        elements: [
          makeNode("el_alive", "Alive", { rev: 10, updatedAt: T0 }),
          makeNode("el_pruned_zombie", "Zombie", { rev: 3, updatedAt: T0 }),
        ],
        boardTitle: "Room",
        titleRev: 2,
        tombstones: {},
        boardEpoch: "bep_horizon_1",
        baseRev: 99,
        baseTimestamp: T0,
        hasLocalEdits: true,
        senderPeerId: "p_offline_peer",
        verifiedSenderPeerId: "p_offline_peer",
      },
      "p_host",
      {
        authoritativePeerId: "p_host",
        now: T0 + 26 * HOUR,
        tombstoneTtlMs: 24 * HOUR,
      }
    );

    expect(offlineMerge.needsFullResync).toBe(true);
    expect(offlineMerge.resyncReason).toBe("tombstone_horizon");
    expect(offlineMerge.changed).toBe(false);
    expect(offlineMerge.state.elements.map((e) => e.id)).toEqual(["el_alive"]);

    // Peer whose baseTimestamp predates boardEpochCreatedAt is refused with epoch_mismatch
    const preEpochMerge = mergeRemoteBoardState(
      {
        ...hostState,
        tombstoneHorizonRev: 0,
        tombstoneHorizonAt: 0,
        boardEpochCreatedAt: T0 + 10 * HOUR,
      },
      {
        elements: [makeNode("el_old", "Old Epoch", { rev: 11 })],
        boardTitle: "Room",
        titleRev: 2,
        tombstones: {},
        boardEpoch: "bep_horizon_1",
        baseRev: 11,
        baseTimestamp: T0 + 5 * HOUR,
        hasLocalEdits: true,
        senderPeerId: "p_old_epoch",
        verifiedSenderPeerId: "p_old_epoch",
      },
      "p_host",
      {
        authoritativePeerId: "p_host",
        now: T0 + 12 * HOUR,
        tombstoneTtlMs: 24 * HOUR,
      }
    );
    expect(preEpochMerge.needsFullResync).toBe(true);
    expect(preEpochMerge.resyncReason).toBe("epoch_mismatch");
  });
});

describe("JW-13: <4-element board protection & edit/delete diffing", () => {
  it("removes the <4-element exemption: rejects >30% tombstone deletes from non-authority peers on 1-, 2-, and 3-element boards", () => {
    for (const count of [1, 2, 3]) {
      const localElements = Array.from({ length: count }, (_, i) =>
        makeNode(`small_${i}`, `Small ${i}`, { rev: 2, updatedAt: 2000 })
      );
      const localState: BoardSyncState = {
        elements: localElements,
        boardTitle: "Small Board",
        titleRev: 1,
        tombstones: {},
        hasLocalEdits: true,
        baseRev: 2,
      };

      // Deleting 1 element on a 1/2/3-element board is 100% / 50% / 33.3% (>30%)
      const nonAuthDelete = mergeRemoteBoardState(
        localState,
        {
          elements: localElements.slice(1),
          boardTitle: "Small Board",
          titleRev: 1,
          tombstones: {
            small_0: { deletedAt: 5000, rev: 3, deletedBy: "p_mallory" },
          },
          hasLocalEdits: true,
          baseRev: 3,
          senderPeerId: "p_mallory",
          verifiedSenderPeerId: "p_mallory",
        },
        "p_host",
        { authoritativePeerId: "p_host" }
      );
      expect(nonAuthDelete.changed).toBe(false);
      expect(nonAuthDelete.rejectedReason).toBe("unauthorized_bulk_delete");
      expect(nonAuthDelete.state.elements).toHaveLength(count);

      // Authoritative peer deleting 1 element on a 1/2/3-element board succeeds AND flags destructiveChange for 1-click recovery
      const authDelete = mergeRemoteBoardState(
        localState,
        {
          elements: localElements.slice(1),
          boardTitle: "Small Board",
          titleRev: 1,
          tombstones: {
            small_0: { deletedAt: 5000, rev: 3, deletedBy: "p_host" },
          },
          hasLocalEdits: true,
          baseRev: 3,
          senderPeerId: "p_host",
          verifiedSenderPeerId: "p_host",
        },
        "p_peer",
        { authoritativePeerId: "p_host" }
      );
      expect(authDelete.changed).toBe(true);
      expect(authDelete.state.elements).toHaveLength(count - 1);
      expect(authDelete.destructiveChange).toMatchObject({
        kind: "bulk_delete",
        removedCount: 1,
        localCount: count,
      });
    }
  });

  it("detects both edits (label, coords, size, points/arrow, style) and deletes in diffBoardElements and MergeBoardResult.changeDiff", () => {
    const prev: JevElement[] = [
      makeNode("el_label", "Original Label", { rev: 1 }),
      makeNode("el_pos", "Pos", { x: 100, y: 100, rev: 1 }),
      makeNode("el_size", "Size", { width: 160, height: 70, rev: 1 }),
      makeNode("el_style", "Style", { tone: "cobalt", rev: 1 }),
      makeNode("el_arrow", "", {
        kind: "arrow",
        fromPoint: { x: 10, y: 20 },
        toPoint: { x: 100, y: 200 },
        rev: 1,
      }),
      makeNode("el_freedraw", "", {
        kind: "freedraw",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        rev: 1,
      }),
      makeNode("el_del", "Deleted", { rev: 1 }),
      makeNode("el_same", "Unchanged", { rev: 1 }),
    ];

    const next: JevElement[] = [
      { ...prev[0], label: "", rev: 2 },
      { ...prev[1], x: 100_000, y: 100_000, rev: 2 },
      { ...prev[2], width: 10, height: 10, rev: 2 },
      { ...prev[3], tone: "terracotta", kind: "diamond", rev: 2 },
      { ...prev[4], toPoint: { x: 999, y: 999 }, rev: 2 },
      {
        ...prev[5],
        points: [
          { x: 0, y: 0 },
          { x: 500, y: 500 },
        ],
        rev: 2,
      },
      // el_del removed
      prev[7],
      makeNode("el_added", "Brand New", { rev: 2 }),
    ];

    const diff = diffBoardElements(prev, next);
    expect(diff.localCount).toBe(8);
    expect(diff.deletedIds).toEqual(["el_del"]);
    expect(diff.editedIds.sort()).toEqual([
      "el_arrow",
      "el_freedraw",
      "el_label",
      "el_pos",
      "el_size",
      "el_style",
    ]);
    expect(diff.addedIds).toEqual(["el_added"]);
    expect(diff.changedCount).toBe(7);
    expect(diff.changeRatio).toBeCloseTo(7 / 8);

    // Edit vandalism via sync_state (all IDs reused with blank labels & COORD_LIMIT coords) populates changeDiff
    const vandalized = prev.map((el) => ({
      ...el,
      label: "",
      x: 100_000,
      y: 100_000,
      rev: 2,
      updatedAt: 9000,
    }));
    const merged = mergeRemoteBoardState(
      {
        elements: prev,
        boardTitle: "Prod",
        titleRev: 1,
        tombstones: {},
        hasLocalEdits: true,
        baseRev: 1,
      },
      {
        elements: vandalized,
        boardTitle: "Prod",
        titleRev: 1,
        tombstones: {},
        hasLocalEdits: true,
        baseRev: 2,
        senderPeerId: "p_vandal",
        verifiedSenderPeerId: "p_vandal",
      },
      "p_host",
      { authoritativePeerId: "p_host" }
    );
    expect(merged.changed).toBe(true);
    expect(merged.changeDiff?.editedCount).toBe(8);
    expect(merged.changeDiff?.deletedCount).toBe(0);
    expect(merged.changeDiff?.changeRatio).toBe(1);
  });
});
