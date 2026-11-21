import { describe, expect, it } from "vitest";
import {
  BOARD_PAPER,
  classLayout,
  entityLayout,
  fragmentLayout,
  layoutShapeGlyphs,
  renderKindOf,
  shapeLabelBox,
} from "@/lib/jev/shape-layout";
import { SHAPE_KINDS, type JevElement, type ShapeKind } from "@/lib/jev/types";
import { DEFAULT_KIND_SIZE } from "@/lib/jev/notation-kinds";

function el(kind: JevElement["kind"], overrides: Partial<JevElement> = {}): JevElement {
  const size = kind in DEFAULT_KIND_SIZE ? DEFAULT_KIND_SIZE[kind as ShapeKind] : { width: 160, height: 64 };
  return {
    id: `el_${kind}`,
    kind,
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    label: "Label",
    tone: "ink",
    seed: 7,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const texts = (e: JevElement) => layoutShapeGlyphs(e)?.texts.map((t) => t.text) ?? [];

describe("board paper colour", () => {
  it("matches the canvas paper in both themes (hollow markers are filled with it)", () => {
    expect(BOARD_PAPER).toEqual({ vellum: "#F7F4ED", midnight: "#11151D" });
  });
});

describe("generic label box", () => {
  it("keeps the existing label geometry for the original kinds", () => {
    expect(shapeLabelBox(el("node", { width: 160, height: 64 }))).toEqual({ x: 10, y: 6, width: 140, height: 52 });
    expect(shapeLabelBox(el("diamond", { width: 140, height: 96 }))).toEqual({ x: 18, y: 6, width: 104, height: 84 });
    expect(shapeLabelBox(el("database", { width: 132, height: 92 }))).toEqual({ x: 10, y: 16, width: 112, height: 70 });
    expect(shapeLabelBox(el("text", { width: 160, height: 40 }))).toEqual({ x: 10, y: 6, width: 140, height: 28 });
  });

  it("puts the actor's name under the stick figure, inside its box", () => {
    const a = el("actor");
    const box = shapeLabelBox(a)!;
    expect(box.y).toBeGreaterThan(a.height * 0.6);
    expect(box.y + box.height).toBeLessThanOrEqual(a.height);
  });

  it("draws no centred label over glyph-only or self-laid-out kinds", () => {
    for (const kind of ["initial", "final", "activation", "entity", "class", "fragment", "zone", "frame"] as const) {
      expect(shapeLabelBox(el(kind))).toBeNull();
    }
  });

  it("keeps HLD labels clear of their motifs", () => {
    for (const kind of ["queue", "cache", "lb", "blob", "external"] as const) {
      const e = el(kind);
      const box = shapeLabelBox(e)!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(e.width);
      expect(box.y + box.height).toBeLessThanOrEqual(e.height);
      expect(box.width).toBeGreaterThan(40);
    }
  });
});

describe("render kind", () => {
  it("routes old ER cards (node + entity role) through the entity renderer", () => {
    const old = el("node", {
      sublabel: "PK id: uuid",
      morphMeta: { groupId: "g", notation: "er", role: "entity" },
    });
    expect(renderKindOf(old)).toBe("entity");
    expect(renderKindOf(el("node"))).toBe("node");
  });
});

describe("entity (ER table)", () => {
  const users = el("entity", {
    label: "users",
    sublabel: "id uuid PK\norg_id uuid FK\nemail text UK\nname text",
  });

  it("lays out a header with the table name and one row per column with key badges", () => {
    const g = layoutShapeGlyphs(users)!;
    expect(g.texts[0]).toMatchObject({ text: "users", anchor: "middle", weight: 700 });
    expect(texts(users)).toEqual(expect.arrayContaining(["id", "uuid", "org_id", "email", "text", "name"]));
    expect(g.badges.map((b) => b.text)).toEqual(["PK", "FK", "UK"]);
    for (const b of g.badges) {
      expect(b.x + b.w).toBeLessThanOrEqual(entityLayout(users).keyColWidth);
    }
  });

  it("underlines primary-key columns and separates the PK block with a divider", () => {
    const g = layoutShapeGlyphs(users)!;
    expect(g.texts.find((t) => t.text === "id")?.underline).toBe(true);
    expect(g.texts.find((t) => t.text === "email")?.underline).toBeFalsy();
    const layout = entityLayout(users);
    expect(layout.pkDividerY).toBe(layout.headerHeight + layout.rowHeight + layout.padTop);
  });

  it("shows '+N more' instead of drawing rows outside the box", () => {
    const many = el("entity", {
      height: 100,
      sublabel: Array.from({ length: 12 }, (_, i) => `col_${i} int`).join("\n"),
    });
    const layout = entityLayout(many);
    expect(layout.visibleRows).toBeLessThan(12);
    const g = layoutShapeGlyphs(many)!;
    expect(texts(many)).toContain(`+${12 - layout.visibleRows} more`);
    for (const t of g.texts) expect(t.y).toBeLessThanOrEqual(many.height);
  });

  it("parses the legacy 'PK id: uuid' attribute format from morph", () => {
    const old = el("node", {
      label: "orders",
      sublabel: "PK id: uuid\nFK user_id: uuid",
      morphMeta: { groupId: "g", notation: "er", role: "entity" },
      width: 204,
      height: 114,
    });
    expect(texts(old)).toEqual(expect.arrayContaining(["orders", "id", "user_id", "uuid"]));
    expect(layoutShapeGlyphs(old)!.badges.map((b) => b.text)).toEqual(["PK", "FK"]);
  });

  it("has no key column when no row is a key", () => {
    expect(entityLayout(el("entity", { sublabel: "a int\nb int" })).keyColWidth).toBe(0);
  });
});

describe("class (UML three compartments)", () => {
  const cls = el("class", {
    label: "ParkingLot",
    sublabel: "- id: UUID\n- spots: Spot[]\n--\n+ park(car): Ticket\n+ leave(ticket)",
  });

  it("has three stacked compartments: name, attributes, operations", () => {
    const l = classLayout(cls);
    expect(l.attrsTop).toBe(l.nameHeight);
    expect(l.opsTop).toBeGreaterThan(l.attrsTop);
    expect(l.opsTop).toBeLessThan(cls.height);
    const g = layoutShapeGlyphs(cls)!;
    expect(g.texts[0]).toMatchObject({ text: "ParkingLot", anchor: "middle", weight: 700 });
    const attr = g.texts.find((t) => t.text === "- id: UUID")!;
    const op = g.texts.find((t) => t.text === "+ park(car): Ticket")!;
    expect(attr.y).toBeGreaterThan(l.attrsTop);
    expect(attr.y).toBeLessThan(l.opsTop);
    expect(op.y).toBeGreaterThan(l.opsTop);
    expect(attr.anchor).toBe("start");
  });

  it("keeps an empty attributes compartment when there are none", () => {
    const l = classLayout(el("class", { label: "Empty", sublabel: "" }));
    expect(l.opsTop).toBeGreaterThan(l.attrsTop);
  });

  it("renders a «stereotype» first line above the name, and italic for «abstract»", () => {
    const iface = el("class", { label: "«interface»\nPayment" });
    const g = layoutShapeGlyphs(iface)!;
    expect(g.texts[0].text).toBe("«interface»");
    expect(g.texts[1]).toMatchObject({ text: "Payment", weight: 700 });
    const abs = layoutShapeGlyphs(el("class", { label: "«abstract»\nVehicle" }))!;
    expect(abs.texts[1].italic).toBe(true);
  });
});

describe("fragment (UML combined fragment)", () => {
  it("puts the operator in the corner tag and divides the box evenly per operand", () => {
    const f = el("fragment", { label: "alt", sublabel: "[cache hit]\n[else]", height: 200 });
    const l = fragmentLayout(f);
    expect(l.operator).toBe("alt");
    expect(l.operands.map((o) => o.top)).toEqual([0, 100]);
    expect(l.operands.map((o) => o.guard)).toEqual(["[cache hit]", "[else]"]);
    const g = layoutShapeGlyphs(f)!;
    const op = g.texts.find((t) => t.text === "alt")!;
    expect(op.x).toBeLessThan(l.tagWidth);
    expect(op.weight).toBe(700);
    const firstGuard = g.texts.find((t) => t.text === "[cache hit]")!;
    expect(firstGuard.x).toBeGreaterThan(l.tagWidth);
    const elseGuard = g.texts.find((t) => t.text === "[else]")!;
    expect(elseGuard.y).toBeGreaterThan(100);
  });

  it("wraps bare guards in brackets and has one operand without guards", () => {
    const f = el("fragment", { label: "loop", sublabel: "each item" });
    expect(fragmentLayout(f).operands.map((o) => o.guard)).toEqual(["[each item]"]);
    expect(fragmentLayout(el("fragment", { label: "opt" })).operands).toHaveLength(1);
  });
});

describe("zone", () => {
  it("labels the boundary top-left in the stroke colour", () => {
    const g = layoutShapeGlyphs(el("zone", { label: "VPC us-east-1" }))!;
    expect(g.texts).toHaveLength(1);
    expect(g.texts[0]).toMatchObject({ text: "VPC us-east-1", anchor: "start", tone: "stroke" });
    expect(g.texts[0].x).toBeLessThan(30);
    expect(g.texts[0].y).toBeLessThan(30);
  });
});

describe("every shape kind has a defined label strategy", () => {
  it.each(SHAPE_KINDS.map((k) => [k]))("%s", (kind) => {
    const e = el(kind as ShapeKind);
    const hasBox = shapeLabelBox(e) !== null;
    const glyphs = layoutShapeGlyphs(e);
    const glyphOnly = ["initial", "final", "activation", "frame"].includes(kind as string);
    expect(hasBox || glyphs !== null || glyphOnly).toBe(true);
    expect(hasBox && glyphs !== null).toBe(false);
  });
});
