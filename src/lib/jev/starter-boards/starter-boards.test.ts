import { describe, expect, it } from "vitest";
import { getElementCenter, resolveArrowEndpoints } from "../geometry";
import { isContainerKind, parseEntityRows } from "../notation-kinds";
import { applyMorphToBoard, morphSelectionToNotation } from "../notation-morph";
import { estimate, formatBytes, formatCount } from "../sd-estimate";
import { parseStoredBoardSnapshot } from "../sync-validation";
import type { ElementBox, JevElement, MorphNotation } from "../types";
import { STARTER_BOARDS } from "./index";
import { numbersLines, type StarterBoard } from "./kit";

const isShape = (e: JevElement) => e.kind !== "arrow" && e.kind !== "freedraw";
const arrows = (els: JevElement[]) => els.filter((e) => e.kind === "arrow");
const byKey = (els: JevElement[], board: StarterBoard, key: string) => els.find((e) => e.id === `${board.id}_${key}`);
const contains = (outer: ElementBox, inner: ElementBox) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const apart = (a: ElementBox, b: ElementBox, pad = 0) =>
  a.x + a.width + pad <= b.x || b.x + b.width + pad <= a.x || a.y + a.height + pad <= b.y || b.y + b.height + pad <= a.y;
const name = (e: JevElement) => `${e.kind} "${e.label.split("\n")[0]}"`;
const groups = (els: JevElement[]) => {
  const out = new Map<string, JevElement[]>();
  for (const e of els) {
    const g = e.morphMeta?.groupId;
    if (g) out.set(g, [...(out.get(g) ?? []), e]);
  }
  return out;
};

/** The pill JevCanvas draws behind an arrow label (len × 7.2 + 18 wide, 20 tall, centred on the curve midpoint). */
function labelBox(a: JevElement, byId: Map<string, JevElement>): ElementBox {
  const { start, end, control } = resolveArrowEndpoints(a, byId);
  const cx = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
  const cy = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;
  const width = a.label.length * 7.2 + 18;
  return { x: cx - width / 2, y: cy - 11, width, height: 20 };
}

const EXPECTED_IDS = ["url-shortener", "chat", "news-feed", "rate-limiter", "payments", "notifications"];

describe("starter boards", () => {
  it("are the six classic problems, in order, each with a title and a blurb", () => {
    expect(STARTER_BOARDS.map((b) => b.id)).toEqual(EXPECTED_IDS);
    for (const b of STARTER_BOARDS) {
      expect(b.title.length, b.id).toBeGreaterThan(2);
      expect(b.blurb.length, b.id).toBeGreaterThan(20);
    }
  });

  describe.each(STARTER_BOARDS.map((b) => [b.id, b] as const))("%s", (_id, board) => {
    const els = board.build();
    const byId = new Map(els.map((e) => [e.id, e]));
    const shapes = els.filter(isShape);

    it("is deterministic and survives the stored-board validator unchanged", () => {
      expect(board.build()).toEqual(els);
      expect(new Set(els.map((e) => e.id)).size).toBe(els.length);
      const parsed = parseStoredBoardSnapshot(JSON.stringify({ elements: els, boardTitle: board.title }));
      expect(parsed, "parseStoredBoardSnapshot rejected the board").not.toBeNull();
      expect(parsed!.elements).toHaveLength(els.length);
    });

    it("has no overlapping shapes: boxes are apart, or a container (zone, fragment) holds the other whole (UML lets an activation bar cross a fragment edge)", () => {
      for (let i = 0; i < shapes.length; i++) {
        for (const b of shapes.slice(i + 1)) {
          const a = shapes[i];
          if (apart(a, b)) continue;
          const held = (isContainerKind(a.kind) && contains(a, b)) || (isContainerKind(b.kind) && contains(b, a));
          const barCrossesFragment = [a.kind, b.kind].sort().join() === "activation,fragment";
          if (barCrossesFragment) continue;
          expect(held, `${name(a)} overlaps ${name(b)}`).toBe(true);
        }
      }
    });

    it("every arrow endpoint exists, and no connector runs through a shape it does not join", () => {
      for (const a of arrows(els)) {
        if (a.fromId || a.toId) {
          expect(byId.has(a.fromId!), `${a.id} from ${a.fromId}`).toBe(true);
          expect(byId.has(a.toId!), `${a.id} to ${a.toId}`).toBe(true);
        } else {
          expect(a.fromPoint && a.toPoint, `${a.id} has no endpoints`).toBeTruthy();
        }
      }
      const solid = shapes.filter((s) => !isContainerKind(s.kind) && s.kind !== "activation");
      for (const a of arrows(els).filter((x) => x.fromId && x.toId)) {
        const c1 = getElementCenter(byId.get(a.fromId!)!);
        const c2 = getElementCenter(byId.get(a.toId!)!);
        for (const s of solid) {
          if (s.id === a.fromId || s.id === a.toId) continue;
          for (let t = 0.05; t < 1; t += 0.05) {
            const p = { x: c1.x + (c2.x - c1.x) * t, y: c1.y + (c2.y - c1.y) * t };
            const inside = p.x > s.x && p.x < s.x + s.width && p.y > s.y && p.y < s.y + s.height;
            expect(inside, `${a.label || a.id} crosses ${name(s)}`).toBe(false);
          }
        }
      }
    });

    it("arrow labels collide with no shape and no other label", () => {
      const labelled = arrows(els).filter((a) => a.label);
      const boxes = labelled.map((a) => ({ a, box: labelBox(a, byId) }));
      const solid = shapes.filter((s) => !isContainerKind(s.kind));
      for (const { a, box } of boxes) {
        for (const s of solid) {
          if (s.id === a.fromId || s.id === a.toId) continue;
          expect(apart(box, s), `label "${a.label}" sits on ${name(s)}`).toBe(true);
        }
      }
      for (let i = 0; i < boxes.length; i++) {
        for (const o of boxes.slice(i + 1)) {
          expect(apart(boxes[i].box, o.box), `label "${boxes[i].a.label}" collides with "${o.a.label}"`).toBe(true);
        }
      }
    });

    it("card text has no → (JetBrains Mono lacks it; the wider fallback glyph overflows the wrap width)", () => {
      for (const c of els.filter((e) => e.kind === "card")) expect(`${c.label}\n${c.sublabel}`, c.id).not.toContain("→");
    });

    it("holds a requirements card with functional and non-functional lines", () => {
      const req = byKey(els, board, "requirements")!;
      expect(req.kind).toBe("card");
      const lines = req.sublabel!.split("\n");
      expect(lines.filter((l) => l.startsWith("F: ")).length).toBeGreaterThanOrEqual(3);
      expect(lines.filter((l) => l.startsWith("NF: ")).length).toBeGreaterThanOrEqual(3);
    });

    it("holds a numbers card computed by sd-estimate", () => {
      const nums = byKey(els, board, "numbers")!;
      const { input } = board.def.numbers;
      const r = estimate(input);
      expect(nums.kind).toBe("card");
      expect(nums.sublabel).toBe(numbersLines(board.def.numbers).join("\n"));
      expect(nums.sublabel).toContain(formatCount(input.dau));
      for (const v of [r.avgWriteQps, r.peakWriteQps, r.avgReadQps, r.peakReadQps]) {
        expect(nums.sublabel).toContain(formatCount(v));
      }
      if (!board.def.numbers.omit?.includes("storage")) expect(nums.sublabel).toContain(formatBytes(r.storageTotal));
    });

    it("draws the HLD with real kinds inside a zone, labelled arrows, and a separate async write path", () => {
      const zone = byKey(els, board, "zone")!;
      expect(zone.kind).toBe("zone");
      for (const n of board.def.nodes) {
        const el = byKey(els, board, n.id)!;
        expect(contains(zone, el), `${n.id} ${n.outside ? "outside" : "inside"} the zone`).toBe(!n.outside);
      }
      const kinds = new Set(board.def.nodes.map((n) => n.kind));
      expect(kinds.has("actor")).toBe(true);
      expect(kinds.has("lb")).toBe(true);
      expect(["cache", "queue", "database", "blob", "external"].filter((k) => kinds.has(k as never)).length).toBeGreaterThanOrEqual(3);
      const hldArrows = arrows(els).filter((a) => a.id.startsWith(`${board.id}_edge_`));
      expect(hldArrows.every((a) => a.label.trim().length > 0)).toBe(true);
      expect(hldArrows.some((a) => a.tone === "terracotta")).toBe(true);
      expect(hldArrows.some((a) => a.tone === "cobalt")).toBe(true);
      expect(hldArrows.some((a) => a.dashed && a.endEnd === "open")).toBe(true);
    });

    it("holds an ER with PK/FK rows and crow's-foot relations", () => {
      const ents = els.filter((e) => e.kind === "entity");
      expect(ents.length).toBeGreaterThanOrEqual(3);
      for (const e of ents) expect(parseEntityRows(e.sublabel).some((r) => r.keys.includes("PK")), e.label).toBe(true);
      expect(ents.some((e) => parseEntityRows(e.sublabel).some((r) => r.keys.includes("FK")))).toBe(true);
      const rels = arrows(els).filter((a) => a.morphMeta?.role === "relation");
      expect(rels.length).toBeGreaterThanOrEqual(2);
      for (const r of rels) {
        expect(r.startEnd).toMatch(/^er_/);
        expect(r.endEnd).toMatch(/^er_/);
      }
    });

    it("holds one sequence with activation bars, sync/async/return messages and a fragment", () => {
      const msgs = els.filter((e) => e.morphMeta?.role === "message");
      expect(els.filter((e) => e.morphMeta?.role === "lifeline").length).toBeGreaterThanOrEqual(3);
      expect(els.filter((e) => e.kind === "activation").length).toBeGreaterThanOrEqual(2);
      expect(msgs.some((m) => !m.dashed && m.endEnd === "arrow")).toBe(true);
      expect(msgs.some((m) => m.dashed && m.endEnd === "open")).toBe(true);
      expect(els.filter((e) => e.kind === "fragment").length).toBeGreaterThanOrEqual(1);
    });

    it("has a 'Breaks at 10×' card pointing at the culprit HLD shape", () => {
      const card = byKey(els, board, "breaks")!;
      expect(card).toMatchObject({ kind: "card", label: "Breaks at 10×" });
      expect(card.sublabel).toMatch(/fix/i);
      const link = arrows(els).find((a) => a.fromId === card.id)!;
      expect(link.toId).toBe(`${board.id}_${board.def.breaks.culprit}`);
    });

    it("links the ER and the sequence to the HLD by Morph: two groups, each under its caption", () => {
      const gs = groups(els);
      expect([...gs.values()].map((g) => g[0].morphMeta!.notation).sort()).toEqual(["er", "sequence"]);
      for (const [view, key] of [["er", "er_caption"], ["sequence", "seq_caption"]] as const) {
        const members = [...gs.values()].find((g) => g[0].morphMeta!.notation === view)!;
        const record = members.find((e) => e.morphMeta?.groupRecord)!.morphMeta!.groupRecord!;
        const from = view === "er" ? board.def.er.from : board.def.sequence.from;
        const hldLabels = from.map((n) => byKey(els, board, n)!.label);
        expect(record.sketchSnapshot.filter((s) => s.kind !== "arrow").map((s) => s.label)).toEqual(hldLabels);
        if (view === "sequence") {
          for (const actor of record.spec.actors) {
            expect(record.sketchSnapshot.find((s) => s.semanticId === actor.id)?.label, actor.id).toBe(actor.label);
          }
        }
        const caption = byKey(els, board, key)!;
        const top = Math.min(...members.filter(isShape).map((e) => e.y));
        expect(caption.y + caption.height).toBeLessThanOrEqual(top);
        for (const l of hldLabels) expect(caption.sublabel).toContain(l);
      }
    });

    it("each morph group round-trips: to the sketch and back gives the same notation and spec", () => {
      for (const members of groups(els).values()) {
        const notation = members[0].morphMeta!.notation as Exclude<MorphNotation, "sketch">;
        const ids = members.filter(isShape).map((e) => e.id);
        const toSketch = morphSelectionToNotation(ids, els, "sketch", { now: 1 })!;
        const sketchBoard = applyMorphToBoard(els, toSketch);
        const record = members.find((e) => e.morphMeta?.groupRecord)!.morphMeta!.groupRecord!;
        const sketchEls = sketchBoard.filter((e) => e.morphMeta?.groupId === record.groupId);
        expect(sketchEls.map((e) => e.id).sort()).toEqual(record.sketchSnapshot.map((s) => s.id).sort());
        const back = morphSelectionToNotation(toSketch.nextSelectedIds, sketchBoard, notation, { now: 1 })!;
        expect(back.spec).toEqual(record.spec);
        const again = applyMorphToBoard(sketchBoard, back).filter((e) => e.morphMeta?.groupId === record.groupId);
        const sig = (list: JevElement[]) =>
          list.map((e) => `${e.kind}|${e.morphMeta?.role}|${e.morphMeta?.semanticId ?? ""}|${e.label}|${e.sublabel ?? ""}`).sort();
        expect(sig(again)).toEqual(sig(members));
        const other = notation === "er" ? "sequence" : "er";
        expect(morphSelectionToNotation(ids, els, other, { now: 1 })?.notation).toBe(other);
      }
    });

    it("fits a 16:10 screen without being a strip", () => {
      const xs = shapes.flatMap((s) => [s.x, s.x + s.width]);
      const ys = shapes.flatMap((s) => [s.y, s.y + s.height]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      expect(w / h).toBeGreaterThan(1.2);
      expect(w / h).toBeLessThan(2.6);
    });
  });
});
