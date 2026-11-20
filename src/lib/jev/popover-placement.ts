import {
  isShapeElement,
  Rect,
  resolveArrowEndpoints,
} from "./geometry";
import { JevElement, Viewport } from "./types";

export type PopoverSide = "top" | "right" | "left" | "bottom";

export interface PopoverPlacement {
  x: number;
  y: number;
  side: PopoverSide;
  /** Screen coordinate on the target edge to point a subtle indicator toward */
  anchorX: number;
  anchorY: number;
}

function overlapArea(a: Rect, b: Rect): number {
  const xOverlap = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const yOverlap = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  return xOverlap * yOverlap;
}

/**
 * Computes the screen-space bounding box of any whiteboard element
 * (shape, frame, text, arrow midpoint, or freedraw stroke) at the current zoom & pan.
 */
export function getElementScreenRect(
  el: JevElement,
  elementsById: Map<string, JevElement>,
  viewport: Viewport
): Rect {
  if (el.kind === "arrow") {
    const { start, control, end } = resolveArrowEndpoints(el, elementsById);
    const midX = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
    const midY = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;
    const sx = viewport.x + midX * viewport.zoom;
    const sy = viewport.y + midY * viewport.zoom;
    return { x: sx - 20, y: sy - 16, width: 40, height: 32 };
  }

  if (el.kind === "freedraw" && el.points && el.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of el.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      x: viewport.x + minX * viewport.zoom,
      y: viewport.y + minY * viewport.zoom,
      width: Math.max(24, (maxX - minX) * viewport.zoom),
      height: Math.max(24, (maxY - minY) * viewport.zoom),
    };
  }

  return {
    x: viewport.x + el.x * viewport.zoom,
    y: viewport.y + el.y * viewport.zoom,
    width: Math.max(28, el.width * viewport.zoom),
    height: Math.max(24, el.height * viewport.zoom),
  };
}

/**
 * Finds the clearest, non-overlapping screen position for the element edit popover.
 * Respects current zoom & pan, top toolbar, bottom Thought Bar / Prediction HUD,
 * the clicked element itself, neighboring canvas elements, and active ghost previews.
 */
export function computeSmartPopoverPlacement(params: {
  element: JevElement;
  allElements: JevElement[];
  ghostElements: JevElement[];
  viewport: Viewport;
  screenWidth: number;
  screenHeight: number;
  popoverWidth: number;
  popoverHeight: number;
  hasPredictionHud: boolean;
}): PopoverPlacement {
  const {
    element,
    allElements,
    ghostElements,
    viewport,
    screenWidth,
    screenHeight,
    popoverWidth,
    popoverHeight,
    hasPredictionHud,
  } = params;

  const byId = new Map(allElements.map((e) => [e.id, e]));
  const rawTarget = getElementScreenRect(element, byId, viewport);

  // Safe inner viewport excluding floating top bar and bottom HUDs
  const margin = 14;
  const topSafe = 76;
  const bottomSafe = hasPredictionHud ? 216 : 92;
  const minX = margin;
  const maxX = Math.max(minX, screenWidth - margin - popoverWidth);
  const minY = topSafe;
  const maxY = Math.max(minY, screenHeight - bottomSafe - popoverHeight);

  // For frames, anchor cleanly near the frame's top-left header bar instead of blocking its interior
  const anchorTarget: Rect =
    element.kind === "frame"
      ? {
          x: rawTarget.x,
          y: rawTarget.y,
          width: Math.min(rawTarget.width, 220),
          height: Math.min(rawTarget.height, 34),
        }
      : rawTarget;

  // Clamp visible anchor when zoomed way in so the popover stays near the visible portion
  const visLeft = Math.max(minX, Math.min(screenWidth - margin, anchorTarget.x));
  const visRight = Math.max(
    minX,
    Math.min(screenWidth - margin, anchorTarget.x + anchorTarget.width)
  );
  const visTop = Math.max(minY, Math.min(screenHeight - bottomSafe, anchorTarget.y));
  const visBottom = Math.max(
    minY,
    Math.min(screenHeight - bottomSafe, anchorTarget.y + anchorTarget.height)
  );

  const centerX = (visLeft + visRight) / 2;
  const centerY = (visTop + visBottom) / 2;

  // Breathing gap scales gently with zoom so handles stay completely clickable
  const gap = Math.round(Math.max(14, Math.min(24, 14 + viewport.zoom * 4)));

  // Screen rects of obstacles (other shapes + active ghost previews)
  const obstacleRects: Rect[] = [];
  for (const other of allElements) {
    if (other.id === element.id || !isShapeElement(other) || other.kind === "frame") {
      continue;
    }
    obstacleRects.push(getElementScreenRect(other, byId, viewport));
  }
  for (const ghost of ghostElements) {
    if (!isShapeElement(ghost) || ghost.kind === "frame") continue;
    obstacleRects.push(getElementScreenRect(ghost, byId, viewport));
  }

  // Padded target rect so we avoid covering the clicked element & its 4 edge handles
  const selfExclusion: Rect = {
    x: anchorTarget.x - 10,
    y: anchorTarget.y - 10,
    width: anchorTarget.width + 20,
    height: anchorTarget.height + 20,
  };

  interface Candidate {
    side: PopoverSide;
    idealX: number;
    idealY: number;
    bias: number;
  }

  const candidates: Candidate[] = [
    // Primary 4 cardinal sides
    {
      side: "top",
      idealX: centerX - popoverWidth / 2,
      idealY: anchorTarget.y - popoverHeight - gap,
      bias: 0,
    },
    {
      side: "right",
      idealX: anchorTarget.x + anchorTarget.width + gap,
      idealY: centerY - popoverHeight / 2,
      bias: 120,
    },
    {
      side: "left",
      idealX: anchorTarget.x - popoverWidth - gap,
      idealY: centerY - popoverHeight / 2,
      bias: 160,
    },
    {
      side: "bottom",
      idealX: centerX - popoverWidth / 2,
      idealY: anchorTarget.y + anchorTarget.height + gap,
      bias: 220,
    },
    // Corner-offset backups for tight spaces or high zoom
    {
      side: "top",
      idealX: anchorTarget.x + anchorTarget.width - popoverWidth,
      idealY: anchorTarget.y - popoverHeight - gap,
      bias: 350,
    },
    {
      side: "top",
      idealX: anchorTarget.x,
      idealY: anchorTarget.y - popoverHeight - gap,
      bias: 360,
    },
    {
      side: "bottom",
      idealX: anchorTarget.x + anchorTarget.width - popoverWidth,
      idealY: anchorTarget.y + anchorTarget.height + gap,
      bias: 420,
    },
    {
      side: "bottom",
      idealX: anchorTarget.x,
      idealY: anchorTarget.y + anchorTarget.height + gap,
      bias: 430,
    },
  ];

  let bestPlacement: PopoverPlacement | null = null;
  let bestScore = Infinity;

  for (const c of candidates) {
    const clampedX = Math.max(minX, Math.min(maxX, c.idealX));
    const clampedY = Math.max(minY, Math.min(maxY, c.idealY));

    const rect: Rect = {
      x: clampedX,
      y: clampedY,
      width: popoverWidth,
      height: popoverHeight,
    };

    // Heavy penalty if overlapping the clicked item itself
    const selfOverlap = overlapArea(rect, selfExclusion);

    // Penalty if overlapping other canvas nodes or ghost predictions
    let neighborOverlap = 0;
    for (const obs of obstacleRects) {
      neighborOverlap += overlapArea(rect, obs);
    }

    // Penalty if clamping had to shove it far away from the ideal side
    const clampShift = Math.hypot(clampedX - c.idealX, clampedY - c.idealY);

    const score =
      selfOverlap * 60 +
      neighborOverlap * 8 +
      clampShift * 28 +
      c.bias;

    if (score < bestScore) {
      bestScore = score;
      bestPlacement = {
        x: Math.round(clampedX),
        y: Math.round(clampedY),
        side: c.side,
        anchorX: Math.round(centerX),
        anchorY: Math.round(centerY),
      };
    }
  }

  return (
    bestPlacement ?? {
      x: Math.round(minX),
      y: Math.round(minY),
      side: "top",
      anchorX: Math.round(centerX),
      anchorY: Math.round(centerY),
    }
  );
}
