// SD Sensei, 21 Nov: suggestions read the shape, not the label ("Postgres DB" offered next to "URL DB"),
// and tried to link text notes as if they were components.
import { describe, expect, it } from "vitest";
import { buildNextOptions } from "@/lib/jev/next-options";
import { generateCandidatePool } from "@/lib/jev/prediction-engine";
import type { JevElement, SpatialIntent } from "@/lib/jev/types";

const el = (o: Partial<JevElement> & { id: string; label: string }): JevElement => ({
  kind: "node", x: 100, y: 100, width: 172, height: 72, tone: "cobalt", seed: 1, createdAt: 1, updatedAt: 1, ...o,
});
const note = el({ id: "n", kind: "text", label: "Numbers: 100M URLs/day", x: 600, y: 100, width: 180, height: 42 });
const card = el({ id: "k", kind: "card", label: "Capacity estimate", x: 600, y: 400 });

describe("text notes and cards are not components", () => {
  it("link suggestions never connect a note or a card", () => {
    const board = [el({ id: "api", label: "Shortener API", x: 100, y: 100 }), note, card];
    const intent: SpatialIntent = { kind: "domain_continue", headline: "h", detail: "d", subjectId: "api", relatedIds: [], timestamp: 1 };
    const pool = generateCandidatePool(intent, board);
    const touches = pool.flatMap((a) => a.addElements.filter((e) => e.kind === "arrow").flatMap((e) => [e.fromId, e.toId]));
    expect(touches).not.toContain("n");
    expect(touches).not.toContain("k");
  });

  it("selecting a note offers no component options, and typed options never attach to one", () => {
    expect(buildNextOptions({ elements: [note], selectedIds: ["n"] })).toBeNull();
    const res = buildNextOptions({ elements: [note], text: "api gateway" })!;
    for (const o of res.options) {
      expect(o.addElements.some((e) => e.kind === "arrow" && (e.fromId === "n" || e.toId === "n"))).toBe(false);
    }
  });
});

describe("the board's database is the database", () => {
  const board = [
    el({ id: "api", label: "Shortener API", x: 100, y: 100 }),
    el({ id: "db", label: "URL DB", kind: "database", x: 500, y: 100, width: 156, height: 86 }),
  ];
  it("no option adds a Postgres DB next to URL DB; the full option wires to URL DB", () => {
    const res = buildNextOptions({ elements: board, text: "core service" })!;
    const added = res.options.flatMap((o) => o.addElements.filter((e) => e.kind !== "arrow").map((e) => e.label));
    expect(added.filter((l) => /postgres/i.test(l))).toEqual([]);
    expect(res.options[2].addElements.some((e) => e.kind === "arrow" && e.toId === "db")).toBe(true);
  });
  it("selecting the API never suggests another primary database", () => {
    const res = buildNextOptions({ elements: board, selectedIds: ["api"] })!;
    const added = res.options.flatMap((o) => o.addElements.filter((e) => e.kind !== "arrow").map((e) => e.label));
    expect(added.filter((l) => /postgres|^database$/i.test(l))).toEqual([]);
  });
});
