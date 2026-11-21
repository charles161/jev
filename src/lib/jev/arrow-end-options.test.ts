import { describe, expect, it } from "vitest";
import {
  ARROW_END_GROUPS,
  ARROW_END_LABELS,
  arrowEndPatch,
  bidirectionalTogglePatch,
  isBidirectional,
} from "@/lib/jev/arrow-end-options";
import { resolveArrowEnds } from "@/lib/jev/notation-kinds";
import { ARROW_ENDS, type JevElement } from "@/lib/jev/types";

function arrow(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: "a1",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "",
    tone: "ink",
    seed: 1,
    createdAt: 0,
    updatedAt: 0,
    fromId: "n1",
    toId: "n2",
    ...overrides,
  };
}

describe("arrow end options", () => {
  it("lists every contract end exactly once, grouped heads / UML / crow's foot", () => {
    const listed = ARROW_END_GROUPS.flatMap((g) => g.ends);
    expect([...listed].sort()).toEqual([...ARROW_ENDS].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(ARROW_END_GROUPS.map((g) => g.title)).toEqual(["Heads", "UML", "Crow's foot"]);
  });

  it("gives every end a readable name", () => {
    for (const end of ARROW_ENDS) expect(ARROW_END_LABELS[end]).toMatch(/^[A-Z]/);
    expect(ARROW_END_LABELS.er_zero_many).toBe("Zero or many");
    expect(ARROW_END_LABELS.er_only_one).toBe("Only one");
  });
});

describe("arrowEndPatch writes explicit ends", () => {
  it("materialises the other end from the legacy defaults so nothing else changes", () => {
    expect(arrowEndPatch(arrow(), "start", "er_only_one")).toEqual({ startEnd: "er_only_one", endEnd: "arrow" });
    expect(arrowEndPatch(arrow({ bidirectional: true }), "end", "er_zero_many")).toEqual({
      startEnd: "arrow",
      endEnd: "er_zero_many",
    });
  });

  it("keeps an existing explicit end on the other side", () => {
    expect(arrowEndPatch(arrow({ startEnd: "diamond", endEnd: "none" }), "end", "open")).toEqual({
      startEnd: "diamond",
      endEnd: "open",
    });
  });

  it("produces ends the renderer resolves to exactly what was picked", () => {
    const el = arrow();
    const next = { ...el, ...arrowEndPatch(el, "start", "er_one_many") };
    expect(resolveArrowEnds(next)).toEqual({ start: "er_one_many", end: "arrow" });
  });
});

describe("bidirectional toggle stays truthful with explicit ends", () => {
  it("reads bidirectional from the resolved start end", () => {
    expect(isBidirectional(arrow())).toBe(false);
    expect(isBidirectional(arrow({ bidirectional: true }))).toBe(true);
    expect(isBidirectional(arrow({ startEnd: "er_many" }))).toBe(true);
    expect(isBidirectional(arrow({ bidirectional: true, startEnd: "none" }))).toBe(false);
  });

  it("toggling on adds a head at the start; toggling off removes the start marker", () => {
    expect(bidirectionalTogglePatch(arrow())).toEqual({ bidirectional: true, startEnd: "arrow" });
    expect(bidirectionalTogglePatch(arrow({ startEnd: "er_many", endEnd: "er_one" }))).toEqual({
      bidirectional: false,
      startEnd: "none",
    });
  });
});
