import { distanceBetween, getElementCenter } from "./geometry";
import type { ElementBox, JevElement, Point } from "./types";

/**
 * Reads a finished freehand pen stroke (world coordinates) as a gesture: a connector between nodes,
 * a closed shape to turn into a node, or a lasso around nodes. Pure and deterministic. Every distance
 * threshold is a multiple of `strokeUnit` (the board's typical node size), so the same drawing reads the
 * same at any zoom and on boards with bigger or smaller nodes.
 */

export type StrokeShape = "node" | "database" | "diamond" | "ellipse";

export type StrokeReading =
  | { kind: "connect"; path: string[] }
  | { kind: "shape"; shape: StrokeShape; box: ElementBox; actor: boolean }
  | { kind: "lasso"; enclosedIds: string[] }
  | { kind: "none" };

export const STROKE_THRESHOLDS = {
  /** Node size used when the board has no nodes yet (the default node is 172×72). */
  defaultUnit: 72,
  /** Strokes shorter than this (× unit) are taps or ticks. */
  minLength: 0.75,
  /** An endpoint within this distance (× unit) of a node's box starts or ends at that node. */
  endpointReach: 0.5,
  /** A connector may be at most this many times longer than the straight route through its nodes. */
  maxDetour: 2,
  /** Closed: start and end within max(closeGap × unit, closeGapOfLength × stroke length). */
  closeGap: 0.6,
  closeGapOfLength: 0.2,
  /** Blobby: a looser end gap is fine when the loop fills this much of its bounding box. */
  blobGapOfLength: 0.35,
  blobFill: 0.45,
  /** Below this fill the "loop" is a line or a self-cancelling scribble. */
  minFill: 0.3,
  /** A simple loop is about as long as its convex hull; scribbles retrace and run much longer. */
  maxHullDetour: 1.5,
  maxSelfCrossings: 3,
  /** Shapes smaller than this (× unit) on their short side are ticks, not nodes. */
  minShapeSide: 0.4,
  /** Rectangle: the stroke reaches each bounding-box corner within this fraction of the short side. */
  rectCornerGap: 0.09,
  /** Rhombus: each extreme point sits within this fraction of the side from that side's midpoint. */
  rhombusMidpointSlack: 0.2,
  rhombusFill: [0.35, 0.65] as const,
  /** Tall (height / width) rounded loops are databases. */
  tallAspect: 1.25,
  /** Rounded loops filling less than this are ellipses; fuller ones are rounded boxes (nodes). */
  ellipseMaxFill: 0.85,
  /** Actor: a head loop of at least this length (× unit) that closes within headCloseGap × unit. */
  headMinLength: 1,
  headMaxLength: 4,
  headCloseGap: 0.25,
} as const;

const T = STROKE_THRESHOLDS;
const TARGET_KINDS = new Set<string>([
  "node", "diamond", "database", "ellipse",
  "queue", "cache", "lb", "blob", "external", "actor", "entity", "class",
]);

function targetsOf(elements: JevElement[]): JevElement[] {
  return elements.filter((e) => TARGET_KINDS.has(e.kind) && e.width > 0 && e.height > 0);
}

/** Median short side of the board's nodes, in world units. */
export function strokeUnit(elements: JevElement[]): number {
  const sides = targetsOf(elements)
    .map((e) => Math.min(e.width, e.height))
    .sort((a, b) => a - b);
  if (sides.length === 0) return T.defaultUnit;
  const mid = Math.floor(sides.length / 2);
  return sides.length % 2 ? sides[mid] : (sides[mid - 1] + sides[mid]) / 2;
}

function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distanceBetween(points[i - 1], points[i]);
  return len;
}

export function strokeBounds(points: Point[]): ElementBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boxDistance(p: Point, e: JevElement): number {
  const dx = Math.max(e.x - p.x, 0, p.x - (e.x + e.width));
  const dy = Math.max(e.y - p.y, 0, p.y - (e.y + e.height));
  return Math.hypot(dx, dy);
}

function nodeAt(p: Point, targets: JevElement[], reach: number): JevElement | undefined {
  let best: JevElement | undefined;
  let bestKey: [number, number] = [Infinity, Infinity];
  for (const t of targets) {
    const d = boxDistance(p, t);
    if (d > reach) continue;
    const key: [number, number] = [d, t.width * t.height];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

function polygonArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function hullPerimeter(points: Point[]): number {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pathLength(pts) * 2;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  return pathLength([...hull, hull[0]]);
}

function resample(points: Point[], n: number): Point[] {
  const total = pathLength(points);
  if (total === 0) return [points[0]];
  const step = total / (n - 1);
  const out: Point[] = [points[0]];
  let carried = 0;
  for (let i = 1; i < points.length && out.length < n; i++) {
    let a = points[i - 1];
    const b = points[i];
    let seg = distanceBetween(a, b);
    while (carried + seg >= step && out.length < n) {
      const t = (step - carried) / seg;
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(a);
      seg = distanceBetween(a, b);
      carried = 0;
    }
    carried += seg;
  }
  if (out.length < n) out.push(points[points.length - 1]);
  return out;
}

function selfCrossings(points: Point[]): number {
  const pts = resample(points, 64);
  const orient = (a: Point, b: Point, c: Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  let count = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      const [a, b, c, d] = [pts[i], pts[i + 1], pts[j], pts[j + 1]];
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) count += 1;
    }
  }
  return count;
}

function readConnect(points: Point[], targets: JevElement[], unit: number, length: number): StrokeReading | null {
  const reach = T.endpointReach * unit;
  const start = nodeAt(points[0], targets, reach);
  const end = nodeAt(points[points.length - 1], targets, reach);
  if (!start || !end || start.id === end.id) return null;
  const through: JevElement[] = [];
  for (const p of points) {
    const hit = targets.find((t) => t.id !== start.id && t.id !== end.id && boxDistance(p, t) === 0);
    if (hit && !through.includes(hit)) through.push(hit);
  }
  const route = pathLength([points[0], ...through.map(getElementCenter), points[points.length - 1]]);
  if (length > T.maxDetour * route) return { kind: "none" };
  return { kind: "connect", path: [start.id, ...through.map((t) => t.id), end.id] };
}

/** A small loop drawn first (or last), with the rest of the stroke hanging below it: a stick figure. */
function readActor(points: Point[], unit: number): ElementBox | null {
  let len = 0;
  let k = -1;
  for (let i = 1; i < points.length; i++) {
    len += distanceBetween(points[i - 1], points[i]);
    if (len > T.headMaxLength * unit) break;
    if (len >= T.headMinLength * unit && distanceBetween(points[i], points[0]) <= T.headCloseGap * unit) {
      k = i;
      break;
    }
  }
  if (k < 0) return null;
  const head = strokeBounds(points.slice(0, k + 1));
  const rest = points.slice(k);
  if (rest.length < 3 || pathLength(rest) < T.headMinLength * unit) return null;
  const all = strokeBounds(points);
  const aspect = head.height / Math.max(head.width, 1);
  const headBottom = head.y + head.height;
  const below = rest.filter((p) => p.y >= head.y + head.height / 2).length / rest.length;
  const ok =
    aspect >= 0.5 &&
    aspect <= 2 &&
    head.height <= 0.45 * all.height &&
    head.y - all.y <= 0.1 * all.height &&
    all.y + all.height - headBottom >= 1.5 * head.height &&
    below >= 0.85;
  return ok ? all : null;
}

function classifyLoop(points: Point[], box: ElementBox, fill: number): StrokeShape {
  const { x, y, width: w, height: h } = box;
  const short = Math.min(w, h);
  const extreme = (pick: (a: Point, b: Point) => boolean) => points.reduce((m, p) => (pick(p, m) ? p : m));
  const left = extreme((p, m) => p.x < m.x);
  const right = extreme((p, m) => p.x > m.x);
  const top = extreme((p, m) => p.y < m.y);
  const bottom = extreme((p, m) => p.y > m.y);
  const midX = x + w / 2;
  const midY = y + h / 2;
  const s = T.rhombusMidpointSlack;
  const rhombus =
    fill >= T.rhombusFill[0] &&
    fill <= T.rhombusFill[1] &&
    Math.abs(left.y - midY) <= s * h &&
    Math.abs(right.y - midY) <= s * h &&
    Math.abs(top.x - midX) <= s * w &&
    Math.abs(bottom.x - midX) <= s * w;
  if (rhombus) return "diamond";

  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  const cornerGap =
    corners.reduce((sum, c) => sum + Math.min(...points.map((p) => distanceBetween(p, c))), 0) / 4 / short;
  if (cornerGap <= T.rectCornerGap) return "node";
  if (h / w >= T.tallAspect) return "database";
  return fill < T.ellipseMaxFill ? "ellipse" : "node";
}

export function recognizeStroke(points: Point[], elements: JevElement[]): StrokeReading {
  const none: StrokeReading = { kind: "none" };
  if (points.length < 3) return none;
  const unit = strokeUnit(elements);
  const length = pathLength(points);
  if (length < T.minLength * unit) return none;
  const targets = targetsOf(elements);

  const connect = readConnect(points, targets, unit, length);
  if (connect) return connect;

  const actor = readActor(points, unit) ?? readActor([...points].reverse(), unit);
  if (actor) return { kind: "shape", shape: "ellipse", box: roundBox(actor), actor: true };

  const box = strokeBounds(points);
  if (Math.min(box.width, box.height) < T.minShapeSide * unit) return none;
  const gap = distanceBetween(points[0], points[points.length - 1]);
  const fill = polygonArea(points) / (box.width * box.height);
  const closed =
    gap <= Math.max(T.closeGap * unit, T.closeGapOfLength * length) ||
    (fill >= T.blobFill && gap <= T.blobGapOfLength * length);
  const simple =
    fill >= T.minFill &&
    length <= T.maxHullDetour * hullPerimeter(points) &&
    selfCrossings(points) <= T.maxSelfCrossings;
  if (!closed || !simple) return none;

  const enclosed = targets.filter((t) => pointInPolygon(getElementCenter(t), points));
  if (enclosed.length >= 2) return { kind: "lasso", enclosedIds: enclosed.map((t) => t.id) };
  if (enclosed.length === 1) return none;
  return { kind: "shape", shape: classifyLoop(points, box, fill), box: roundBox(box), actor: false };
}

function roundBox(b: ElementBox): ElementBox {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}
