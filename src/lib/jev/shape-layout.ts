import { parseClassCompartments, parseEntityRows, type EntityRow } from "./notation-kinds";
import type { BoardTheme, ElementKind, JevElement } from "./types";

/** Board paper colour per theme (globals.css --jev-paper); hollow markers and activation bars are filled with it. */
export const BOARD_PAPER: Record<BoardTheme, string> = {
  vellum: "#F7F4ED",
  midnight: "#11151D",
};

export type GlyphTone = "text" | "subtext" | "stroke";

/** One SVG text run, positioned in the shape's local coordinates (y = baseline). */
export interface GlyphText {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  size: number;
  weight: number;
  font: "label" | "mono";
  tone: GlyphTone;
  italic?: boolean;
  underline?: boolean;
}

export interface GlyphBadge {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface ShapeGlyphs {
  texts: GlyphText[];
  badges: GlyphBadge[];
}

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Old morph ER cards are `node`s with the entity role; they draw as entity tables. */
export function renderKindOf(el: Pick<JevElement, "kind" | "sublabel" | "morphMeta">): ElementKind {
  if (el.kind === "node" && el.morphMeta?.role === "entity" && el.sublabel && el.sublabel.trim()) {
    return "entity";
  }
  return el.kind;
}

const MONO_CHAR = 6.6;

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function charsFor(width: number, size: number, mono: boolean): number {
  const per = mono ? (MONO_CHAR * size) / 11 : size * 0.58;
  return Math.max(1, Math.floor(width / per));
}

export function queueCapRadius(w: number): number {
  return Math.min(14, w * 0.1);
}

export function lbInset(w: number): number {
  return Math.min(18, w * 0.16);
}

export function blobRimRadius(h: number): number {
  return Math.min(10, h * 0.12);
}

export const ACTOR_LABEL_HEIGHT = 24;

/** Region for the generic centred label, or null when the kind lays out its own text (or has none). */
export function shapeLabelBox(el: Pick<JevElement, "kind" | "width" | "height" | "sublabel" | "morphMeta">): LabelBox | null {
  const w = el.width;
  const h = el.height;
  switch (renderKindOf(el)) {
    case "diamond":
      return { x: 18, y: 6, width: w - 36, height: h - 12 };
    case "database":
      return { x: 10, y: 16, width: w - 20, height: h - 22 };
    case "queue": {
      const rx = queueCapRadius(w);
      return { x: rx + 6, y: 6, width: w - 2 * rx - 38, height: h - 12 };
    }
    case "cache":
      return { x: 10, y: 6, width: w - 36, height: h - 12 };
    case "lb": {
      const i = lbInset(w);
      return { x: i, y: 4, width: w - 2 * i, height: h - 26 };
    }
    case "blob": {
      const ry = blobRimRadius(h);
      return { x: w * 0.12, y: 2 * ry + 2, width: w * 0.76, height: h - 2 * ry - 10 };
    }
    case "external":
      return { x: 12, y: 8, width: w - 24, height: h - 16 };
    case "actor":
      return { x: -24, y: h - ACTOR_LABEL_HEIGHT, width: w + 48, height: ACTOR_LABEL_HEIGHT };
    case "initial":
    case "final":
    case "activation":
    case "entity":
    case "class":
    case "fragment":
    case "zone":
    case "frame":
      return null;
    default:
      return { x: 10, y: 6, width: w - 20, height: h - 12 };
  }
}

export interface EntityLayout {
  rows: EntityRow[];
  headerHeight: number;
  rowHeight: number;
  padTop: number;
  keyColWidth: number;
  visibleRows: number;
  /** Divider under a leading block of primary-key rows, or null. */
  pkDividerY: number | null;
}

const BADGE_STEP = 24;

export function entityLayout(el: Pick<JevElement, "sublabel" | "height">): EntityLayout {
  const headerHeight = 30;
  const rowHeight = 18;
  const padTop = 5;
  const rows = parseEntityRows(el.sublabel);
  const maxKeys = rows.reduce((m, r) => Math.max(m, r.keys.length), 0);
  const keyColWidth = maxKeys > 0 ? 8 + maxKeys * BADGE_STEP : 0;
  const capacity = Math.max(0, Math.floor((el.height - headerHeight - padTop - 4) / rowHeight));
  const visibleRows = rows.length > capacity ? Math.max(0, capacity - 1) : rows.length;
  let leadingPk = 0;
  while (leadingPk < rows.length && rows[leadingPk].keys.includes("PK")) leadingPk++;
  const pkDividerY =
    leadingPk > 0 && leadingPk < visibleRows ? headerHeight + padTop + leadingPk * rowHeight : null;
  return { rows, headerHeight, rowHeight, padTop, keyColWidth, visibleRows, pkDividerY };
}

export interface ClassLayout {
  stereotype: string | null;
  name: string;
  italic: boolean;
  nameHeight: number;
  attrsTop: number;
  opsTop: number;
  rowHeight: number;
  attributes: string[];
  operations: string[];
}

export function classLayout(el: Pick<JevElement, "label" | "sublabel" | "height">): ClassLayout {
  const lines = el.label.split("\n").map((l) => l.trim()).filter(Boolean);
  const st = lines[0]?.match(/^(?:«(.+)»|<<(.+)>>)$/);
  const stereotype = st ? `«${(st[1] ?? st[2]).trim()}»` : null;
  const name = (st ? lines.slice(1) : lines).join(" ");
  const nameHeight = stereotype ? 40 : 30;
  const rowHeight = 16;
  const { attributes, operations } = parseClassCompartments(el.sublabel);
  const attrsTop = nameHeight;
  const attrsHeight = attributes.length > 0 ? 6 + attributes.length * rowHeight : 12;
  const opsTop = Math.min(attrsTop + attrsHeight, Math.max(attrsTop + 6, el.height - 12));
  return {
    stereotype,
    name,
    italic: stereotype === "«abstract»",
    nameHeight,
    attrsTop,
    opsTop,
    rowHeight,
    attributes,
    operations,
  };
}

export interface FragmentLayout {
  operator: string;
  tagWidth: number;
  tagHeight: number;
  operands: Array<{ guard: string; top: number }>;
}

export function fragmentLayout(el: Pick<JevElement, "label" | "sublabel" | "height">): FragmentLayout {
  const operator = el.label.trim() || "alt";
  const tagHeight = 20;
  const tagWidth = Math.max(44, Math.round(operator.length * 7.5 + 22));
  const guards = (el.sublabel ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((g) => (g.startsWith("[") ? g : `[${g}]`));
  const n = Math.max(1, guards.length);
  const operands = Array.from({ length: n }, (_, i) => ({ guard: guards[i] ?? "", top: (i * el.height) / n }));
  return { operator, tagWidth, tagHeight, operands };
}

function entityGlyphs(el: JevElement): ShapeGlyphs {
  const l = entityLayout(el);
  const w = el.width;
  const texts: GlyphText[] = [];
  const badges: GlyphBadge[] = [];
  const title = el.label.split("\n")[0]?.trim() ?? "";
  texts.push({
    x: w / 2,
    y: l.headerHeight / 2 + 4.5,
    text: clip(title, charsFor(w - 16, 13, false)),
    anchor: "middle",
    size: 13,
    weight: 700,
    font: "label",
    tone: "text",
  });
  const nameX = l.keyColWidth > 0 ? l.keyColWidth + 8 : 10;
  const maxChars = charsFor(w - nameX - 10, 11, true);
  l.rows.slice(0, l.visibleRows).forEach((row, i) => {
    const top = l.headerHeight + l.padTop + i * l.rowHeight;
    const baseline = top + 13;
    row.keys.forEach((k, ki) => {
      badges.push({ x: 6 + ki * BADGE_STEP, y: top + 2.5, w: 20, h: 13, text: k });
    });
    let type = row.type;
    let name = row.name;
    if (name.length + 1 + type.length > maxChars) {
      const room = maxChars - name.length - 1;
      type = room >= 3 ? clip(type, room) : "";
      name = clip(name, maxChars);
    }
    texts.push({
      x: nameX,
      y: baseline,
      text: name,
      anchor: "start",
      size: 11,
      weight: row.keys.includes("PK") ? 700 : 500,
      font: "mono",
      tone: "text",
      ...(row.keys.includes("PK") ? { underline: true } : {}),
    });
    if (type) {
      texts.push({ x: w - 10, y: baseline, text: type, anchor: "end", size: 10.5, weight: 400, font: "mono", tone: "subtext" });
    }
  });
  const hidden = l.rows.length - l.visibleRows;
  if (hidden > 0) {
    texts.push({
      x: nameX,
      y: l.headerHeight + l.padTop + l.visibleRows * l.rowHeight + 13,
      text: `+${hidden} more`,
      anchor: "start",
      size: 10,
      weight: 500,
      font: "mono",
      tone: "subtext",
    });
  }
  return { texts, badges };
}

function classGlyphs(el: JevElement): ShapeGlyphs {
  const l = classLayout(el);
  const w = el.width;
  const texts: GlyphText[] = [];
  if (l.stereotype) {
    texts.push({ x: w / 2, y: 15, text: l.stereotype, anchor: "middle", size: 10, weight: 500, font: "label", tone: "subtext" });
  }
  texts.push({
    x: w / 2,
    y: l.stereotype ? 31 : 19.5,
    text: clip(l.name, charsFor(w - 16, 13, false)),
    anchor: "middle",
    size: 13,
    weight: 700,
    font: "label",
    tone: "text",
    ...(l.italic ? { italic: true } : {}),
  });
  const maxChars = charsFor(w - 16, 11, true);
  const rowsInto = (items: string[], top: number, bottom: number) => {
    const fit = Math.max(0, Math.floor((bottom - top - 4) / l.rowHeight));
    const shown = items.length > fit ? [...items.slice(0, Math.max(0, fit - 1)), "…"] : items;
    shown.forEach((text, i) => {
      texts.push({
        x: 8,
        y: top + 3 + i * l.rowHeight + 12,
        text: clip(text, maxChars),
        anchor: "start",
        size: 11,
        weight: 500,
        font: "mono",
        tone: "text",
      });
    });
  };
  rowsInto(l.attributes, l.attrsTop, l.opsTop);
  rowsInto(l.operations, l.opsTop, el.height);
  return { texts, badges: [] };
}

function fragmentGlyphs(el: JevElement): ShapeGlyphs {
  const l = fragmentLayout(el);
  const texts: GlyphText[] = [
    { x: 9, y: 14, text: l.operator, anchor: "start", size: 12, weight: 700, font: "label", tone: "text" },
  ];
  l.operands.forEach((op, i) => {
    if (!op.guard) return;
    const x = i === 0 ? l.tagWidth + 8 : 10;
    texts.push({
      x,
      y: op.top + 14,
      text: clip(op.guard, charsFor(el.width - x - 8, 11, true)),
      anchor: "start",
      size: 11,
      weight: 500,
      font: "mono",
      tone: "subtext",
    });
  });
  return { texts, badges: [] };
}

/** Self-laid-out text for kinds that do not use the generic centred label. */
export function layoutShapeGlyphs(el: JevElement): ShapeGlyphs | null {
  switch (renderKindOf(el)) {
    case "entity":
      return entityGlyphs(el);
    case "class":
      return classGlyphs(el);
    case "fragment":
      return fragmentGlyphs(el);
    case "zone": {
      const text = el.label.split("\n")[0]?.trim() ?? "";
      return {
        texts: text
          ? [{ x: 12, y: 20, text: clip(text, charsFor(el.width - 24, 12, false)), anchor: "start", size: 12, weight: 600, font: "label", tone: "stroke" }]
          : [],
        badges: [],
      };
    }
    default:
      return null;
  }
}
