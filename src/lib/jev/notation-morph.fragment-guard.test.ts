import { describe, expect, it } from "vitest";
import { makeSeed } from "./geometry";
import { morphSelectionToNotation } from "./notation-morph";
import { fragmentLayout } from "./shape-layout";
import type { JevElement, MorphSemanticSpec } from "./types";

const MONO_11 = 6.6;

function node(id: string, x: number): JevElement {
  return {
    id,
    kind: "node",
    x,
    y: 0,
    width: 160,
    height: 72,
    label: id,
    tone: "ink",
    seed: makeSeed(id),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("sequence fragment guards", () => {
  it("the operator tag and every guard clear the activation bars beside them", () => {
    const sketch = ["Client", "LB", "Redirect", "Redis", "DB"].map((id, i) =>
      node(id, i * 240),
    );
    const spec: MorphSemanticSpec = {
      summary: "redirect",
      actors: sketch.map((s, i) => ({ id: `sem_${i}`, label: s.label })),
      messages: [
        { id: "m1", from: "sem_0", to: "sem_1", label: "GET", order: 1 },
        { id: "m2", from: "sem_1", to: "sem_2", label: "GET", order: 2 },
        { id: "m3", from: "sem_2", to: "sem_3", label: "GET url", order: 3 },
        {
          id: "m4",
          from: "sem_3",
          to: "sem_2",
          label: "url",
          order: 4,
          isReturn: true,
        },
        { id: "m5", from: "sem_2", to: "sem_4", label: "SELECT", order: 5 },
        {
          id: "m6",
          from: "sem_4",
          to: "sem_2",
          label: "url",
          order: 6,
          isReturn: true,
        },
        {
          id: "m7",
          from: "sem_2",
          to: "sem_1",
          label: "302",
          order: 7,
          isReturn: true,
        },
        {
          id: "m8",
          from: "sem_1",
          to: "sem_0",
          label: "302",
          order: 8,
          isReturn: true,
        },
      ],
      fragments: [
        {
          id: "f1",
          operator: "alt",
          guard: "cache hit",
          fromOrder: 4,
          toOrder: 6,
          elseFromOrder: 5,
          elseGuard: "miss",
        },
      ],
      steps: [],
      states: [],
      transitions: [],
      entities: [],
      relations: [],
    };
    expectHeadersClear(sketch, spec);
  });

  it("a header that would land on a caller's long activation bar moves left past it", () => {
    const sketch = ["Client", "Payments", "PSP"].map((id, i) =>
      node(id, i * 240),
    );
    const spec: MorphSemanticSpec = {
      summary: "charge",
      actors: sketch.map((s, i) => ({ id: `sem_${i}`, label: s.label })),
      messages: [
        { id: "m1", from: "sem_0", to: "sem_1", label: "POST", order: 1 },
        { id: "m2", from: "sem_1", to: "sem_2", label: "authorize", order: 2 },
        {
          id: "m3",
          from: "sem_2",
          to: "sem_1",
          label: "approved",
          order: 3,
          isReturn: true,
        },
        {
          id: "m4",
          from: "sem_1",
          to: "sem_0",
          label: "201",
          order: 4,
          isReturn: true,
        },
      ],
      fragments: [
        {
          id: "f1",
          operator: "loop",
          guard: "timeout: retry ≤3, same key",
          fromOrder: 2,
          toOrder: 3,
        },
      ],
      steps: [],
      states: [],
      transitions: [],
      entities: [],
      relations: [],
    };
    expectHeadersClear(sketch, spec);
  });
});

function expectHeadersClear(sketch: JevElement[], spec: MorphSemanticSpec) {
  const morph = morphSelectionToNotation(
    sketch.map((s) => s.id),
    sketch,
    "sequence",
    { specOverride: spec, now: 1 },
  )!;
  const frag = morph.addedElements.find((e) => e.kind === "fragment")!;
  const layout = fragmentLayout(frag);
  layout.operands.forEach((op, i) => {
    const x1 = frag.x;
    const x2 =
      x1 + (i === 0 ? layout.tagWidth + 8 : 10) + op.guard.length * MONO_11;
    const y1 = frag.y + op.top;
    const y2 = y1 + 20;
    for (const bar of morph.addedElements.filter(
      (e) => e.kind === "activation",
    )) {
      const clear =
        x2 <= bar.x ||
        bar.x + bar.width <= x1 ||
        y2 <= bar.y ||
        bar.y + bar.height <= y1;
      expect(
        clear,
        `guard ${op.guard} runs into an activation bar at x=${bar.x}`,
      ).toBe(true);
    }
  });
}
