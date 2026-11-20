import { computeBounds, Rect } from "./geometry";
import { JevElement, Point } from "./types";

export type PlacementSlotId =
  | "viewport_center"
  | "below_previous"
  | "right_of_previous"
  | "below_selected"
  | "right_of_selected"
  | "below_visible"
  | "open_viewport_pocket"
  | "above_visible";

export interface LastPromptFlow {
  bounds: Rect;
  labels: string[];
  prompt: string;
  elementIds: string[];
}

export interface PlacementCandidate {
  id: PlacementSlotId;
  label: string;
  description: string;
  topLeft: Point;
  prior: number;
}

export interface PlacementPlan {
  candidates: PlacementCandidate[];
  defaultSlotId: PlacementSlotId;
  stateSummary: string;
  sharedLabels: string[];
  continuesFromLastEnd: boolean;
}

function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function getObstacleRects(elements: JevElement[]): Rect[] {
  const rects: Rect[] = [];
  for (const el of elements) {
    if (el.kind === "arrow") continue;
    if (el.kind === "freedraw" && el.points && el.points.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of el.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      rects.push({
        x: minX,
        y: minY,
        width: Math.max(24, maxX - minX),
        height: Math.max(24, maxY - minY),
      });
      continue;
    }
    rects.push({ x: el.x, y: el.y, width: el.width, height: el.height });
  }
  return rects;
}

function hasAnyCollision(
  candidate: Rect,
  obstacles: Rect[],
  gap: number
): Rect | null {
  for (const obs of obstacles) {
    if (rectsOverlap(candidate, obs, gap)) return obs;
  }
  return null;
}

/**
 * Guarantees a collision-free top-left origin while strictly preserving the
 * user's expected alignment axis (e.g. left-aligned downward stacking).
 */
function resolveNonOverlappingTopLeft(
  desired: Point,
  size: { width: number; height: number },
  obstacles: Rect[],
  direction: "down" | "right" | "up" | "spiral",
  gap = 44
): Point {
  let x = Math.round(desired.x);
  let y = Math.round(desired.y);

  if (direction === "down" || direction === "right" || direction === "up") {
    for (let step = 0; step < 24; step += 1) {
      const hit = hasAnyCollision(
        { x, y, width: size.width, height: size.height },
        obstacles,
        gap
      );
      if (!hit) return { x, y };
      if (direction === "down") {
        y = Math.round(hit.y + hit.height + gap);
      } else if (direction === "right") {
        x = Math.round(hit.x + hit.width + gap);
      } else {
        y = Math.round(hit.y - size.height - gap);
      }
    }
    return { x, y };
  }

  // Spiral search for the nearest open pocket around the desired spot
  if (!hasAnyCollision({ x, y, width: size.width, height: size.height }, obstacles, gap)) {
    return { x, y };
  }

  const stepX = 96;
  const stepY = 76;
  for (let ring = 1; ring <= 10; ring += 1) {
    const offsets: Array<[number, number]> = [];
    // Prefer below first, then right, above, left — feels natural on whiteboards
    for (let dx = -ring; dx <= ring; dx += 1) {
      offsets.push([dx, ring]);
    }
    for (let dy = -ring + 1; dy <= ring - 1; dy += 1) {
      offsets.push([ring, dy]);
    }
    for (let dx = -ring; dx <= ring; dx += 1) {
      offsets.push([dx, -ring]);
    }
    for (let dy = -ring + 1; dy <= ring - 1; dy += 1) {
      offsets.push([-ring, dy]);
    }

    for (const [ox, oy] of offsets) {
      const tx = Math.round(desired.x + ox * stepX);
      const ty = Math.round(desired.y + oy * stepY);
      if (
        !hasAnyCollision(
          { x: tx, y: ty, width: size.width, height: size.height },
          obstacles,
          gap
        )
      ) {
        return { x: tx, y: ty };
      }
    }
  }

  return { x, y: Math.round(desired.y + 180) };
}

function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function extractFlowLabels(elements: JevElement[]): string[] {
  return elements
    .filter((e) => e.kind !== "arrow" && e.kind !== "frame" && e.label.trim())
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((e) => e.label.trim());
}

/**
 * Translates a newly generated diagram so its bounding box top-left lands
 * cleanly at `targetTopLeft`.
 */
export function positionElementsAtTopLeft(
  elements: JevElement[],
  targetTopLeft: Point
): JevElement[] {
  const bounds = computeBounds(elements);
  if (!bounds) return elements;
  const dx = Math.round(targetTopLeft.x - bounds.x);
  const dy = Math.round(targetTopLeft.y - bounds.y);
  if (dx === 0 && dy === 0) return elements;

  return elements.map((el) => {
    if (el.kind === "arrow") {
      return {
        ...el,
        fromPoint: el.fromPoint
          ? { x: el.fromPoint.x + dx, y: el.fromPoint.y + dy }
          : undefined,
        toPoint: el.toPoint
          ? { x: el.toPoint.x + dx, y: el.toPoint.y + dy }
          : undefined,
      };
    }
    if (el.kind === "freedraw" && el.points) {
      return {
        ...el,
        x: el.x + dx,
        y: el.y + dy,
        points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    }
    return {
      ...el,
      x: el.x + dx,
      y: el.y + dy,
    };
  });
}

/**
 * Computes deterministic, collision-free spatial placement candidates around
 * the user's current zoomed viewport, previous prompt flow, and selection,
 * along with a concise state summary for TypeSafe AI's Jev System One model.
 */
export function buildPlacementPlan(params: {
  prompt: string;
  generatedElements: JevElement[];
  existingElements: JevElement[];
  viewportWorld: Rect;
  lastPromptFlow: LastPromptFlow | null;
  selectedIds: string[];
}): PlacementPlan {
  const {
    prompt,
    generatedElements,
    existingElements,
    viewportWorld,
    lastPromptFlow,
    selectedIds,
  } = params;

  const genBounds = computeBounds(generatedElements) ?? {
    x: 0,
    y: 0,
    width: 320,
    height: 80,
  };
  const size = {
    width: Math.max(120, genBounds.width),
    height: Math.max(56, genBounds.height),
  };

  const obstacles = getObstacleRects(existingElements);
  const visibleElements = existingElements.filter((el) => {
    if (el.kind === "arrow") return false;
    return rectsOverlap(
      { x: el.x, y: el.y, width: el.width, height: el.height },
      viewportWorld,
      0
    );
  });
  const visibleBounds = computeBounds(visibleElements);

  const newLabels = extractFlowLabels(generatedElements);
  const newNorm = newLabels.map(normalizeLabel).filter(Boolean);

  // Check whether lastPromptFlow is still alive on canvas AND near/inside the current view
  let liveLastBounds: Rect | null = null;
  if (lastPromptFlow) {
    const idSet = new Set(lastPromptFlow.elementIds);
    const liveMembers = existingElements.filter((e) => idSet.has(e.id));
    const currentBounds = computeBounds(liveMembers);
    if (currentBounds && rectsOverlap(currentBounds, viewportWorld, 260)) {
      liveLastBounds = currentBounds;
    }
  }

  const prevNorm = (lastPromptFlow?.labels ?? []).map(normalizeLabel).filter(Boolean);
  const sharedLabels = newLabels.filter((lbl) =>
    prevNorm.includes(normalizeLabel(lbl))
  );
  const firstLabelMatchesPrev =
    newNorm.length > 0 && prevNorm.length > 0 && newNorm[0] === prevNorm[0];
  const continuesFromLastEnd =
    newNorm.length > 0 &&
    prevNorm.length > 0 &&
    newNorm[0] === prevNorm[prevNorm.length - 1] &&
    !firstLabelMatchesPrev;

  const centerDesired: Point = {
    x: Math.round(viewportWorld.x + viewportWorld.width / 2 - size.width / 2),
    y: Math.round(viewportWorld.y + viewportWorld.height / 2 - size.height / 2),
  };
  const centerIsClear = !hasAnyCollision(
    {
      x: centerDesired.x,
      y: centerDesired.y,
      width: size.width,
      height: size.height,
    },
    obstacles,
    36
  );

  const candidates: PlacementCandidate[] = [];

  // 1. Directly below the previous typed flow (left-aligned for crisp predictable comparison)
  if (liveLastBounds && lastPromptFlow) {
    const desiredBelowPrev: Point = {
      x: Math.round(liveLastBounds.x),
      y: Math.round(liveLastBounds.y + liveLastBounds.height + 64),
    };
    const resolved = resolveNonOverlappingTopLeft(
      desiredBelowPrev,
      size,
      obstacles,
      "down",
      48
    );

    let prior = 0.84;
    if (sharedLabels.length > 0 || firstLabelMatchesPrev) prior = 0.96;
    if (continuesFromLastEnd) prior = 0.56;

    const overlapNote =
      sharedLabels.length > 0
        ? ` Shares ${sharedLabels.length} node label(s) (${sharedLabels.slice(0, 3).join(", ")}) with the previous flow, making vertical comparison ideal.`
        : " Keeps sequential typed flows neatly stacked downward in a predictable column.";

    candidates.push({
      id: "below_previous",
      label: "Below previous flow",
      description: `Stack directly below the previous flow ("${lastPromptFlow.prompt.slice(0, 60)}") at left-aligned x=${resolved.x}, y=${resolved.y}.${overlapNote}`,
      topLeft: resolved,
      prior,
    });

    // 2. To the right of the previous flow (horizontal downstream continuation)
    const desiredRightPrev: Point = {
      x: Math.round(liveLastBounds.x + liveLastBounds.width + 92),
      y: Math.round(liveLastBounds.y),
    };
    const resolvedRight = resolveNonOverlappingTopLeft(
      desiredRightPrev,
      size,
      obstacles,
      "right",
      48
    );
    candidates.push({
      id: "right_of_previous",
      label: "Right of previous flow",
      description: `Place horizontally to the right of the previous flow ("${lastPromptFlow.prompt.slice(0, 60)}") at x=${resolvedRight.x}, y=${resolvedRight.y} as a downstream pipeline continuation.`,
      topLeft: resolvedRight,
      prior: continuesFromLastEnd ? 0.91 : 0.34,
    });
  }

  // 3. Relative to currently selected element(s) (skip when selection is only part of lastPromptFlow,
  // which is already represented cleanly by below_previous / right_of_previous)
  if (selectedIds.length > 0) {
    const selSet = new Set(selectedIds);
    const prevIdSet = new Set(lastPromptFlow?.elementIds ?? []);
    const selEls = existingElements.filter((e) => selSet.has(e.id));
    const selBounds = computeBounds(selEls);
    const selLabels = selEls.map((e) => e.label).filter(Boolean);
    const isInsideLastFlow =
      Boolean(liveLastBounds) &&
      selEls.length > 0 &&
      selEls.every((e) => prevIdSet.has(e.id));

    if (selBounds && !isInsideLastFlow) {
      const selLastNorm = normalizeLabel(selLabels[selLabels.length - 1] ?? "");
      const startsWithSelected =
        newNorm.length > 0 && selLastNorm.length > 0 && newNorm[0] === selLastNorm;

      const belowSel = resolveNonOverlappingTopLeft(
        {
          x: Math.round(selBounds.x),
          y: Math.round(selBounds.y + selBounds.height + 64),
        },
        size,
        obstacles,
        "down",
        44
      );
      candidates.push({
        id: "below_selected",
        label: "Below selection",
        description: `Place directly below the user's selected component (${selLabels.slice(0, 2).join(", ") || "selection"}) at x=${belowSel.x}, y=${belowSel.y}.`,
        topLeft: belowSel,
        prior: liveLastBounds ? 0.58 : 0.78,
      });

      const rightSel = resolveNonOverlappingTopLeft(
        {
          x: Math.round(selBounds.x + selBounds.width + 88),
          y: Math.round(selBounds.y),
        },
        size,
        obstacles,
        "right",
        44
      );
      candidates.push({
        id: "right_of_selected",
        label: "Right of selection",
        description: `Place directly to the right of the user's selected component (${selLabels.slice(0, 2).join(", ") || "selection"}) at x=${rightSel.x}, y=${rightSel.y} to extend it horizontally.`,
        topLeft: rightSel,
        prior: startsWithSelected ? 0.86 : 0.44,
      });
    }
  }

  // 4. Directly below the visible cluster in view (when there's content in view, no previous flow yet)
  if (visibleBounds && !liveLastBounds) {
    const belowVisible = resolveNonOverlappingTopLeft(
      {
        x: Math.round(visibleBounds.x),
        y: Math.round(visibleBounds.y + visibleBounds.height + 68),
      },
      size,
      obstacles,
      "down",
      48
    );
    candidates.push({
      id: "below_visible",
      label: "Below visible diagram",
      description: `Stack neatly below the existing visible diagram in the current viewport, left-aligned at x=${belowVisible.x}, y=${belowVisible.y}.`,
      topLeft: belowVisible,
      prior: centerIsClear ? 0.66 : 0.88,
    });
  }

  // 5. Viewport center (dominant when viewport center is empty & no active previous flow stack)
  if (centerIsClear) {
    candidates.push({
      id: "viewport_center",
      label: "Center of zoomed view",
      description: `Place directly at the empty center of the user's zoomed viewport (x=${centerDesired.x}, y=${centerDesired.y}) where there is open whitespace.`,
      topLeft: centerDesired,
      prior:
        visibleElements.length === 0
          ? 0.98
          : liveLastBounds
            ? 0.25
            : 0.74,
    });
  } else {
    // 6. Nearest open non-overlapping pocket inside/around the zoomed viewport
    const pocket = resolveNonOverlappingTopLeft(
      centerDesired,
      size,
      obstacles,
      "spiral",
      48
    );
    candidates.push({
      id: "open_viewport_pocket",
      label: "Open pocket in view",
      description: `Place in the nearest open collision-free whitespace around the user's current zoomed view (x=${pocket.x}, y=${pocket.y}).`,
      topLeft: pocket,
      prior: liveLastBounds ? 0.3 : 0.62,
    });
  }

  // 7. Above existing visible diagram (for upstream clients / headers)
  if (visibleBounds) {
    const aboveVisible = resolveNonOverlappingTopLeft(
      {
        x: Math.round(visibleBounds.x),
        y: Math.round(visibleBounds.y - size.height - 68),
      },
      size,
      obstacles,
      "up",
      48
    );
    const looksUpstream = /^(user|client|browser|mobile|web|visitor|customer|edge|cdn)\b/i.test(
      newLabels[0] ?? ""
    );
    candidates.push({
      id: "above_visible",
      label: "Above visible diagram",
      description: `Place above the visible diagram at x=${aboveVisible.x}, y=${aboveVisible.y} as an upstream/entry layer.`,
      topLeft: aboveVisible,
      prior: looksUpstream && !liveLastBounds ? 0.52 : 0.22,
    });
  }

  candidates.sort((a, b) => b.prior - a.prior);
  const defaultSlotId = candidates[0]?.id ?? "viewport_center";

  // Build concise structured context for TypeSafe AI's Jev System One model
  const visibleList = visibleElements
    .slice(0, 12)
    .map(
      (e) =>
        `  - ${e.kind} "${e.label || "(unlabeled)"}" at (${Math.round(e.x)},${Math.round(e.y)}) ${Math.round(e.width)}x${Math.round(e.height)}`
    )
    .join("\n");

  const stateSummary = [
    `New prompt to place: "${prompt.slice(0, 180)}"`,
    `Parsed nodes (${newLabels.length}): [${newLabels.join(" -> ")}]`,
    `New diagram bounding size: ${Math.round(size.width)}x${Math.round(size.height)}`,
    `Current zoomed viewport (world coords): x=${Math.round(viewportWorld.x)}..${Math.round(viewportWorld.x + viewportWorld.width)}, y=${Math.round(viewportWorld.y)}..${Math.round(viewportWorld.y + viewportWorld.height)}`,
    `Viewport center is empty: ${centerIsClear ? "yes" : "no"}`,
    liveLastBounds && lastPromptFlow
      ? `Immediately previous prompt flow: "${lastPromptFlow.prompt.slice(0, 120)}" [${lastPromptFlow.labels.join(" -> ")}] at (${Math.round(liveLastBounds.x)},${Math.round(liveLastBounds.y)}) ${Math.round(liveLastBounds.width)}x${Math.round(liveLastBounds.height)}`
      : "Immediately previous prompt flow in view: none",
    sharedLabels.length > 0
      ? `Shared node labels with previous flow: [${sharedLabels.join(", ")}] (first label matches: ${firstLabelMatchesPrev ? "yes" : "no"})`
      : "Shared node labels with previous flow: none",
    continuesFromLastEnd
      ? "New flow starts with the last node of the previous flow (horizontal continuation signal)."
      : "",
    visibleElements.length > 0
      ? `Visible elements in zoomed viewport (${visibleElements.length}):\n${visibleList}`
      : "Visible elements in zoomed viewport: 0 (completely open canvas area)",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    candidates,
    defaultSlotId,
    stateSummary,
    sharedLabels,
    continuesFromLastEnd,
  };
}
