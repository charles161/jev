import { describe, expect, it } from "vitest";
import { parsePromptToElements } from "@/lib/jev/diagram-parser";
import { getElementRect, isShapeElement, rectsOverlap } from "@/lib/jev/geometry";
import {
  createForkArchitectureStarterElements,
  createRequestFlowStarterElements,
  createStarterElements,
  PROMPT_SPARKS,
} from "@/lib/jev/templates";

describe("templates (starter elements & prompt sparks)", () => {
  it("creates deterministic, non-overlapping starter elements with valid arrow bindings", () => {
    const first = createStarterElements();
    const second = createStarterElements();
    expect(first).toEqual(second);

    const shapes = first.filter(isShapeElement);
    const arrows = first.filter((e) => e.kind === "arrow");
    expect(shapes).toHaveLength(3);
    expect(arrows).toHaveLength(2);

    const ids = new Set(shapes.map((s) => s.id));
    for (const arrow of arrows) {
      expect(ids.has(arrow.fromId!)).toBe(true);
      expect(ids.has(arrow.toId!)).toBe(true);
    }

    // Starter shapes should not overlap each other
    for (let i = 0; i < shapes.length; i += 1) {
      for (let j = i + 1; j < shapes.length; j += 1) {
        expect(
          rectsOverlap(getElementRect(shapes[i]), getElementRect(shapes[j]), 0)
        ).toBe(false);
      }
    }
  });

  it("parses every PROMPT_SPARK cleanly into a valid multi-node diagram", () => {
    expect(PROMPT_SPARKS.length).toBeGreaterThanOrEqual(4);

    for (const spark of PROMPT_SPARKS) {
      expect(spark.label.trim().length).toBeGreaterThan(0);
      const result = parsePromptToElements(spark.prompt, []);
      const shapes = result.elements.filter(
        (e) => e.kind !== "arrow" && e.kind !== "frame"
      );
      const arrows = result.elements.filter((e) => e.kind === "arrow");

      expect(result.summary.length).toBeGreaterThan(0);
      expect(shapes.length).toBeGreaterThanOrEqual(2);
      expect(arrows.length).toBeGreaterThanOrEqual(1);

      const idSet = new Set(shapes.map((s) => s.id));
      for (const arrow of arrows) {
        expect(idSet.has(arrow.fromId!)).toBe(true);
        expect(idSet.has(arrow.toId!)).toBe(true);
      }
    }
  });

  it("creates non-overlapping request-flow and fork-architecture starter templates with valid arrow bindings", () => {
    for (const elements of [
      createRequestFlowStarterElements(),
      createForkArchitectureStarterElements(),
    ]) {
      const shapes = elements.filter(isShapeElement);
      const arrows = elements.filter((e) => e.kind === "arrow");
      expect(shapes.length).toBeGreaterThanOrEqual(3);
      expect(arrows.length).toBeGreaterThanOrEqual(2);

      const ids = new Set(shapes.map((s) => s.id));
      for (const arrow of arrows) {
        expect(ids.has(arrow.fromId!)).toBe(true);
        expect(ids.has(arrow.toId!)).toBe(true);
      }
      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          expect(
            rectsOverlap(getElementRect(shapes[i]), getElementRect(shapes[j]), 0)
          ).toBe(false);
        }
      }
    }
  });
});
