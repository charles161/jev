import { describe, expect, it } from "vitest";
import {
  computeSmartPopoverPlacement,
  getElementScreenRect,
} from "@/lib/jev/popover-placement";
import type { JevElement, Viewport } from "@/lib/jev/types";

function makeEl(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: overrides.id ?? "el_1",
    kind: overrides.kind ?? "node",
    x: overrides.x ?? 200,
    y: overrides.y ?? 200,
    width: overrides.width ?? 160,
    height: overrides.height ?? 72,
    label: overrides.label ?? "Service",
    tone: overrides.tone ?? "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("popover-placement", () => {
  it("computes screen rects for shapes, arrows, and freedraw strokes with zoom and minimum clamps", () => {
    const vp: Viewport = { x: 100, y: 50, zoom: 0.5 };
    const tiny = makeEl({ id: "tiny", x: 20, y: 40, width: 10, height: 10 });
    const map = new Map([[tiny.id, tiny]]);

    // Zoomed-out tiny shape clamps to minimum 28x24
    expect(getElementScreenRect(tiny, map, vp)).toEqual({
      x: 110,
      y: 70,
      width: 28,
      height: 24,
    });

    // Arrow centers a 40x32 screen box at the quadratic midpoint
    const a = makeEl({ id: "a", x: 0, y: 0, width: 100, height: 60 });
    const b = makeEl({ id: "b", x: 300, y: 0, width: 100, height: 60 });
    const arr = makeEl({
      id: "arr",
      kind: "arrow",
      fromId: "a",
      toId: "b",
      arrowStyle: "straight",
    });
    const arrMap = new Map([
      [a.id, a],
      [b.id, b],
      [arr.id, arr],
    ]);
    const arrRect = getElementScreenRect(arr, arrMap, { x: 0, y: 0, zoom: 1 });
    expect(arrRect).toEqual({ x: 180, y: 14, width: 40, height: 32 });

    // Freedraw with points computes tight bounding box in screen space
    const stroke = makeEl({
      id: "fd",
      kind: "freedraw",
      points: [
        { x: 10, y: 20 },
        { x: 110, y: 120 },
      ],
    });
    expect(
      getElementScreenRect(stroke, new Map([[stroke.id, stroke]]), {
        x: 50,
        y: 25,
        zoom: 2,
      })
    ).toEqual({
      x: 70,
      y: 65,
      width: 200,
      height: 200,
    });

    // Degenerate empty-points freedraw falls back cleanly
    const emptyStroke = makeEl({
      id: "fd0",
      kind: "freedraw",
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      points: [],
    });
    expect(
      getElementScreenRect(emptyStroke, new Map(), { x: 0, y: 0, zoom: 1 })
    ).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 40,
    });
  });

  it("places unobstructed slim toolbar above target and flips below when target is near the top toolbar", () => {
    const centerNode = makeEl({ id: "n1", x: 500, y: 350, width: 160, height: 72 });
    const normal = computeSmartPopoverPlacement({
      element: centerNode,
      allElements: [centerNode],
      ghostElements: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      screenWidth: 1280,
      screenHeight: 800,
      popoverWidth: 280,
      popoverHeight: 44,
      hasPredictionHud: false,
    });
    expect(normal.side).toBe("top");
    expect(normal.y + 44).toBeLessThanOrEqual(centerNode.y);

    // Near top bar -> should flip below the element rather than colliding with top safe margin or self
    const topNode = makeEl({ id: "n2", x: 500, y: 80, width: 160, height: 72 });
    const flipped = computeSmartPopoverPlacement({
      element: topNode,
      allElements: [topNode],
      ghostElements: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      screenWidth: 1280,
      screenHeight: 800,
      popoverWidth: 280,
      popoverHeight: 44,
      hasPredictionHud: false,
    });
    expect(flipped.side).toBe("bottom");
    expect(flipped.y).toBeGreaterThanOrEqual(topNode.y + topNode.height);
  });

  it("avoids neighboring shapes and active ghost elements when placing popover", () => {
    const target = makeEl({ id: "t", x: 500, y: 320, width: 160, height: 72 });
    // Put a neighbor directly above `target` where "top" would normally go
    const aboveObstacle = makeEl({
      id: "obs",
      x: 440,
      y: 230,
      width: 280,
      height: 75,
    });

    const placement = computeSmartPopoverPlacement({
      element: target,
      allElements: [target, aboveObstacle],
      ghostElements: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      screenWidth: 1280,
      screenHeight: 800,
      popoverWidth: 260,
      popoverHeight: 44,
      hasPredictionHud: false,
    });
    expect(placement.side).toBe("bottom");

    // Also block bottom with a ghost preview -> should move to right or left
    const bottomGhost = makeEl({
      id: "ghost",
      x: 440,
      y: 405,
      width: 280,
      height: 75,
    });
    const sidePlacement = computeSmartPopoverPlacement({
      element: target,
      allElements: [target, aboveObstacle],
      ghostElements: [bottomGhost],
      viewport: { x: 0, y: 0, zoom: 1 },
      screenWidth: 1280,
      screenHeight: 800,
      popoverWidth: 260,
      popoverHeight: 44,
      hasPredictionHud: false,
    });
    expect(["right", "left"]).toContain(sidePlacement.side);
  });

  it("always clamps within safe viewport bounds across HUD states, frames, and extreme off-screen coordinates", () => {
    const frame = makeEl({
      id: "frm",
      kind: "frame",
      x: 200,
      y: 200,
      width: 600,
      height: 400,
    });
    const framePlace = computeSmartPopoverPlacement({
      element: frame,
      allElements: [frame],
      ghostElements: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      screenWidth: 1200,
      screenHeight: 800,
      popoverWidth: 240,
      popoverHeight: 44,
      hasPredictionHud: true,
    });
    expect(framePlace.x).toBeGreaterThanOrEqual(14);
    expect(framePlace.x).toBeLessThanOrEqual(1200 - 14 - 240);
    expect(framePlace.y).toBeGreaterThanOrEqual(76);
    expect(framePlace.y).toBeLessThanOrEqual(800 - 216 - 44);

    // Extreme off-screen coordinates still clamp cleanly inside safe viewport
    const extreme = makeEl({ id: "ex", x: 999999, y: 999999, width: 160, height: 72 });
    const clamped = computeSmartPopoverPlacement({
      element: extreme,
      allElements: [extreme],
      ghostElements: [],
      viewport: { x: 0, y: 0, zoom: 3 },
      screenWidth: 360,
      screenHeight: 640,
      popoverWidth: 260,
      popoverHeight: 44,
      hasPredictionHud: true,
    });
    expect(clamped.x).toBeGreaterThanOrEqual(14);
    expect(clamped.x).toBeLessThanOrEqual(360 - 14 - 260);
    expect(clamped.y).toBeGreaterThanOrEqual(76);
    expect(clamped.y).toBeLessThanOrEqual(640 - 216 - 44);
  });
});
