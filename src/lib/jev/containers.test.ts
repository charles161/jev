import { describe, expect, it } from "vitest";
import { findFreeSpot } from "./geometry";
import { strokeUnit } from "./stroke-recognition";
import type { ElementKind, JevElement } from "./types";

function el(id: string, kind: ElementKind, x: number, y: number, width: number, height: number): JevElement {
  return { id, kind, x, y, width, height, label: id, tone: "ink", seed: 1, createdAt: 0, updatedAt: 0 };
}

describe("container kinds (zone, fragment) behave like frames", () => {
  it("findFreeSpot does not treat a zone or fragment as an obstacle", () => {
    const preferred = { x: 100, y: 100, width: 160, height: 64 };
    for (const kind of ["frame", "zone", "fragment"] as const) {
      expect(findFreeSpot(preferred, [el("z", kind, 0, 0, 600, 400)])).toEqual(preferred);
    }
  });
});

describe("pen strokes see the new shape kinds", () => {
  it("strokeUnit measures queues and caches like boxes", () => {
    const asNodes = strokeUnit([el("a", "node", 0, 0, 200, 60), el("b", "node", 300, 0, 200, 60)]);
    const asNew = strokeUnit([el("a", "queue", 0, 0, 200, 60), el("b", "cache", 300, 0, 200, 60)]);
    expect(asNew).toBe(asNodes);
  });
});
