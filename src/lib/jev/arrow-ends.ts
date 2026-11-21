import { isCrowsFootEnd, resolveArrowEnds } from "./notation-kinds";
import { computeArrowHeadPath } from "./rough-paths";
import type { ArrowEnd, JevElement, Point } from "./types";

/** "stroke" = solid head, "paper" = hollow (filled with the board colour so the line is hidden), "none" = open. */
export type MarkerFill = "stroke" | "paper" | "none";

export interface MarkerPath {
  d: string;
  fill: MarkerFill;
}

export interface ArrowEndMarker {
  paths: MarkerPath[];
  /** How far the line must stop short of the tip so it does not show through the marker. */
  inset: number;
}

export const ARROW_END_GEOMETRY = {
  headLength: 11,
  headHalfWidth: 5,
  openLength: 11,
  openHalfWidth: 6,
  triangleLength: 14,
  triangleHalfWidth: 8,
  diamondLength: 20,
  diamondHalfWidth: 6.5,
  crowLength: 14,
  crowSpread: 8,
  barHalf: 8,
  firstBar: 7,
  secondBar: 13,
  outerBar: 19,
  circleRadius: 4.5,
  /** Distance getBoundaryPoint keeps between an arrow end and its shape. */
  boundaryGap: 4,
} as const;

const G = ARROW_END_GEOMETRY;

function fmt(n: number): string {
  const s = n.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}

export interface ArrowEndOptions {
  /** Push the marker this far past `tip` (onto the shape edge). */
  reach?: number;
}

/**
 * End marker geometry for an arrow arriving at `tip` from the direction of `from`
 * (the last control point). Coordinates are world units.
 */
export function computeArrowEndMarker(
  end: ArrowEnd,
  from: Point,
  tip: Point,
  opts: ArrowEndOptions = {}
): ArrowEndMarker {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  const ux = len > 0 ? dx / len : 1;
  const uy = len > 0 ? dy / len : 0;
  const reach = opts.reach ?? 0;
  const ox = tip.x + ux * reach;
  const oy = tip.y + uy * reach;
  // a = distance back from the tip along the line, b = offset to the side
  const P = (a: number, b: number) => `${fmt(ox - a * ux - b * uy)} ${fmt(oy - a * uy + b * ux)}`;
  const seg = (a1: number, b1: number, a2: number, b2: number): MarkerPath => ({
    d: `M ${P(a1, b1)} L ${P(a2, b2)}`,
    fill: "none",
  });
  const bar = (a: number) => seg(a, -G.barHalf, a, G.barHalf);
  const crow = (): MarkerPath[] => [
    seg(G.crowLength, 0, 0, -G.crowSpread),
    seg(G.crowLength, 0, 0, 0),
    seg(G.crowLength, 0, 0, G.crowSpread),
  ];
  const circle = (a: number): MarkerPath => {
    const r = G.circleRadius;
    return {
      d: `M ${P(a + r, 0)} A ${r} ${r} 0 1 0 ${P(a - r, 0)} A ${r} ${r} 0 1 0 ${P(a + r, 0)} Z`,
      fill: "paper",
    };
  };

  switch (end) {
    case "none":
      return { paths: [], inset: 0 };
    case "arrow":
      return {
        paths: [
          {
            d: `M ${P(0, 0)} L ${P(G.headLength, G.headHalfWidth)} L ${P(G.headLength, -G.headHalfWidth)} Z`,
            fill: "stroke",
          },
        ],
        inset: G.headLength - 2,
      };
    case "open":
      return {
        paths: [
          {
            d: `M ${P(G.openLength, G.openHalfWidth)} L ${P(0, 0)} L ${P(G.openLength, -G.openHalfWidth)}`,
            fill: "none",
          },
        ],
        inset: 0,
      };
    case "triangle":
      return {
        paths: [
          {
            d: `M ${P(0, 0)} L ${P(G.triangleLength, G.triangleHalfWidth)} L ${P(G.triangleLength, -G.triangleHalfWidth)} Z`,
            fill: "paper",
          },
        ],
        inset: G.triangleLength,
      };
    case "diamond":
    case "odiamond":
      return {
        paths: [
          {
            d: `M ${P(0, 0)} L ${P(G.diamondLength / 2, G.diamondHalfWidth)} L ${P(G.diamondLength, 0)} L ${P(G.diamondLength / 2, -G.diamondHalfWidth)} Z`,
            fill: end === "diamond" ? "stroke" : "paper",
          },
        ],
        inset: G.diamondLength,
      };
    case "er_one":
      return { paths: [bar(G.firstBar + 3)], inset: 0 };
    case "er_only_one":
      return { paths: [bar(G.firstBar), bar(G.secondBar)], inset: 0 };
    case "er_zero_one":
      return { paths: [bar(G.firstBar), circle(G.secondBar + G.circleRadius + 3)], inset: 0 };
    case "er_many":
      return { paths: crow(), inset: 0 };
    case "er_one_many":
      return { paths: [...crow(), bar(G.outerBar)], inset: 0 };
    case "er_zero_many":
      return { paths: [...crow(), circle(G.outerBar + G.circleRadius)], inset: 0 };
  }
}

export interface ResolvedArrowMarkers {
  start: ArrowEndMarker;
  end: ArrowEndMarker;
  /** Where the line itself should start/end after pulling back under hollow markers. */
  lineStart: Point;
  lineEnd: Point;
}

const LEGACY_HEAD_SIZE = 8.5;

function legacyHead(from: Point, tip: Point): ArrowEndMarker {
  return { paths: [{ d: computeArrowHeadPath(from, tip, LEGACY_HEAD_SIZE), fill: "none" }], inset: 0 };
}

function pullBack(tip: Point, from: Point, inset: number): Point {
  if (inset <= 0) return tip;
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len <= inset) return tip;
  return { x: tip.x - (dx / len) * inset, y: tip.y - (dy / len) * inset };
}

/**
 * Both end markers of an arrow plus the trimmed line ends. Arrows without explicit ends
 * keep the original chevron so boards drawn before end markers render unchanged.
 */
export function resolveArrowMarkers(
  arrow: Pick<JevElement, "startEnd" | "endEnd" | "bidirectional" | "morphMeta" | "fromId" | "toId">,
  geom: { start: Point; control: Point; end: Point }
): ResolvedArrowMarkers {
  const ends = resolveArrowEnds(arrow);
  const isLifeline = arrow.morphMeta?.role === "lifeline";
  const marker = (end: ArrowEnd, explicit: boolean, tip: Point, attached: boolean): ArrowEndMarker => {
    if (end === "none") return { paths: [], inset: 0 };
    if (!explicit) return legacyHead(geom.control, tip);
    return computeArrowEndMarker(end, geom.control, tip, {
      reach: attached && isCrowsFootEnd(end) ? G.boundaryGap : 0,
    });
  };
  const start = isLifeline
    ? { paths: [], inset: 0 }
    : marker(ends.start, arrow.startEnd !== undefined, geom.start, Boolean(arrow.fromId));
  const end = isLifeline
    ? { paths: [], inset: 0 }
    : marker(ends.end, arrow.endEnd !== undefined, geom.end, Boolean(arrow.toId));
  return {
    start,
    end,
    lineStart: pullBack(geom.start, geom.control, start.inset),
    lineEnd: pullBack(geom.end, geom.control, end.inset),
  };
}
