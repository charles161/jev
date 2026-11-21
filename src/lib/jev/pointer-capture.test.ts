import { describe, expect, it } from "vitest";
import { pointerCaptureTiming, shouldCaptureOnMove } from "./pointer-capture";

describe("pointer capture timing", () => {
  it("select-tool gestures capture only after the pointer moves, so a double-click still reaches the element", () => {
    expect(pointerCaptureTiming("move")).toBe("move");
    expect(pointerCaptureTiming("marquee")).toBe("move");
  });

  it("tool gestures and handles capture on pointerdown", () => {
    for (const mode of ["pan", "resize", "connect", "draw_shape", "freedraw"] as const) {
      expect(pointerCaptureTiming(mode)).toBe("down");
    }
  });

  it("captures on the first move with the primary button held, once", () => {
    expect(shouldCaptureOnMove("move", 1, false)).toBe(true);
    expect(shouldCaptureOnMove("marquee", 1, false)).toBe(true);
    expect(shouldCaptureOnMove("move", 1, true)).toBe(false);
    expect(shouldCaptureOnMove("move", 0, false)).toBe(false);
    expect(shouldCaptureOnMove("connect", 1, false)).toBe(false);
    expect(shouldCaptureOnMove(null, 1, false)).toBe(false);
  });
});
