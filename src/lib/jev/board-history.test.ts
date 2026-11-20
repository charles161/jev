import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevElement } from "@/lib/jev/types";
import {
  BoardHistoryController,
  BroadcastThrottler,
  resolvePointerCancelDecision,
} from "@/lib/jev/board-history";

function makeBox(id: string, x: number, y: number): JevElement {
  return {
    id,
    kind: "node",
    x,
    y,
    width: 160,
    height: 70,
    label: "Box",
    tone: "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 1,
  };
}

describe("Blocker 6: pre-drag undo capture, remote sync undo safety & broadcast throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures pre-drag snapshot before mutation so Undo restores original pre-drag position", () => {
    const initial = [makeBox("box_1", 100, 200)];
    const history = new BoardHistoryController(initial);

    // 1. Capture pre-drag snapshot on pointerdown
    const preDragSnapshot = history.snapshotForDrag();

    // 2. Multiple pointermove mutations (recordUndo: false)
    history.commitLocal([makeBox("box_1", 150, 220)], { recordUndo: false });
    history.commitLocal([makeBox("box_1", 210, 260)], { recordUndo: false });
    history.commitLocal([makeBox("box_1", 320, 340)], { recordUndo: false });
    expect(history.undoCount).toBe(0);

    // 3. pointerup commits with preDragSnapshot
    history.commitLocal([makeBox("box_1", 320, 340)], {
      recordUndo: true,
      undoSnapshot: preDragSnapshot,
    });
    expect(history.undoCount).toBe(1);
    expect(history.current[0].x).toBe(320);

    // 4. Undo restores exact original pre-drag position (100, 200)!
    const undone = history.undo();
    expect(undone).not.toBeNull();
    expect(undone![0].x).toBe(100);
    expect(undone![0].y).toBe(200);
    expect(history.redoCount).toBe(1);

    // 5. Redo reapplies (320, 340)
    const redone = history.redo();
    expect(redone).not.toBeNull();
    expect(redone![0].x).toBe(320);
    expect(redone![0].y).toBe(340);
  });

  it("clears undo/redo stacks when authoritative remote edits arrive so Undo never clobbers a peer", () => {
    const history = new BoardHistoryController([makeBox("box_1", 100, 100)]);
    history.commitLocal([makeBox("box_1", 200, 100)], { recordUndo: true });
    expect(history.undoCount).toBe(1);

    // Remote peer adds box_2 -> local undo/redo must clear
    history.applyRemote([
      makeBox("box_1", 200, 100),
      makeBox("box_2", 400, 100),
    ]);
    expect(history.undoCount).toBe(0);
    expect(history.redoCount).toBe(0);
    expect(history.undo()).toBeNull();
    expect(history.current.map((e) => e.id)).toEqual(["box_1", "box_2"]);
  });

  it("throttles 60Hz drag broadcasts to ~60ms intervals and guarantees final flush on pointerup", () => {
    const sent: Array<{ x: number }> = [];
    const throttler = new BroadcastThrottler<{ x: number }>(
      (payload) => sent.push(payload),
      60
    );

    // Simulate 10 frames at ~16ms (60Hz) = 160ms total
    for (let frame = 0; frame < 10; frame += 1) {
      throttler.schedule({ x: frame * 10 });
      vi.advanceTimersByTime(16);
    }

    // Far fewer than 10 full-board broadcasts
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(4);

    // Final pointerup flushes exact final position immediately
    throttler.flushNow({ x: 999 });
    expect(sent[sent.length - 1]).toEqual({ x: 999 });

    // No stray delayed timer fires after flushNow
    const countAfterFlush = sent.length;
    vi.advanceTimersByTime(200);
    expect(sent.length).toBe(countAfterFlush);
  });
});

describe("Fix 6: mid-drag remote sync undo race & pointercancel handling", () => {
  it("tracks monotonic remoteSyncGeneration and drops stale pre-drag undo snapshot on pointerup if a remote sync arrived mid-drag", () => {
    const box1 = makeBox("box_1", 100, 100);
    const history = new BoardHistoryController([box1]);
    expect(history.remoteSyncGeneration).toBe(0);

    // 1. pointerdown captures pre-drag snapshot + remoteSyncGeneration
    const preDragSnapshot = history.snapshotForDrag();
    const dragStartGeneration = history.remoteSyncGeneration;

    // 2. pointermove mutates locally
    history.commitLocal([makeBox("box_1", 180, 100)], { recordUndo: false });

    // 3. Remote peer adds box_2 mid-drag -> remoteSyncGeneration increments & undo stack clears
    const peerBox2 = makeBox("box_2", 420, 200);
    history.applyRemote([makeBox("box_1", 180, 100), peerBox2]);
    expect(history.remoteSyncGeneration).toBe(1);
    expect(history.undoCount).toBe(0);

    // 4. pointerup fires with stale preDragSnapshot + dragStartGeneration=0
    history.commitLocal([makeBox("box_1", 260, 100), peerBox2], {
      recordUndo: true,
      undoSnapshot: preDragSnapshot,
      expectedRemoteSyncGeneration: dragStartGeneration,
    });

    // Stale pre-drag snapshot MUST have been dropped so Undo cannot wipe peerBox2!
    expect(history.undoCount).toBe(0);
    expect(history.undo()).toBeNull();
    expect(history.current.map((e) => e.id)).toEqual(["box_1", "box_2"]);

    // 5. Next drag with NO remote sync records undo normally
    const cleanSnapshot = history.snapshotForDrag();
    const cleanGen = history.remoteSyncGeneration;
    history.commitLocal([makeBox("box_1", 300, 100), peerBox2], {
      recordUndo: true,
      undoSnapshot: cleanSnapshot,
      expectedRemoteSyncGeneration: cleanGen,
    });
    expect(history.undoCount).toBe(1);
    expect(history.undo()!.map((e) => e.id)).toEqual(["box_1", "box_2"]);
  });

  it("handles pointercancel safely: restores pre-drag only when no remote sync occurred, and discards drafts without corrupting history", () => {
    // Move cancelled with no remote sync -> restore pre-drag positions cleanly (no undo push)
    expect(
      resolvePointerCancelDecision({
        mode: "move",
        movedEnough: true,
        hasPreDragElements: true,
        dragStartSyncGeneration: 2,
        currentSyncGeneration: 2,
      })
    ).toEqual({ shouldRestorePreDrag: true });

    // Move cancelled AFTER a mid-drag remote sync -> MUST NOT restore stale pre-drag snapshot
    expect(
      resolvePointerCancelDecision({
        mode: "move",
        movedEnough: true,
        hasPreDragElements: true,
        dragStartSyncGeneration: 2,
        currentSyncGeneration: 3,
      })
    ).toEqual({ shouldRestorePreDrag: false });

    // Resize cancelled with no remote sync -> restore pre-drag
    expect(
      resolvePointerCancelDecision({
        mode: "resize",
        movedEnough: true,
        hasPreDragElements: true,
        dragStartSyncGeneration: 0,
        currentSyncGeneration: 0,
      })
    ).toEqual({ shouldRestorePreDrag: true });

    // Freedraw / draw_shape / connect / marquee / pan -> just discard draft state
    for (const mode of ["freedraw", "draw_shape", "connect", "marquee", "pan"] as const) {
      expect(
        resolvePointerCancelDecision({
          mode,
          movedEnough: true,
          hasPreDragElements: false,
          dragStartSyncGeneration: 0,
          currentSyncGeneration: 0,
        })
      ).toEqual({ shouldRestorePreDrag: false });
    }
  });
});
