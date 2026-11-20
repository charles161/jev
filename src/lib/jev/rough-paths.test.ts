import { describe, expect, it } from "vitest";
import {
  computeArrowHeadPath,
  generateArrowPath,
  generateShapePaths,
  smoothFreedrawPath,
} from "@/lib/jev/rough-paths";
import type { ElementKind, JevElement } from "@/lib/jev/types";

function makeEl(kind: ElementKind, overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: "el_test",
    kind,
    x: 0,
    y: 0,
    width: overrides.width ?? 160,
    height: overrides.height ?? 80,
    label: "Test",
    tone: "ink",
    seed: overrides.seed ?? 12345,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("rough-paths SVG generators", () => {
  const shapeKinds: ElementKind[] = [
    "node",
    "frame",
    "diamond",
    "ellipse",
    "database",
  ];

  it("generates clean and ghost SVG paths for all supported shape kinds and empty for non-shapes", () => {
    for (const kind of shapeKinds) {
      const cleanPaths = generateShapePaths(
        makeEl(kind),
        "#111111",
        "#ffffff",
        "clean",
        false
      );
      expect(cleanPaths.length).toBeGreaterThanOrEqual(1);
      for (const p of cleanPaths) {
        expect(p.d.length).toBeGreaterThan(0);
        expect(p.d).not.toContain("NaN");
      }

      // Ghost overrides sketch style to produce crisp deterministic paths
      const ghostPaths = generateShapePaths(
        makeEl(kind),
        "#111111",
        "#ffffff",
        "sketch",
        true
      );
      expect(ghostPaths).toHaveLength(cleanPaths.length);
    }

    for (const unsupported of ["text", "arrow", "freedraw"] as ElementKind[]) {
      expect(
        generateShapePaths(makeEl(unsupported), "#111", "#fff", "clean")
      ).toEqual([]);
      expect(
        generateShapePaths(makeEl(unsupported), "#111", "#fff", "sketch")
      ).toEqual([]);
    }
  });

  it("generates deterministic roughjs sketch paths per seed and clamps degenerate dimensions", () => {
    for (const kind of shapeKinds) {
      const el = makeEl(kind, { seed: 777, width: 0, height: -10 });
      const first = generateShapePaths(el, "#1F232B", "#FFFDF8", "sketch");
      const second = generateShapePaths(el, "#1F232B", "#FFFDF8", "sketch");
      expect(first.length).toBeGreaterThanOrEqual(1);
      expect(first).toEqual(second);
      for (const p of first) {
        expect(p.d).not.toContain("NaN");
      }
    }
  });

  it("generates clean, ghost, solid sketch, and dashed sketch arrow paths", () => {
    const start = { x: 0, y: 0 };
    const control = { x: 100, y: 30 };
    const end = { x: 200, y: 0 };

    const clean = generateArrowPath(start, control, end, 42, "#000", "clean");
    expect(clean).toEqual([
      {
        d: "M 0 0 Q 100 30 200 0",
        stroke: "#000",
        strokeWidth: 1.35,
        fill: "none",
      },
    ]);

    const ghost = generateArrowPath(
      start,
      control,
      end,
      42,
      "#000",
      "sketch",
      false,
      true
    );
    expect(ghost[0].strokeWidth).toBe(1.5);

    const sketchSolid = generateArrowPath(
      start,
      control,
      end,
      42,
      "#000",
      "sketch",
      false
    );
    const sketchSolidRepeat = generateArrowPath(
      start,
      control,
      end,
      42,
      "#000",
      "sketch",
      false
    );
    expect(sketchSolid).toEqual(sketchSolidRepeat);
    expect(sketchSolid.length).toBeGreaterThanOrEqual(1);

    const sketchDashed = generateArrowPath(
      start,
      control,
      end,
      42,
      "#000",
      "sketch",
      true
    );
    expect(sketchDashed.length).toBeGreaterThanOrEqual(1);
    expect(sketchDashed[0].d).not.toContain("NaN");
  });

  it("computes arrowhead SVG chevron paths including degenerate coincident endpoints", () => {
    const rightHead = computeArrowHeadPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(rightHead).toMatch(/^M [\d.-]+ [\d.-]+ L 100\.0 0\.0 L [\d.-]+ [\d.-]+$/);
    expect(rightHead).not.toContain("NaN");

    // Degenerate zero-length vector must remain finite
    const zeroHead = computeArrowHeadPath({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(zeroHead).not.toContain("NaN");
    expect(zeroHead).toContain("L 50.0 50.0");
  });

  it("smooths freedraw strokes for empty, single-point, two-point, and multi-point paths", () => {
    expect(smoothFreedrawPath([])).toBe("");
    expect(smoothFreedrawPath([{ x: 10, y: 20 }])).toBe("M 10 20 L 10.1 20.1");
    expect(
      smoothFreedrawPath([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ])
    ).toBe("M 0.0 0.0 L 10.0 20.0");

    const smooth = smoothFreedrawPath([
      { x: -10, y: -20 },
      { x: 0, y: 10 },
      { x: 20, y: 30 },
      { x: 40, y: 15 },
    ]);
    expect(smooth).toContain("M -10.0 -20.0");
    expect(smooth).toContain("Q 0.0 10.0 10.0 20.0");
    expect(smooth).toContain("L 40.0 15.0");
    expect(smooth).not.toContain("NaN");
  });
});
