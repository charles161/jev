import { describe, expect, it } from "vitest";
import { computeBounds } from "./geometry";
import { parseClassCompartments, parseEntityRows, parseTransitionLabel } from "./notation-kinds";
import {
  buildEstimateCard,
  buildStarter,
  matchPaletteCommands,
  PACKS,
  PALETTE_COMMANDS,
  parsePaletteInput,
  placeInsert,
  STARTER_COMMANDS,
} from "./notation-packs";
import { storedBoardSnapshotSchema } from "./sync-validation";
import { SHAPE_KINDS, type JevElement } from "./types";

const CENTER = { x: 500, y: 400 };
const NOW = 1_700_000_000_000;
const shapes = (els: JevElement[]) => els.filter((e) => e.kind !== "arrow" && e.kind !== "freedraw");
const arrows = (els: JevElement[]) => els.filter((e) => e.kind === "arrow");

describe("palette commands", () => {
  it("are exactly /er /seq /state /class /api /estimate, each with a title and hint", () => {
    expect(PALETTE_COMMANDS.map((c) => c.command)).toEqual(["er", "seq", "state", "class", "api", "estimate"]);
    for (const c of PALETTE_COMMANDS) {
      expect(c.title.length).toBeGreaterThan(2);
      expect(c.hint.length).toBeGreaterThan(5);
    }
  });

  it("typing '/' lists every command; a prefix narrows the list", () => {
    expect(matchPaletteCommands("/").map((c) => c.command)).toHaveLength(6);
    expect(matchPaletteCommands("/s").map((c) => c.command)).toEqual(["seq", "state"]);
    expect(matchPaletteCommands("/est 50M DAU").map((c) => c.command)).toEqual(["estimate"]);
    expect(matchPaletteCommands("users table")).toEqual([]);
    expect(matchPaletteCommands("/zzz")).toEqual([]);
  });

  it("parses a command and its argument text", () => {
    expect(parsePaletteInput("/estimate 50M DAU, 2KB")).toEqual({ command: "estimate", args: "50M DAU, 2KB" });
    expect(parsePaletteInput("  /ER ")).toEqual({ command: "er", args: "" });
    expect(parsePaletteInput("/nope")).toBeNull();
    expect(parsePaletteInput("app -> db")).toBeNull();
  });
});

describe("starter inserts are real notation", () => {
  it("every starter is valid on the wire and centred on the requested point", () => {
    for (const cmd of STARTER_COMMANDS) {
      const els = buildStarter(cmd, CENTER, NOW);
      expect(els.length, cmd).toBeGreaterThan(0);
      expect(storedBoardSnapshotSchema.safeParse({ elements: els, boardTitle: "t" }).success, cmd).toBe(true);
      const b = computeBounds(shapes(els))!;
      expect(Math.abs(b.x + b.width / 2 - CENTER.x), cmd).toBeLessThan(40);
      expect(Math.abs(b.y + b.height / 2 - CENTER.y), cmd).toBeLessThan(40);
    }
  });

  it("no starter overlaps its own shapes or runs a connector through a shape it does not join", () => {
    const hits = (r: { x: number; y: number; width: number; height: number }, p: { x: number; y: number }) =>
      p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
    for (const cmd of STARTER_COMMANDS) {
      const els = buildStarter(cmd, CENTER, NOW);
      const boxes = shapes(els).filter((e) => e.kind !== "activation");
      for (let i = 0; i < boxes.length; i++) {
        for (const b of boxes.slice(i + 1)) {
          const a = boxes[i];
          const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
          expect(apart, `${cmd}: ${a.label || a.kind} overlaps ${b.label || b.kind}`).toBe(true);
        }
      }
      const byId = new Map(els.map((e) => [e.id, e]));
      for (const a of arrows(els)) {
        const from = a.fromId ? byId.get(a.fromId) : undefined;
        const to = a.toId ? byId.get(a.toId) : undefined;
        if (!from || !to) continue;
        const c1 = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        const c2 = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
        for (const s of boxes) {
          if (s.id === from.id || s.id === to.id) continue;
          for (let t = 0.05; t < 1; t += 0.05) {
            const p = { x: c1.x + (c2.x - c1.x) * t, y: c1.y + (c2.y - c1.y) * t };
            expect(hits(s, p), `${cmd}: ${a.label || "arrow"} crosses ${s.label || s.kind}`).toBe(false);
          }
        }
      }
    }
  });

  it("/er: two entities with PK and FK rows joined by a crow's-foot relation", () => {
    const els = buildStarter("er", CENTER, NOW);
    const ents = shapes(els);
    expect(ents.map((e) => e.kind)).toEqual(["entity", "entity"]);
    const rows = ents.map((e) => parseEntityRows(e.sublabel));
    expect(rows.every((r) => r.some((row) => row.keys.includes("PK")))).toBe(true);
    expect(rows.some((r) => r.some((row) => row.keys.includes("FK")))).toBe(true);
    const [rel] = arrows(els);
    expect(rel).toMatchObject({ startEnd: "er_only_one", endEnd: "er_zero_many" });
    expect(els.every((e) => e.morphMeta?.notation === "er")).toBe(true);
  });

  it("/seq: three lifelines, activation bars, and at least one dashed return", () => {
    const els = buildStarter("seq", CENTER, NOW);
    const lifelines = els.filter((e) => e.morphMeta?.role === "lifeline");
    expect(lifelines).toHaveLength(3);
    expect(els.filter((e) => e.kind === "activation").length).toBeGreaterThanOrEqual(2);
    const messages = els.filter((e) => e.morphMeta?.role === "message");
    expect(messages.some((m) => m.dashed && m.endEnd === "open")).toBe(true);
    expect(messages.some((m) => !m.dashed && m.endEnd === "arrow")).toBe(true);
  });

  it("/state: initial → two states with guarded transitions → final", () => {
    const els = buildStarter("state", CENTER, NOW);
    const init = els.find((e) => e.kind === "initial")!;
    const fin = els.find((e) => e.kind === "final")!;
    const states = els.filter((e) => e.morphMeta?.role === "state");
    expect(init.x).toBeLessThan(Math.min(...states.map((s) => s.x)));
    expect(fin.y).toBeGreaterThan(Math.max(...states.map((s) => s.y + s.height)));
    expect(els.filter((e) => e.kind === "initial")).toHaveLength(1);
    expect(els.filter((e) => e.kind === "final")).toHaveLength(1);
    expect(els.filter((e) => e.morphMeta?.role === "state")).toHaveLength(2);
    const guarded = arrows(els).filter((a) => parseTransitionLabel(a.label).guard);
    expect(guarded).toHaveLength(2);
  });

  it("/class: two classes with compartments and a hollow-triangle inheritance arrow to the parent", () => {
    const els = buildStarter("class", CENTER, NOW);
    const classes = shapes(els);
    expect(classes.map((c) => c.kind)).toEqual(["class", "class"]);
    for (const c of classes) {
      const { attributes, operations } = parseClassCompartments(c.sublabel);
      expect(attributes.length + operations.length).toBeGreaterThan(0);
    }
    const [inh] = arrows(els);
    const parent = classes.find((c) => c.id === inh.toId)!;
    expect(inh.endEnd).toBe("triangle");
    expect(inh.startEnd).toBe("none");
    expect(parent.label).toContain("«abstract»");
    expect(parent.y).toBeLessThan(classes.find((c) => c.id === inh.fromId)!.y);
  });

  it("/api: one API card with request, response, errors and idempotency rows", () => {
    const els = buildStarter("api", CENTER, NOW);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: "api", label: "POST /orders" });
    for (const p of ["req:", "res:", "err:", "idem:"]) expect(els[0].sublabel).toContain(p);
  });
});

describe("/estimate", () => {
  it("inserts a numbers card sized to its lines", () => {
    const card = buildEstimateCard("50M DAU, 5 writes/user/day, 2KB, 3y", CENTER, NOW);
    expect(card.kind).toBe("card");
    expect(card.label).toBe("Numbers · 50M DAU");
    expect(card.sublabel).toContain("50M DAU × 5 / 86 400 s ≈ 2.89K QPS");
    expect(card.height).toBeGreaterThan(160);
    expect(Math.round(card.x + card.width / 2)).toBe(CENTER.x);
    expect(storedBoardSnapshotSchema.safeParse({ elements: [card], boardTitle: "t" }).success).toBe(true);
  });
});

describe("side-panel packs", () => {
  it("lists HLD, ER, Sequence, State, Class and API, each with placeable shapes and a starter", () => {
    expect(PACKS.map((p) => p.title)).toEqual(["HLD", "ER", "Sequence", "State", "Class", "API"]);
    for (const p of PACKS) {
      expect(p.items.length, p.id).toBeGreaterThan(0);
      for (const item of p.items) expect(SHAPE_KINDS).toContain(item.kind);
      expect(PALETTE_COMMANDS.map((c) => c.command)).toContain(p.starter);
    }
  });
});

describe("placeInsert", () => {
  it("moves an insert off existing shapes and keeps arrows attached", () => {
    const existing = buildStarter("api", CENTER, NOW);
    const els = placeInsert(buildStarter("class", CENTER, NOW), existing);
    const b = computeBounds(shapes(els))!;
    for (const s of shapes(existing)) {
      const overlap = !(b.x + b.width < s.x || s.x + s.width < b.x || b.y + b.height < s.y || s.y + s.height < b.y);
      expect(overlap).toBe(false);
    }
    const ids = new Set(els.map((e) => e.id));
    for (const a of arrows(els)) expect(ids.has(a.fromId!) && ids.has(a.toId!)).toBe(true);
  });

  it("leaves an insert where it is on an empty board", () => {
    const els = buildStarter("class", CENTER, NOW);
    expect(placeInsert(els, [])).toEqual(els);
  });
});
