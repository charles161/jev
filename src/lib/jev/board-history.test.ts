import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevElement } from "@/lib/jev/types";
import {
  BoardHistoryController,
  BroadcastThrottler,
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
