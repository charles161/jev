import type { Point, Viewport } from "./types";

export const ZOOM_MIN = 0.28;
export const ZOOM_MAX = 2.6;
export const ZOOM_STEP_IN = 1.14;
export const ZOOM_STEP_OUT = 1 / ZOOM_STEP_IN;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Scales the viewport by `factor`, keeping the world point under the screen `anchor` fixed. */
export function zoomAroundPoint(v: Viewport, factor: number, anchor: Point): Viewport {
  const zoom = clampZoom(v.zoom * factor);
  const ratio = zoom / v.zoom;
  return {
    zoom,
    x: anchor.x - (anchor.x - v.x) * ratio,
    y: anchor.y - (anchor.y - v.y) * ratio,
  };
}

/** Ctrl/Cmd + wheel (trackpad pinch arrives as ctrl+wheel) zooms around the cursor; a plain wheel pans. */
export function wheelViewport(
  v: Viewport,
  e: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean },
  cursor: Point
): Viewport {
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.0022);
    return zoomAroundPoint(v, factor, cursor);
  }
  return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
}

export type ZoomKeyAction = "in" | "out" | "reset" | "fit";

export function zoomKeyAction(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): ZoomKeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === "=" || e.key === "+")) return "in";
  if (mod && (e.key === "-" || e.key === "_")) return "out";
  if (mod && e.key === "0") return "reset";
  if (!mod && e.shiftKey && e.code === "Digit1") return "fit";
  return null;
}
