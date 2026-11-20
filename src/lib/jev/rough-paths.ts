import rough from "roughjs";
import type { Options, PathInfo } from "roughjs/bin/core";
import { JevElement, Point, RenderStyle } from "./types";

const gen = rough.generator();

function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): string {
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h - radius}`,
    `Q ${x + w} ${y + h} ${x + w - radius} ${y + h}`,
    `L ${x + radius} ${y + h}`,
    `Q ${x} ${y + h} ${x} ${y + h - radius}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    "Z",
  ].join(" ");
}

export function generateShapePaths(
  el: JevElement,
  stroke: string,
  fill: string,
  renderStyle: RenderStyle,
  isGhost = false
): PathInfo[] {
  const w = Math.max(20, el.width);
  const h = Math.max(20, el.height);

  if (renderStyle === "clean" || isGhost) {
    if (el.kind === "node") {
      return [
        {
          d: roundedRectPath(0, 0, w, h, 12),
          stroke,
          strokeWidth: isGhost ? 1.8 : 1.75,
          fill,
        },
      ];
    }
    if (el.kind === "frame") {
      return [
        {
          d: roundedRectPath(0, 0, w, h, 16),
          stroke,
          strokeWidth: 1.5,
          fill,
        },
      ];
    }
    if (el.kind === "diamond") {
      return [
        {
          d: `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`,
          stroke,
          strokeWidth: isGhost ? 1.8 : 1.75,
          fill,
        },
      ];
    }
    if (el.kind === "ellipse") {
      const rx = w / 2;
      const ry = h / 2;
      return [
        {
          d: `M ${rx} 0 A ${rx} ${ry} 0 1 0 ${rx} ${h} A ${rx} ${ry} 0 1 0 ${rx} 0 Z`,
          stroke,
          strokeWidth: isGhost ? 1.8 : 1.75,
          fill,
        },
      ];
    }
    if (el.kind === "database") {
      const ry = Math.min(13, h * 0.18);
      const rx = w / 2;
      const body = [
        `M 0 ${ry}`,
        `A ${rx} ${ry} 0 0 1 ${w} ${ry}`,
        `L ${w} ${h - ry}`,
        `A ${rx} ${ry} 0 0 1 0 ${h - ry}`,
        `Z`,
      ].join(" ");
      const topCap = `M 0 ${ry} A ${rx} ${ry} 0 0 0 ${w} ${ry}`;
      return [
        { d: body, stroke, strokeWidth: 1.75, fill },
        { d: topCap, stroke, strokeWidth: 1.5, fill: "none" },
      ];
    }
    return [];
  }

  // Hand-drafted RoughJS sketch rendering
  const baseOpts: Options = {
    seed: el.seed,
    roughness: el.kind === "frame" ? 0.9 : 1.35,
    bowing: 1.15,
    stroke,
    strokeWidth: el.kind === "frame" ? 1.35 : 1.85,
    fill,
    fillStyle: el.kind === "frame" ? "solid" : "hachure",
    fillWeight: 0.75,
    hachureGap: 7.5,
    hachureAngle: -41,
  };

  if (el.kind === "node") {
    const drawable = gen.path(roundedRectPath(0, 0, w, h, 11), {
      ...baseOpts,
      fillStyle: "solid",
    });
    const hatchOverlay = gen.rectangle(3, 3, w - 6, h - 6, {
      ...baseOpts,
      stroke: "none",
      fill,
      fillStyle: "hachure",
      hachureGap: 9,
      fillWeight: 0.55,
    });
    return [...gen.toPaths(drawable), ...gen.toPaths(hatchOverlay)];
  }

  if (el.kind === "frame") {
    const drawable = gen.path(roundedRectPath(0, 0, w, h, 14), {
      ...baseOpts,
      strokeLineDash: [8, 6],
      fillStyle: "solid",
    });
    return gen.toPaths(drawable);
  }

  if (el.kind === "diamond") {
    const drawable = gen.polygon(
      [
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
      ],
      {
        ...baseOpts,
        fillStyle: "solid",
      }
    );
    return gen.toPaths(drawable);
  }

  if (el.kind === "ellipse") {
    const drawable = gen.ellipse(w / 2, h / 2, w, h, {
      ...baseOpts,
      fillStyle: "solid",
    });
    return gen.toPaths(drawable);
  }

  if (el.kind === "database") {
    const ry = Math.min(13, h * 0.18);
    const rx = w / 2;
    const bodyD = [
      `M 0 ${ry}`,
      `A ${rx} ${ry} 0 0 1 ${w} ${ry}`,
      `L ${w} ${h - ry}`,
      `A ${rx} ${ry} 0 0 1 0 ${h - ry}`,
      "Z",
    ].join(" ");
    const body = gen.path(bodyD, { ...baseOpts, fillStyle: "solid" });
    const topRim = gen.ellipse(w / 2, ry, w, ry * 2, {
      ...baseOpts,
      fill: "none",
      roughness: 1.0,
    });
    return [...gen.toPaths(body), ...gen.toPaths(topRim)];
  }

  return [];
}

export function generateArrowPath(
  start: Point,
  control: Point,
  end: Point,
  seed: number,
  stroke: string,
  renderStyle: RenderStyle,
  dashed?: boolean,
  isGhost = false
): PathInfo[] {
  const d = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
  if (renderStyle === "clean" || isGhost) {
    return [
      {
        d,
        stroke,
        strokeWidth: isGhost ? 1.5 : 1.35,
        fill: "none",
      },
    ];
  }
  const drawable = gen.path(d, {
    seed,
    roughness: 0.65,
    bowing: 0.55,
    stroke,
    strokeWidth: 1.4,
    strokeLineDash: dashed ? [6, 5] : undefined,
  });
  return gen.toPaths(drawable);
}

export function computeArrowHeadPath(from: Point, to: Point, size = 8.5): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const a1 = angle - Math.PI / 6.2;
  const a2 = angle + Math.PI / 6.2;
  const x1 = to.x - size * Math.cos(a1);
  const y1 = to.y - size * Math.sin(a1);
  const x2 = to.x - size * Math.cos(a2);
  const y2 = to.y - size * Math.sin(a2);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

export function smoothFreedrawPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.1} ${points[0].y + 0.1}`;
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}
