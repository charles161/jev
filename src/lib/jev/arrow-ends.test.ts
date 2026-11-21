import { describe, expect, it } from "vitest";
import {
  ARROW_END_GEOMETRY,
  computeArrowEndMarker,
  resolveArrowMarkers,
  type ArrowEndMarker,
} from "@/lib/jev/arrow-ends";
import { computeArrowHeadPath } from "@/lib/jev/rough-paths";
import { ARROW_ENDS, type ArrowEnd, type JevElement, type Point } from "@/lib/jev/types";

const ORIGIN: Point = { x: 0, y: 0 };
const TIP_RIGHT: Point = { x: 100, y: 0 };

function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Every coordinate pair in a path (ignores arc radii/flags by only reading M/L pairs). */
function lineVertices(d: string): Point[] {
  const out: Point[] = [];
  const re = /[ML] (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push({ x: Number(m[1]), y: Number(m[2]) });
  return out;
}

function circles(marker: ArrowEndMarker) {
  return marker.paths.filter((p) => p.d.includes(" A "));
}

function strokesOnly(marker: ArrowEndMarker) {
  return marker.paths.filter((p) => !p.d.includes(" A "));
}

function arrow(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: "a",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "",
    tone: "ink",
    seed: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("arrow end markers: every end produces finite geometry", () => {
  it.each(ARROW_ENDS.map((e) => [e]))("%s", (end) => {
    for (const tip of [TIP_RIGHT, { x: -40, y: 70 }, { x: 0, y: 0 }]) {
      const m = computeArrowEndMarker(end as ArrowEnd, ORIGIN, tip);
      for (const p of m.paths) {
        expect(p.d).not.toMatch(/NaN|Infinity/);
      }
      expect(Number.isFinite(m.inset)).toBe(true);
      expect(m.inset).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("UML ends", () => {
  it("none draws nothing and keeps the line full length", () => {
    expect(computeArrowEndMarker("none", ORIGIN, TIP_RIGHT)).toEqual({ paths: [], inset: 0 });
  });

  it("arrow is a closed head filled with the stroke, tip on the endpoint, body behind it", () => {
    const m = computeArrowEndMarker("arrow", ORIGIN, TIP_RIGHT);
    expect(m.paths).toHaveLength(1);
    expect(m.paths[0].fill).toBe("stroke");
    expect(m.paths[0].d.trim().endsWith("Z")).toBe(true);
    const v = lineVertices(m.paths[0].d);
    expect(v).toContainEqual({ x: 100, y: 0 });
    expect(Math.max(...v.map((p) => p.x))).toBe(100);
    expect(Math.min(...v.map((p) => p.x))).toBe(100 - ARROW_END_GEOMETRY.headLength);
  });

  it("open is an unfilled V (async / return message) that leaves the line touching the tip", () => {
    const m = computeArrowEndMarker("open", ORIGIN, TIP_RIGHT);
    expect(m.paths).toHaveLength(1);
    expect(m.paths[0].fill).toBe("none");
    expect(m.paths[0].d).not.toContain("Z");
    expect(m.inset).toBe(0);
    const v = lineVertices(m.paths[0].d);
    expect(v[1]).toEqual({ x: 100, y: 0 });
    expect(v[0].x).toBeLessThan(100);
    expect(v[2].x).toBeLessThan(100);
    expect(Math.sign(v[0].y)).toBe(-Math.sign(v[2].y));
  });

  it("triangle is a hollow closed triangle and the line stops at its base", () => {
    const m = computeArrowEndMarker("triangle", ORIGIN, TIP_RIGHT);
    expect(m.paths).toHaveLength(1);
    expect(m.paths[0].fill).toBe("paper");
    const v = lineVertices(m.paths[0].d);
    const { triangleLength, triangleHalfWidth } = ARROW_END_GEOMETRY;
    expect(v).toContainEqual({ x: 100, y: 0 });
    expect(v).toContainEqual({ x: 100 - triangleLength, y: triangleHalfWidth });
    expect(v).toContainEqual({ x: 100 - triangleLength, y: -triangleHalfWidth });
    expect(m.inset).toBe(triangleLength);
  });

  it("diamond is filled (composition), odiamond hollow (aggregation); both stop the line at the far vertex", () => {
    const filled = computeArrowEndMarker("diamond", ORIGIN, TIP_RIGHT);
    const hollow = computeArrowEndMarker("odiamond", ORIGIN, TIP_RIGHT);
    expect(filled.paths[0].fill).toBe("stroke");
    expect(hollow.paths[0].fill).toBe("paper");
    expect(filled.paths[0].d).toBe(hollow.paths[0].d);
    const v = lineVertices(hollow.paths[0].d);
    const { diamondLength, diamondHalfWidth } = ARROW_END_GEOMETRY;
    expect(v).toEqual([
      { x: 100, y: 0 },
      { x: 100 - diamondLength / 2, y: diamondHalfWidth },
      { x: 100 - diamondLength, y: 0 },
      { x: 100 - diamondLength / 2, y: -diamondHalfWidth },
    ]);
    expect(hollow.inset).toBe(diamondLength);
    expect(filled.inset).toBe(diamondLength);
  });
});

describe("crow's-foot ends (IE notation, drawn at the entity edge)", () => {
  const { crowLength, crowSpread, barHalf } = ARROW_END_GEOMETRY;

  function bars(m: ArrowEndMarker): number[] {
    return strokesOnly(m)
      .map((p) => lineVertices(p.d))
      .filter((v) => v.length === 2 && v[0].x === v[1].x)
      .map((v) => v[0].x);
  }

  function crows(m: ArrowEndMarker): Point[][] {
    return strokesOnly(m)
      .map((p) => lineVertices(p.d))
      .filter((v) => v.length === 2 && v[0].x !== v[1].x);
  }

  it("er_many is a three-prong crow whose prongs fan out onto the entity edge", () => {
    const m = computeArrowEndMarker("er_many", ORIGIN, TIP_RIGHT);
    const prongs = crows(m);
    expect(prongs).toHaveLength(3);
    for (const [from, to] of prongs) {
      expect(from).toEqual({ x: 100 - crowLength, y: 0 });
      expect(to.x).toBe(100);
    }
    expect(prongs.map(([, to]) => to.y).sort((a, b) => a - b)).toEqual([-crowSpread, 0, crowSpread]);
    expect(bars(m)).toEqual([]);
    expect(circles(m)).toHaveLength(0);
    expect(m.inset).toBe(0);
  });

  it("er_one is a single perpendicular bar; er_only_one two bars", () => {
    const one = computeArrowEndMarker("er_one", ORIGIN, TIP_RIGHT);
    expect(bars(one)).toHaveLength(1);
    const onlyOne = computeArrowEndMarker("er_only_one", ORIGIN, TIP_RIGHT);
    expect(bars(onlyOne)).toHaveLength(2);
    for (const p of strokesOnly(onlyOne)) {
      const [a, b] = lineVertices(p.d);
      expect(Math.abs(a.y - b.y)).toBe(barHalf * 2);
    }
    expect(crows(onlyOne)).toHaveLength(0);
  });

  it("er_zero_one is a bar next to the entity with a hollow circle further out", () => {
    const m = computeArrowEndMarker("er_zero_one", ORIGIN, TIP_RIGHT);
    const barX = bars(m);
    expect(barX).toHaveLength(1);
    const ring = circles(m);
    expect(ring).toHaveLength(1);
    expect(ring[0].fill).toBe("paper");
    const [r, , , , , nearX] = numbers(ring[0].d.split(" A ")[1]);
    expect(r).toBe(ARROW_END_GEOMETRY.circleRadius);
    expect(nearX).toBeLessThan(barX[0]);
  });

  it("er_one_many is a crow plus a bar outside it; er_zero_many a crow plus a circle outside it", () => {
    const oneMany = computeArrowEndMarker("er_one_many", ORIGIN, TIP_RIGHT);
    expect(crows(oneMany)).toHaveLength(3);
    expect(bars(oneMany)).toHaveLength(1);
    expect(bars(oneMany)[0]).toBeLessThan(100 - crowLength);

    const zeroMany = computeArrowEndMarker("er_zero_many", ORIGIN, TIP_RIGHT);
    expect(crows(zeroMany)).toHaveLength(3);
    expect(bars(zeroMany)).toHaveLength(0);
    expect(circles(zeroMany)).toHaveLength(1);
    expect(circles(zeroMany)[0].fill).toBe("paper");
  });

  it("reach pushes the whole marker onto the entity edge past the arrow's padded endpoint", () => {
    const m = computeArrowEndMarker("er_many", ORIGIN, TIP_RIGHT, { reach: 4 });
    for (const [from, to] of crows(m)) {
      expect(to.x).toBe(104);
      expect(from.x).toBe(104 - crowLength);
    }
  });

  it("is rotation invariant: a downward arrow gives the same marker rotated 90 degrees", () => {
    for (const end of ["er_one_many", "triangle", "arrow", "er_zero_one"] as const) {
      const right = computeArrowEndMarker(end, { x: 0, y: 0 }, { x: 100, y: 0 });
      const down = computeArrowEndMarker(end, { x: 0, y: 0 }, { x: 0, y: 100 });
      expect(down.paths).toHaveLength(right.paths.length);
      right.paths.forEach((rp, i) => {
        const rv = lineVertices(rp.d);
        const dv = lineVertices(down.paths[i].d);
        // rotate (x, y) about origin by +90deg: (x, y) -> (-y, x)
        expect(dv.map((p) => ({ x: p.x, y: p.y }))).toEqual(
          rv.map((p) => ({ x: Math.abs(p.y) < 1e-9 ? 0 : -p.y, y: p.x }))
        );
        expect(down.paths[i].fill).toBe(rp.fill);
      });
    }
  });
});

describe("resolveArrowMarkers", () => {
  const geom = { start: { x: 0, y: 0 }, control: { x: 50, y: 0 }, end: { x: 100, y: 0 } };

  it("legacy arrows (no explicit ends) keep today's exact chevron path and full-length line", () => {
    const r = resolveArrowMarkers(arrow(), geom);
    expect(r.end.paths).toEqual([{ d: computeArrowHeadPath(geom.control, geom.end, 8.5), fill: "none" }]);
    expect(r.start.paths).toEqual([]);
    expect(r.lineStart).toEqual(geom.start);
    expect(r.lineEnd).toEqual(geom.end);

    const both = resolveArrowMarkers(arrow({ bidirectional: true }), geom);
    expect(both.start.paths).toEqual([
      { d: computeArrowHeadPath(geom.control, geom.start, 8.5), fill: "none" },
    ]);
  });

  it("lifelines never get heads", () => {
    const r = resolveArrowMarkers(
      arrow({ morphMeta: { groupId: "g", notation: "sequence", role: "lifeline" } }),
      geom
    );
    expect(r.start.paths).toEqual([]);
    expect(r.end.paths).toEqual([]);
  });

  it("pulls the line back under hollow end markers so it does not poke through", () => {
    const r = resolveArrowMarkers(arrow({ endEnd: "triangle", startEnd: "odiamond" }), geom);
    expect(r.lineEnd.x).toBeCloseTo(100 - ARROW_END_GEOMETRY.triangleLength);
    expect(r.lineStart.x).toBeCloseTo(ARROW_END_GEOMETRY.diamondLength);
  });

  it("crow's-foot ends reach the entity edge only when that end is attached to a shape", () => {
    const attached = resolveArrowMarkers(arrow({ endEnd: "er_many", toId: "e2" }), geom);
    const loose = resolveArrowMarkers(arrow({ endEnd: "er_many" }), geom);
    const tipX = (m: ArrowEndMarker) => Math.max(...m.paths.flatMap((p) => lineVertices(p.d).map((v) => v.x)));
    expect(tipX(attached.end)).toBe(100 + ARROW_END_GEOMETRY.boundaryGap);
    expect(tipX(loose.end)).toBe(100);
  });
});
