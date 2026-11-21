import { describe, expect, it } from "vitest";
import { generateShapePaths, type ShapePath } from "@/lib/jev/rough-paths";
import { classLayout, entityLayout, fragmentLayout } from "@/lib/jev/shape-layout";
import { DEFAULT_KIND_SIZE } from "@/lib/jev/notation-kinds";
import { HLD_SHAPE_KINDS, LLD_SHAPE_KINDS, type JevElement, type ShapeKind } from "@/lib/jev/types";

const STROKE = "#E6E1D6";
const FILL = "rgba(31, 37, 49, 0.92)";
const PAPER = "#11151D";

function el(kind: ShapeKind, overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: `el_${kind}`,
    kind,
    x: 0,
    y: 0,
    ...DEFAULT_KIND_SIZE[kind],
    label: "L",
    tone: "ink",
    seed: 99,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const paths = (e: JevElement, style: "clean" | "sketch" = "clean") =>
  generateShapePaths(e, STROKE, FILL, style, false, PAPER);

/** Horizontal straight segments `M x1 y L x2 y` across the shape. */
function horizontals(ps: ShapePath[]): Array<{ y: number; x1: number; x2: number; dash?: string }> {
  const out: Array<{ y: number; x1: number; x2: number; dash?: string }> = [];
  for (const p of ps) {
    const m = /^M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+)$/.exec(p.d.trim());
    if (m && Number(m[2]) === Number(m[4])) {
      out.push({ y: Number(m[2]), x1: Number(m[1]), x2: Number(m[3]), dash: p.dash });
    }
  }
  return out;
}

describe("new shape kinds render", () => {
  it.each([...HLD_SHAPE_KINDS, ...LLD_SHAPE_KINDS].map((k) => [k]))("%s has finite clean geometry", (kind) => {
    const ps = paths(el(kind as ShapeKind));
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.d.length).toBeGreaterThan(0);
      expect(p.d).not.toMatch(/NaN|Infinity/);
    }
  });

  it.each(HLD_SHAPE_KINDS.map((k) => [k]))("%s has a deterministic hand-drawn sketch variant", (kind) => {
    const e = el(kind as ShapeKind);
    const a = paths(e, "sketch");
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(paths(e, "sketch"));
    expect(a).not.toEqual(paths(e));
    for (const p of a) expect(p.d).not.toMatch(/NaN|Infinity/);
  });

  it.each(LLD_SHAPE_KINDS.map((k) => [k]))("%s is always a clean vector, even when asked for sketch", (kind) => {
    const e = el(kind as ShapeKind, { label: "alt", sublabel: "id uuid PK\n--\nrun()" });
    expect(paths(e, "sketch")).toEqual(paths(e, "clean"));
  });

  it("the HLD shapes are visually distinct from each other and from node/database", () => {
    const kinds: ShapeKind[] = ["node", "database", "queue", "cache", "lb", "blob", "external"];
    const sigs = kinds.map((k) => paths(el(k, { width: 160, height: 80 })).map((p) => p.d).join("|"));
    expect(new Set(sigs).size).toBe(kinds.length);
  });
});

describe("notation details", () => {
  it("initial is one solid disc in the stroke colour", () => {
    const ps = paths(el("initial"));
    expect(ps).toHaveLength(1);
    expect(ps[0].fill).toBe(STROKE);
  });

  it("final is a bullseye: an outer ring plus a smaller solid disc", () => {
    const ps = paths(el("final"));
    expect(ps).toHaveLength(2);
    expect(ps[0].fill).not.toBe(STROKE);
    expect(ps[1].fill).toBe(STROKE);
    const r = (d: string) => Number(/A ([\d.]+)/.exec(d)![1]);
    expect(r(ps[1].d)).toBeLessThan(r(ps[0].d) * 0.7);
  });

  it("activation is a narrow bar backed by the paper so the lifeline does not show through", () => {
    const ps = paths(el("activation"));
    expect(ps[0].fill).toBe(PAPER);
    expect(ps.at(-1)!.stroke).toBe(STROKE);
  });

  it("zone is a dash-dot boundary, different from a frame's dash", () => {
    const ps = paths(el("zone"));
    expect(ps.some((p) => p.dash)).toBe(true);
    expect(ps.find((p) => p.dash)!.dash).not.toBe("8 6");
    const sketch = paths(el("zone"), "sketch");
    expect(sketch.some((p) => p.dash)).toBe(true);
  });

  it("external system has a double border", () => {
    const ps = paths(el("external"));
    expect(ps.filter((p) => p.stroke === STROKE).length).toBeGreaterThanOrEqual(2);
  });

  it("entity has a header divider at the header height and a key-column divider", () => {
    const e = el("entity", { sublabel: "id uuid PK\nname text" });
    const l = entityLayout(e);
    const ps = paths(e);
    const h = horizontals(ps);
    expect(h.some((s) => s.y === l.headerHeight && s.x1 === 0 && s.x2 === e.width)).toBe(true);
    expect(h.some((s) => s.y === l.pkDividerY)).toBe(true);
    expect(ps.some((p) => p.d === `M ${l.keyColWidth} ${l.headerHeight} L ${l.keyColWidth} ${e.height}`)).toBe(true);
    expect(ps.some((p) => p.fillOpacity !== undefined && p.fill === STROKE)).toBe(true);
  });

  it("class has exactly two full-width compartment dividers", () => {
    const e = el("class", { sublabel: "- a: int\n--\n+ go()" });
    const l = classLayout(e);
    const full = horizontals(paths(e)).filter((s) => s.x1 === 0 && s.x2 === e.width);
    expect(full.map((s) => s.y)).toEqual([l.attrsTop, l.opsTop]);
  });

  it("fragment has a pentagon operator tag and a dashed divider between operands", () => {
    const e = el("fragment", { label: "alt", sublabel: "[hit]\n[miss]\n[error]", height: 240 });
    const l = fragmentLayout(e);
    const ps = paths(e);
    const dividers = horizontals(ps).filter((s) => s.dash);
    expect(dividers.map((s) => s.y)).toEqual([80, 160]);
    const tag = ps.find((p) => p.d.startsWith("M 0 0 L " + l.tagWidth))!;
    expect(tag.d.split(" L ")).toHaveLength(5);
    expect(ps[0].fill).toBe("none");
  });

  it("actor is a stick figure that leaves room for its name below", () => {
    const e = el("actor");
    const ps = paths(e);
    expect(ps.some((p) => p.d.includes(" A "))).toBe(true);
    const maxY = Math.max(...ps.flatMap((p) => (p.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 1)));
    expect(maxY).toBeLessThan(e.height - 18);
  });
});
