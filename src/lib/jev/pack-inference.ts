import { getElementCenter, isShapeElement } from "./geometry";
import { cardinalityToEnds, DEFAULT_KIND_SIZE, isContainerKind, isCrowsFootEnd } from "./notation-kinds";
import type { PackId } from "./notation-packs";
import type { JevElement, Point } from "./types";

export type PackChipKind = "er-entity" | "crows-foot" | "sequence" | "state";

export interface PackChip {
  /** `${kind}:${elementId}`, the key a dismissal is remembered under. */
  id: string;
  kind: PackChipKind;
  /** The element the chip sits next to. */
  elementId: string;
  elementIds: string[];
  title: string;
  /** World point the chip is anchored to. */
  anchor: Point;
}

export type PackChipAction =
  | { type: "patch"; id: string; patch: Partial<JevElement>; openPack?: PackId }
  | { type: "morph"; notation: "state"; ids: string[] }
  | { type: "open-pack"; pack: PackId };

const CHIP_TITLES: Record<PackChipKind, string> = {
  "er-entity": "ER pack: turn into entity with PK/FK",
  "crows-foot": "Crow's foot",
  sequence: "Sequence pack",
  state: "State pack",
};

const TABLE_NAMES = new Set([
  "users", "user", "accounts", "orders", "order_items", "line_items", "items", "products", "payments", "invoices",
  "customers", "sessions", "posts", "comments", "likes", "followers", "follows", "messages", "conversations",
  "carts", "cart_items", "tags", "events", "urls", "links", "tweets", "photos", "videos", "notifications",
  "transactions", "subscriptions", "addresses", "reviews", "bookings", "reservations", "tickets", "rides",
  "drivers", "restaurants", "menus", "inventory", "shipments", "refunds", "wallets", "ledger_entries",
]);

const STATE_WORDS = new Set([
  "pending", "paid", "unpaid", "shipped", "delivered", "cancelled", "canceled", "created", "new", "active",
  "inactive", "failed", "completed", "complete", "refunded", "draft", "open", "closed", "approved", "rejected",
  "submitted", "processing", "authorized", "captured", "expired", "suspended", "archived", "published",
  "confirmed", "placed", "in_transit", "returned", "idle", "running", "stopped", "done", "queued", "settled",
  "disputed", "verified", "locked", "blocked", "deleted", "scheduled", "accepted", "declined", "on_hold",
]);

function words(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function tableName(label: string): string | null {
  const l = words(label);
  if (!l) return null;
  const hasTableWord = /\b(?:tables?|tbl)\b/.test(l);
  const bare = l.replace(/\b(?:tables?|tbl)\b/g, " ").trim().replace(/[\s-]+/g, "_");
  if (!bare) return null;
  if (hasTableWord && /^[a-z][a-z0-9_]*$/.test(bare)) return bare;
  return TABLE_NAMES.has(bare) ? bare : null;
}

function isStateWord(label: string): boolean {
  return STATE_WORDS.has(words(label).replace(/[\s-]+/g, "_"));
}

const isLoose = (el: JevElement) => !el.morphMeta || el.morphMeta.notation === "sketch";

function endpoint(arrow: JevElement, end: "from" | "to", byId: Map<string, JevElement>): Point | null {
  const id = end === "from" ? arrow.fromId : arrow.toId;
  const shape = id ? byId.get(id) : undefined;
  if (shape) return getElementCenter(shape);
  return (end === "from" ? arrow.fromPoint : arrow.toPoint) ?? null;
}

interface Segment {
  a: Point;
  b: Point;
}

function lineOf(el: JevElement, byId: Map<string, JevElement>): Segment | null {
  if (el.kind === "arrow") {
    const a = endpoint(el, "from", byId);
    const b = endpoint(el, "to", byId);
    return a && b ? { a, b } : null;
  }
  if (el.kind === "freedraw" && el.points && el.points.length >= 2) {
    return { a: el.points[0], b: el.points[el.points.length - 1] };
  }
  return null;
}

function isVertical(s: Segment): boolean {
  return Math.abs(s.b.x - s.a.x) <= 24 && Math.abs(s.b.y - s.a.y) >= 80;
}

function isHorizontal(s: Segment): boolean {
  const dx = Math.abs(s.b.x - s.a.x);
  return dx >= 60 && Math.abs(s.b.y - s.a.y) <= dx * 0.25;
}

/** A shape with a vertical line hanging from its bottom edge: the lifeline's x, or null. */
function lifelineX(shape: JevElement, verticals: Segment[]): number | null {
  const bottom = shape.y + shape.height;
  for (const v of verticals) {
    const top = v.a.y < v.b.y ? v.a : v.b;
    const x = (v.a.x + v.b.x) / 2;
    if (x >= shape.x - 12 && x <= shape.x + shape.width + 12 && top.y >= bottom - 12 && top.y <= bottom + 48) return x;
  }
  return null;
}

function sequenceChip(shapes: JevElement[], lines: Array<{ el: JevElement; seg: Segment }>): PackChip | null {
  const verticals = lines.filter((l) => isVertical(l.seg)).map((l) => l.seg);
  if (verticals.length < 2) return null;
  const lifelines = shapes
    .map((s) => ({ s, x: lifelineX(s, verticals) }))
    .filter((l): l is { s: JevElement; x: number } => l.x !== null);
  for (const head of lifelines) {
    const row = lifelines.filter((l) => Math.abs(getElementCenter(l.s).y - getElementCenter(head.s).y) <= 40);
    if (row.length < 2) continue;
    const near = (x: number) => row.find((l) => Math.abs(l.x - x) <= 24);
    const hasMessage = lines.some(({ el, seg }) => {
      if (!el.label.trim() || !isHorizontal(seg)) return false;
      const from = near(seg.a.x);
      const to = near(seg.b.x);
      return Boolean(from && to && from !== to);
    });
    if (!hasMessage) continue;
    const ordered = [...row].sort((a, b) => a.s.x - b.s.x);
    const first = ordered[0].s;
    return {
      id: `sequence:${first.id}`,
      kind: "sequence",
      elementId: first.id,
      elementIds: ordered.map((l) => l.s.id),
      title: CHIP_TITLES.sequence,
      anchor: { x: first.x, y: first.y },
    };
  }
  return null;
}

function chip(kind: PackChipKind, el: JevElement, anchor: Point, elementIds = [el.id]): PackChip {
  return { id: `${kind}:${el.id}`, kind, elementId: el.id, elementIds, title: CHIP_TITLES[kind], anchor };
}

const STATE_ARROW_LABEL = /^\s*([a-z][a-z _-]*?)\s*(?:->|→|=>)\s*([a-z][a-z _-]*?)(?:\s*(?:->|→|=>)\s*[a-z][a-z _-]*?)*\s*$/i;

/**
 * Quiet pack hints from what the user drew: a table-named database → ER entity, a cardinality label →
 * crow's foot, lifelines with messages → Sequence pack, state names → State pack. Most recent element first,
 * at most one chip per element, dismissed chip ids skipped.
 */
export function inferPackChips(elements: JevElement[], opts: { dismissed?: ReadonlySet<string> } = {}): PackChip[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const loose = elements.filter(isLoose);
  const shapes = loose.filter((e) => isShapeElement(e) && !isContainerKind(e.kind));
  const lines = loose
    .map((el) => ({ el, seg: lineOf(el, byId) }))
    .filter((l): l is { el: JevElement; seg: Segment } => l.seg !== null);
  const out: PackChip[] = [];

  for (const s of shapes) {
    if ((s.kind === "database" || s.kind === "node") && tableName(s.label)) {
      out.push(chip("er-entity", s, { x: s.x + s.width, y: s.y }));
    } else if (STATE_ARROW_LABEL.test(s.label)) {
      const m = s.label.match(STATE_ARROW_LABEL)!;
      if (isStateWord(m[1]) && isStateWord(m[2])) out.push(chip("state", s, { x: s.x + s.width, y: s.y }));
    }
  }

  for (const { el, seg } of lines) {
    if (el.kind !== "arrow") continue;
    const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
    if (!isCrowsFootEnd(el.startEnd) && !isCrowsFootEnd(el.endEnd) && cardinalityToEnds(el.label)) {
      out.push(chip("crows-foot", el, mid));
      continue;
    }
    const from = el.fromId ? byId.get(el.fromId) : undefined;
    const to = el.toId ? byId.get(el.toId) : undefined;
    if (from && to && isLoose(from) && isLoose(to) && isStateWord(from.label) && isStateWord(to.label)) {
      out.push(chip("state", el, { x: from.x + from.width, y: from.y }, [from.id, to.id]));
    }
  }

  const seq = sequenceChip(shapes, lines);
  if (seq) out.push(seq);

  const recency = (c: PackChip) => byId.get(c.elementId)?.updatedAt ?? 0;
  const seen = new Set<string>();
  return out
    .filter((c) => !opts.dismissed?.has(c.id))
    .sort((a, b) => recency(b) - recency(a))
    .filter((c) => {
      if (seen.has(c.elementId)) return false;
      seen.add(c.elementId);
      return true;
    });
}

/** The ER conversion of a table-named shape: an entity named after the table with an id PK row, same centre. */
export function tableEntityPatch(el: JevElement): Partial<JevElement> {
  const size = DEFAULT_KIND_SIZE.entity;
  const c = getElementCenter(el);
  return {
    kind: "entity",
    label: tableName(el.label) ?? words(el.label).replace(/\s+/g, "_"),
    sublabel: "id uuid PK\ncreated_at timestamptz",
    x: Math.round(c.x - size.width / 2),
    y: Math.round(c.y - size.height / 2),
    width: size.width,
    height: size.height,
  };
}

export function packChipAction(chip: PackChip, elements: JevElement[]): PackChipAction | null {
  const el = elements.find((e) => e.id === chip.elementId);
  if (!el) return null;
  switch (chip.kind) {
    case "er-entity":
      return { type: "patch", id: el.id, patch: tableEntityPatch(el), openPack: "er" };
    case "crows-foot": {
      const ends = cardinalityToEnds(el.label);
      return ends ? { type: "patch", id: el.id, patch: { ...ends, label: "" } } : null;
    }
    case "sequence":
      return { type: "open-pack", pack: "sequence" };
    case "state":
      return chip.elementIds.length >= 2 && el.kind === "arrow"
        ? { type: "morph", notation: "state", ids: chip.elementIds }
        : { type: "open-pack", pack: "state" };
  }
}
