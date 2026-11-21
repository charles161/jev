import { describe, expect, it } from "vitest";
import { duplicateElements } from "@/lib/jev/duplicate";
import type { JevElement } from "@/lib/jev/types";

const base = { tone: "ink" as const, seed: 1, createdAt: 1, updatedAt: 1, label: "" };
const A: JevElement = { ...base, id: "A", kind: "node", x: 0, y: 0, width: 100, height: 60, label: "A" };
const B: JevElement = { ...base, id: "B", kind: "node", x: 300, y: 0, width: 100, height: 60, label: "B" };
const AB: JevElement = { ...base, id: "AB", kind: "arrow", x: 0, y: 0, width: 0, height: 0, fromId: "A", toId: "B" };
const free: JevElement = { ...base, id: "F", kind: "arrow", x: 0, y: 0, width: 0, height: 0, fromPoint: { x: 1, y: 2 }, toPoint: { x: 3, y: 4 } };
const ink: JevElement = { ...base, id: "I", kind: "freedraw", x: 5, y: 5, width: 0, height: 0, points: [{ x: 5, y: 5 }, { x: 9, y: 9 }] };

let n = 0;
const makeId = () => `c${++n}`;

describe("duplicateElements (Ctrl+D)", () => {
  it("arrows inside the selection rebind to the clones", () => {
    n = 0;
    const out = duplicateElements([A, B, AB], makeId, { x: 42, y: 42 }, 9);
    const [a2, b2, ab2] = out;
    expect(a2).toMatchObject({ id: "c1", x: 42, y: 42, createdAt: 9 });
    expect(b2).toMatchObject({ id: "c2", x: 342 });
    expect(ab2).toMatchObject({ id: "c3", fromId: "c1", toId: "c2" });
  });

  it("an arrow duplicated alone keeps its original endpoints", () => {
    n = 0;
    expect(duplicateElements([AB], makeId, { x: 42, y: 42 }, 9)[0]).toMatchObject({ fromId: "A", toId: "B" });
  });

  it("free arrow points and ink points shift by the offset; ids are unique", () => {
    n = 0;
    const out = duplicateElements([free, ink], makeId, { x: 10, y: 20 }, 9);
    expect(out[0].fromPoint).toEqual({ x: 11, y: 22 });
    expect(out[0].toPoint).toEqual({ x: 13, y: 24 });
    expect(out[1].points).toEqual([{ x: 15, y: 25 }, { x: 19, y: 29 }]);
    expect(new Set(out.map((e) => e.id)).size).toBe(2);
  });
});
