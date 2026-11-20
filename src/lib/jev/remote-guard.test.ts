import { describe, expect, it } from "vitest";
import type { BoardSyncState, RemoteSyncPayload } from "@/lib/jev/board-sync";
import {
  PEER_PAUSE_CHANGE_RATIO,
  PERIODIC_SNAPSHOT_INTERVAL_MS,
  REMOTE_CHANGE_SNAPSHOT_RATIO,
  REMOTE_CHANGE_WINDOW_MS,
  RemoteChangeGuard,
} from "@/lib/jev/remote-guard";
import type { JevElement } from "@/lib/jev/types";

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

function makeBoard(count: number, prefix = "el"): BoardSyncState {
  return {
    elements: Array.from({ length: count }, (_, i) =>
      makeNode(`${prefix}_${i}`, `Node ${i}`, {
        x: 100 + i * 20,
        y: 100,
        rev: 2,
        updatedAt: 2000,
        updatedBy: "p_host",
      })
    ),
    boardTitle: "System Architecture",
    titleRev: 1,
    titleUpdatedBy: "p_host",
    tombstones: {},
    boardEpoch: "bep_test",
    boardEpochCreatedAt: 1000,
    baseRev: 2,
    baseTimestamp: 2000,
    hasLocalEdits: true,
  };
}

describe("JW-13: RemoteChangeGuard (edit/delete cumulative snapshots, 2m periodic ring, per-sender >50% pause + Keep/Revert)", () => {
  it("exports expected guard thresholds", () => {
    expect(REMOTE_CHANGE_SNAPSHOT_RATIO).toBe(0.3);
    expect(PEER_PAUSE_CHANGE_RATIO).toBe(0.5);
    expect(REMOTE_CHANGE_WINDOW_MS).toBe(60_000);
    expect(PERIODIC_SNAPSHOT_INTERVAL_MS).toBe(120_000);
  });

  it("pauses edit vandalism via single sync_state (>50% labels cleared & moved to COORD_LIMIT), quarantines subsequent batches, and supports Revert & Keep", () => {
    const guard = new RemoteChangeGuard(10_000);
    const local = makeBoard(10);

    // Attacker reuses all 10 IDs with blank labels and COORD_LIMIT coords
    const vandalPayload: RemoteSyncPayload = {
      elements: local.elements.map((el) => ({
        ...el,
        label: "",
        x: 100_000,
        y: 100_000,
        rev: 3,
        updatedAt: 11_000,
      })),
      boardTitle: local.boardTitle,
      titleRev: 1,
      tombstones: {},
      boardEpoch: "bep_test",
      baseRev: 3,
      hasLocalEdits: true,
      senderPeerId: "p_vandal",
      verifiedSenderPeerId: "p_vandal",
    };

    const res1 = guard.evaluateIncoming({
      local,
      remote: vandalPayload,
      localPeerId: "p_host",
      senderName: "Mallory",
      mergeOptions: { authoritativePeerId: "p_host", now: 11_000 },
      now: 11_000,
    });

    expect(res1.decision).toBe("paused");
    if (res1.decision !== "paused") return;
    expect(res1.incident.peerId).toBe("p_vandal");
    expect(res1.incident.peerName).toBe("Mallory");
    expect(res1.incident.changedCount).toBe(10);
    expect(res1.incident.baselineCount).toBe(10);
    expect(res1.incident.quarantinedCount).toBe(1);
    expect(res1.recoveryEntry).toBeDefined();
    expect(res1.recoveryEntry?.reason).toBe("peer_quarantine");
    expect(res1.recoveryEntry?.snapshot.elements).toHaveLength(10);
    expect(res1.recoveryEntry?.snapshot.elements[0].label).toBe("Node 0");

    // Subsequent batch from paused peer is quarantined without applying
    const followUp: RemoteSyncPayload = {
      ...vandalPayload,
      elements: local.elements.map((el) => ({
        ...el,
        label: "Still Vandal",
        rev: 4,
        updatedAt: 12_000,
      })),
      baseRev: 4,
    };
    const res2 = guard.evaluateIncoming({
      local,
      remote: followUp,
      localPeerId: "p_host",
      senderName: "Mallory",
      mergeOptions: { authoritativePeerId: "p_host", now: 12_000 },
      now: 12_000,
    });
    expect(res2.decision).toBe("paused");
    if (res2.decision === "paused") {
      expect(res2.incident.quarantinedCount).toBe(2);
    }

    // Revert discards quarantined batches and returns the clean pre-incident snapshot
    const reverted = guard.resolvePeerIncident("p_vandal", "revert", 13_000);
    expect(reverted).not.toBeNull();
    expect(reverted?.action).toBe("revert");
    if (reverted?.action === "revert") {
      expect(reverted.restoreSnapshot.elements).toHaveLength(10);
      expect(reverted.restoreSnapshot.elements[0].label).toBe("Node 0");
      expect(reverted.restoreSnapshot.elements[0].x).toBe(100);
    }
    expect(guard.getActiveIncidents()).toHaveLength(0);

    // Trigger pause again and choose Keep -> returns quarantined payloads & unpauses peer
    const res3 = guard.evaluateIncoming({
      local,
      remote: vandalPayload,
      localPeerId: "p_host",
      senderName: "Mallory",
      mergeOptions: { authoritativePeerId: "p_host", now: 14_000 },
      now: 14_000,
    });
    expect(res3.decision).toBe("paused");

    const kept = guard.resolvePeerIncident("p_vandal", "keep", 15_000);
    expect(kept).not.toBeNull();
    expect(kept?.action).toBe("keep");
    if (kept?.action === "keep") {
      expect(kept.payloadsToApply).toHaveLength(1);
      expect(kept.payloadsToApply[0].elements[0].x).toBe(100_000);
    }
    expect(guard.getActiveIncidents()).toHaveLength(0);
  });

  it("catches repeated ~29% tombstone/delete batches within 60s: saves pre-incident 100-element snapshot on >30% cumulative toast and pauses at >50%", () => {
    const guard = new RemoteChangeGuard(10_000);
    let current = makeBoard(100);

    // Batch 1 (t=11s): Mallory deletes 29 of 100 (29% <= 30% single, <= 50% peer)
    const tomb1: BoardSyncState["tombstones"] = {};
    for (let i = 0; i < 29; i += 1) {
      tomb1[`el_${i}`] = { deletedAt: 11_000, rev: 3, deletedBy: "p_mallory" };
    }
    const r1 = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.slice(29),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: tomb1,
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      localPeerId: "p_host",
      senderName: "Mallory",
      mergeOptions: { authoritativePeerId: "p_host", now: 11_000 },
      now: 11_000,
    });
    expect(r1.decision).toBe("apply");
    if (r1.decision !== "apply") return;
    expect(r1.showRestoreToast).toBe(false);
    expect(r1.recoveryEntry).toBeUndefined();
    current = r1.merged.state;
    expect(current.elements).toHaveLength(71);

    // Batch 2 (t=20s): Mallory deletes 20 of remaining 71 (20/71=28.2% <= 30% single, cumulative 49/100=49% > 30%!)
    const tomb2: BoardSyncState["tombstones"] = { ...current.tombstones };
    for (let i = 29; i < 49; i += 1) {
      tomb2[`el_${i}`] = { deletedAt: 20_000, rev: 3, deletedBy: "p_mallory" };
    }
    const r2 = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.slice(20),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: tomb2,
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      localPeerId: "p_host",
      senderName: "Mallory",
      mergeOptions: { authoritativePeerId: "p_host", now: 20_000 },
      now: 20_000,
    });
    expect(r2.decision).toBe("apply");
    if (r2.decision !== "apply") return;
    // Cumulative >30% triggers pre-change snapshot of ALL 100 original elements + Restore toast!
    expect(r2.showRestoreToast).toBe(true);
    expect(r2.recoveryEntry).toBeDefined();
    expect(r2.recoveryEntry?.snapshot.elements).toHaveLength(100);
    current = r2.merged.state;
    expect(current.elements).toHaveLength(51);

    // Batch 3 (t=30s): Mallory deletes 10 more of 51 (10/51=19.6% <= 30% single, cumulative 59/100=59% > 50%!)
    const tomb3: BoardSyncState["tombstones"] = { ...current.tombstones };
    for (let i = 49; i < 59; i += 1) {
      tomb3[`el_${i}`] = { deletedAt: 30_000, rev: 3, deletedBy: "p_mallory" };
    }
    const r3 = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.slice(10),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: tomb3,
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_mallory",
        verifiedSenderPeerId: "p_mallory",
      },
      localPeerId: "p_host",
      senderName: "Mallory",
      mergeOptions: { authoritativePeerId: "p_host", now: 30_000 },
      now: 30_000,
    });
    expect(r3.decision).toBe("paused");
    if (r3.decision !== "paused") return;
    expect(r3.incident.peerName).toBe("Mallory");
    expect(r3.incident.changedCount).toBe(59);
    // Revert restores the full pre-incident 100-element board from before Batch 1!
    const revert = guard.resolvePeerIncident("p_mallory", "revert", 31_000);
    expect(revert?.action).toBe("revert");
    if (revert?.action === "revert") {
      expect(revert.restoreSnapshot.elements).toHaveLength(100);
    }
  });

  it("snapshots small 1–3 element boards on remote edit/delete so they are always 1-click recoverable", () => {
    const guard = new RemoteChangeGuard(10_000);
    const local3 = makeBoard(3);

    // Editing 1 of 3 elements (33.3% > 30%, <= 50%) -> applies, saves pre-change snapshot, shows Restore toast
    const r1 = guard.evaluateIncoming({
      local: local3,
      remote: {
        elements: [
          { ...local3.elements[0], label: "Changed 0", rev: 3, updatedAt: 11_000 },
          local3.elements[1],
          local3.elements[2],
        ],
        boardTitle: local3.boardTitle,
        titleRev: 1,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_peer",
        verifiedSenderPeerId: "p_peer",
      },
      localPeerId: "p_host",
      senderName: "Soren",
      mergeOptions: { authoritativePeerId: "p_host", now: 11_000 },
      now: 11_000,
    });
    expect(r1.decision).toBe("apply");
    if (r1.decision !== "apply") return;
    expect(r1.showRestoreToast).toBe(true);
    expect(r1.recoveryEntry?.snapshot.elements[0].label).toBe("Node 0");

    // Editing a 2nd element within 60s (2/3 = 66.7% > 50%) -> pauses Soren!
    const nextLocal = r1.merged.state;
    const r2 = guard.evaluateIncoming({
      local: nextLocal,
      remote: {
        elements: [
          nextLocal.elements[0],
          { ...nextLocal.elements[1], label: "Changed 1", rev: 3, updatedAt: 12_000 },
          nextLocal.elements[2],
        ],
        boardTitle: nextLocal.boardTitle,
        titleRev: 1,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_peer",
        verifiedSenderPeerId: "p_peer",
      },
      localPeerId: "p_host",
      senderName: "Soren",
      mergeOptions: { authoritativePeerId: "p_host", now: 12_000 },
      now: 12_000,
    });
    expect(r2.decision).toBe("paused");
  });

  it("counts distinct element IDs so dragging 1 node repeatedly does not false-trigger, and expires 60s window cleanly", () => {
    const guard = new RemoteChangeGuard(10_000);
    let current = makeBoard(10);

    // Peer drags el_0 twenty times in 2 seconds -> only 1 distinct ID (10%)
    for (let step = 1; step <= 20; step += 1) {
      const res = guard.evaluateIncoming({
        local: current,
        remote: {
          elements: current.elements.map((el, idx) =>
            idx === 0
              ? { ...el, x: 100 + step * 5, rev: 2 + step, updatedAt: 10_000 + step * 100 }
              : el
          ),
          boardTitle: current.boardTitle,
          titleRev: 1,
          tombstones: {},
          boardEpoch: "bep_test",
          baseRev: 2 + step,
          hasLocalEdits: true,
          senderPeerId: "p_dragger",
          verifiedSenderPeerId: "p_dragger",
        },
        localPeerId: "p_host",
        senderName: "Maya",
        mergeOptions: { authoritativePeerId: "p_host", now: 10_000 + step * 100 },
        now: 10_000 + step * 100,
      });
      expect(res.decision).toBe("apply");
      if (res.decision === "apply") {
        expect(res.showRestoreToast).toBe(false);
        current = res.merged.state;
      }
    }

    // 60s window expiration: 3 edits at t=20s, then 3 different edits at t=85s (>60s later) -> not paused
    const guard2 = new RemoteChangeGuard(10_000);
    let board2 = makeBoard(10);
    const edit3At = (indices: number[], atMs: number, rev: number) =>
      guard2.evaluateIncoming({
        local: board2,
        remote: {
          elements: board2.elements.map((el, idx) =>
            indices.includes(idx)
              ? { ...el, label: `Edit ${atMs} ${idx}`, rev, updatedAt: atMs }
              : el
          ),
          boardTitle: board2.boardTitle,
          titleRev: 1,
          tombstones: {},
          boardEpoch: "bep_test",
          baseRev: rev,
          hasLocalEdits: true,
          senderPeerId: "p_editor",
          verifiedSenderPeerId: "p_editor",
        },
        localPeerId: "p_host",
        senderName: "Nadia",
        mergeOptions: { authoritativePeerId: "p_host", now: atMs },
        now: atMs,
      });

    const first3 = edit3At([0, 1, 2], 20_000, 3);
    expect(first3.decision).toBe("apply");
    if (first3.decision === "apply") board2 = first3.merged.state;

    const next3AfterWindow = edit3At([3, 4, 5], 85_000, 4);
    expect(next3AfterWindow.decision).toBe("apply");
  });

  it("takes a periodic time-based snapshot every 2 minutes only when the board has changed since the last snapshot", () => {
    const guard = new RemoteChangeGuard(10_000);
    const board = makeBoard(5);

    // No changes yet -> no periodic snapshot even after 5 minutes
    expect(guard.maybeTakePeriodicSnapshot(board, 400_000)).toBeNull();

    // Mark a local edit at t=20_000 -> too early at t=100_000 (<120_000ms since lastSnapshotAt=10_000)
    guard.markLocalChange(20_000);
    expect(guard.maybeTakePeriodicSnapshot(board, 100_000)).toBeNull();

    // At t=130_000 (>= 120_000ms since lastSnapshotAt=10_000) -> takes periodic snapshot!
    const snap1 = guard.maybeTakePeriodicSnapshot(board, 130_000);
    expect(snap1).not.toBeNull();
    expect(snap1?.reason).toBe("periodic");
    expect(snap1?.snapshot.elements).toHaveLength(5);

    // No further edits -> no duplicate periodic snapshot at t=300_000
    expect(guard.maybeTakePeriodicSnapshot(board, 300_000)).toBeNull();

    // Another edit at t=310_000 -> periodic snapshot fires at t=310_000 (>=120_000ms since 130_000)
    guard.markLocalChange(310_000);
    const snap2 = guard.maybeTakePeriodicSnapshot(board, 310_000);
    expect(snap2).not.toBeNull();
    expect(snap2?.reason).toBe("periodic");
  });

  it("shows cumulative Restore toast across multiple peers (>30% combined in 60s) without falsely pausing either peer", () => {
    const guard = new RemoteChangeGuard(10_000);
    let current = makeBoard(10);

    // Peer A edits 2 of 10 (20%)
    const rA = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.map((el, i) =>
          i < 2 ? { ...el, label: "A", rev: 3, updatedAt: 11_000 } : el
        ),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_alice",
        verifiedSenderPeerId: "p_alice",
      },
      localPeerId: "p_host",
      senderName: "Alice",
      mergeOptions: { authoritativePeerId: "p_host", now: 11_000 },
      now: 11_000,
    });
    expect(rA.decision).toBe("apply");
    if (rA.decision !== "apply") return;
    expect(rA.showRestoreToast).toBe(false);
    current = rA.merged.state;

    // Peer B edits 2 different elements of 10 (20% individually, 40% combined > 30%)
    const rB = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.map((el, i) =>
          i >= 2 && i < 4 ? { ...el, label: "B", rev: 3, updatedAt: 15_000 } : el
        ),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_bob",
        verifiedSenderPeerId: "p_bob",
      },
      localPeerId: "p_host",
      senderName: "Bob",
      mergeOptions: { authoritativePeerId: "p_host", now: 15_000 },
      now: 15_000,
    });
    expect(rB.decision).toBe("apply");
    if (rB.decision !== "apply") return;
    expect(rB.showRestoreToast).toBe(true);
    expect(rB.recoveryEntry).toBeDefined();
    expect(rB.recoveryEntry?.snapshot.elements[0].label).toBe("Node 0");
  });

  it("does not pause or toast when an unmodified fresh joiner adopts an existing board", () => {
    const guard = new RemoteChangeGuard(10_000);
    const freshLocal: BoardSyncState = {
      ...makeBoard(4, "starter"),
      hasLocalEdits: false,
    };
    const hostBoard = makeBoard(10, "host");

    const res = guard.evaluateIncoming({
      local: freshLocal,
      remote: {
        elements: hostBoard.elements,
        boardTitle: hostBoard.boardTitle,
        titleRev: 2,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 5,
        hasLocalEdits: true,
        senderPeerId: "p_host",
        verifiedSenderPeerId: "p_host",
      },
      localPeerId: "p_fresh",
      senderName: "Host",
      mergeOptions: { authoritativePeerId: "p_host", now: 11_000 },
      now: 11_000,
    });
    expect(res.decision).toBe("apply");
    if (res.decision === "apply") {
      expect(res.showRestoreToast).toBe(false);
      expect(res.merged.adoptedAuthoritative).toBe(true);
    }
  });

  it("pauses two 29% edit batches from the same peer within 60s and preserves authoritativePeerId on Keep replay", () => {
    const guard = new RemoteChangeGuard(10_000);
    let current = makeBoard(100);

    // Batch 1: 29% edits
    const r1 = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.map((el, i) =>
          i < 29 ? { ...el, label: "Batch1", rev: 3, updatedAt: 11_000 } : el
        ),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_vandal_edit",
        verifiedSenderPeerId: "p_vandal_edit",
      },
      localPeerId: "p_host",
      senderName: "Theo",
      mergeOptions: { authoritativePeerId: "p_host", now: 11_000 },
      now: 11_000,
    });
    expect(r1.decision).toBe("apply");
    if (r1.decision !== "apply") return;
    current = r1.merged.state;

    // Batch 2: another 29 distinct elements edited (cumulative 58% > 50% within 60s!) -> PAUSED
    const batch2Ids = new Set(
      Array.from({ length: 29 }, (_, idx) => `el_${29 + idx}`)
    );
    const r2 = guard.evaluateIncoming({
      local: current,
      remote: {
        elements: current.elements.map((el) =>
          batch2Ids.has(el.id)
            ? { ...el, label: "Batch2", rev: 3, updatedAt: 20_000 }
            : el
        ),
        boardTitle: current.boardTitle,
        titleRev: 1,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        hasLocalEdits: true,
        senderPeerId: "p_vandal_edit",
        verifiedSenderPeerId: "p_vandal_edit",
      },
      localPeerId: "p_host",
      senderName: "Theo",
      mergeOptions: { authoritativePeerId: "p_host", now: 20_000 },
      now: 20_000,
    });
    expect(r2.decision).toBe("paused");
    if (r2.decision !== "paused") return;
    expect(r2.incident.peerName).toBe("Theo");
    expect(r2.incident.changedCount).toBe(58);
    expect(r2.recoveryEntry?.snapshot.elements[0].label).toBe("Node 0");

    // Authoritative fullResync replace >50% also pauses, and Keep preserves authoritativePeerId for replay
    const guardAuth = new RemoteChangeGuard(10_000);
    const local10 = makeBoard(10);
    const authWipe = guardAuth.evaluateIncoming({
      local: local10,
      remote: {
        elements: [],
        boardTitle: "Blank",
        titleRev: 2,
        tombstones: {},
        boardEpoch: "bep_test",
        baseRev: 3,
        fullResync: true,
        hasLocalEdits: true,
        senderPeerId: "p_host",
        verifiedSenderPeerId: "p_host",
      },
      localPeerId: "p_peer",
      senderName: "Host",
      mergeOptions: { authoritativePeerId: "p_host", now: 12_000 },
      now: 12_000,
    });
    expect(authWipe.decision).toBe("paused");
    const keepRes = guardAuth.resolvePeerIncident("p_host", "keep", 13_000);
    expect(keepRes?.action).toBe("keep");
    if (keepRes?.action === "keep") {
      expect(keepRes.entriesToApply[0]?.authoritativePeerId).toBe("p_host");
    }
  });
});
