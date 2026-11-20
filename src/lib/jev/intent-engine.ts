import {
  distanceBetween,
  getElementCenter,
  getElementRect,
  isShapeElement,
  pointToSegmentDistance,
  rectContainsCenter,
  resolveArrowEndpoints,
} from "./geometry";
import { JevElement, PositionSnapshot, SpatialIntent } from "./types";

function formatDelta(dx: number, dy: number): string {
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  const parts: string[] = [];
  if (Math.abs(rx) >= 8) {
    parts.push(`${rx > 0 ? "+" : ""}${rx}px ${rx > 0 ? "right" : "left"}`);
  }
  if (Math.abs(ry) >= 8) {
    parts.push(`${ry > 0 ? "+" : ""}${ry}px ${ry > 0 ? "down" : "up"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "nudged";
}

function areConnected(
  aId: string,
  bId: string,
  arrows: JevElement[]
): JevElement | undefined {
  return arrows.find(
    (e) =>
      (e.fromId === aId && e.toId === bId) ||
      (e.fromId === bId && e.toId === aId)
  );
}

/**
 * Analyzes an element's move from its previous position to its current position
 * against the surrounding graph, edges, frames, and neighbors.
 */
export function detectMoveIntent(
  moved: JevElement,
  prev: PositionSnapshot,
  allElements: JevElement[]
): SpatialIntent {
  const dx = moved.x - prev.x;
  const dy = moved.y - prev.y;
  const distance = Math.hypot(dx, dy);
  const byId = new Map(allElements.map((e) => [e.id, e]));
  const arrows = allElements.filter((e) => e.kind === "arrow");
  const otherShapes = allElements.filter(
    (e) => e.id !== moved.id && isShapeElement(e) && e.kind !== "frame"
  );
  const frames = allElements.filter(
    (e) => e.id !== moved.id && e.kind === "frame"
  );
  const movedCenter = getElementCenter(moved);
  const deltaSummary = formatDelta(dx, dy);
  const label = moved.label || "Item";

  // 1. Did the user drop a node directly onto or very near an existing arrow A -> B?
  if (moved.kind !== "frame" && moved.kind !== "arrow") {
    let closestArrow: JevElement | null = null;
    let closestDist = Infinity;

    for (const arrow of arrows) {
      if (arrow.fromId === moved.id || arrow.toId === moved.id) continue;
      if (!arrow.fromId || !arrow.toId) continue;
      const { start, end } = resolveArrowEndpoints(arrow, byId);
      const d = pointToSegmentDistance(movedCenter, start, end);
      if (d < 54 && d < closestDist) {
        closestDist = d;
        closestArrow = arrow;
      }
    }

    if (closestArrow && closestArrow.fromId && closestArrow.toId) {
      const fromEl = byId.get(closestArrow.fromId);
      const toEl = byId.get(closestArrow.toId);
      return {
        kind: "splice_into_edge",
        headline: `Inserting "${label}" between ${fromEl?.label || "A"} → ${toEl?.label || "B"}`,
        detail: `Moved ${deltaSummary} onto an existing flow edge`,
        subjectId: moved.id,
        delta: { dx, dy, distance },
        relatedIds: [closestArrow.id, closestArrow.fromId, closestArrow.toId],
        timestamp: Date.now(),
      };
    }
  }

  // 2. Did the user pull a connected node away to open a gap along the flow axis?
  const connectedEdges = arrows.filter(
    (a) => a.fromId === moved.id || a.toId === moved.id
  );
  if (connectedEdges.length > 0 && distance > 48) {
    for (const edge of connectedEdges) {
      const peerId = edge.fromId === moved.id ? edge.toId : edge.fromId;
      if (!peerId) continue;
      const peer = byId.get(peerId);
      if (!peer) continue;

      const prevCenter = {
        x: prev.x + prev.width / 2,
        y: prev.y + prev.height / 2,
      };
      const peerCenter = getElementCenter(peer);
      const prevGap = distanceBetween(prevCenter, peerCenter);
      const nextGap = distanceBetween(movedCenter, peerCenter);

      // Opened meaningful room between two connected nodes
      if (nextGap - prevGap > 70 && nextGap > 240) {
        return {
          kind: "open_pipeline_gap",
          headline: `Opening room between "${peer.label}" & "${label}"`,
          detail: `Pulled ${deltaSummary} (gap widened by +${Math.round(nextGap - prevGap)}px)`,
          subjectId: moved.id,
          delta: { dx, dy, distance },
          relatedIds: [peer.id, edge.id],
          timestamp: Date.now(),
        };
      }
    }
  }

  // 3. Did the user move a node into a frame?
  if (moved.kind !== "frame") {
    for (const frame of frames) {
      const wasInside = rectContainsCenter(getElementRect(frame), prev);
      const isInside = rectContainsCenter(
        getElementRect(frame),
        getElementRect(moved)
      );
      if (!wasInside && isInside) {
        return {
          kind: "encapsulate_group",
          headline: `Grouped "${label}" into "${frame.label || "Zone"}"`,
          detail: `Moved ${deltaSummary} inside boundary`,
          subjectId: moved.id,
          delta: { dx, dy, distance },
          relatedIds: [frame.id],
          timestamp: Date.now(),
        };
      }
      if (wasInside && !isInside) {
        return {
          kind: "branch_out",
          headline: `Extracted "${label}" from "${frame.label || "Zone"}"`,
          detail: `Pulled ${deltaSummary} out of boundary to decouple`,
          subjectId: moved.id,
          delta: { dx, dy, distance },
          relatedIds: [frame.id],
          timestamp: Date.now(),
        };
      }
    }
  }

  // 4. Did the user bring a node near an unconnected neighbor?
  let nearestUnconnected: { el: JevElement; dist: number } | null = null;
  for (const other of otherShapes) {
    if (areConnected(moved.id, other.id, arrows)) continue;
    const d = distanceBetween(movedCenter, getElementCenter(other));
    if (d < 340 && (!nearestUnconnected || d < nearestUnconnected.dist)) {
      nearestUnconnected = { el: other, dist: d };
    }
  }

  // 5. Check horizontal pipeline alignment vs vertical column alignment
  const horizontalPeers = otherShapes.filter(
    (o) => Math.abs(getElementCenter(o).y - movedCenter.y) < 34
  );
  const verticalPeers = otherShapes.filter(
    (o) => Math.abs(getElementCenter(o).x - movedCenter.x) < 38
  );

  if (Math.abs(dy) > Math.abs(dx) * 1.25 && Math.abs(dy) > 60 && horizontalPeers.length === 0) {
    // Pulled vertically off the horizontal axis -> branching!
    const anchorPeer =
      verticalPeers[0] ??
      otherShapes
        .slice()
        .sort(
          (a, b) =>
            distanceBetween(getElementCenter(a), {
              x: prev.x + prev.width / 2,
              y: prev.y + prev.height / 2,
            }) -
            distanceBetween(getElementCenter(b), {
              x: prev.x + prev.width / 2,
              y: prev.y + prev.height / 2,
            })
        )[0];

    return {
      kind: "branch_out",
      headline: `Branching "${label}" ${dy > 0 ? "below" : "above"} the main flow`,
      detail: `Moved ${deltaSummary} from previous spot`,
      subjectId: moved.id,
      delta: { dx, dy, distance },
      relatedIds: anchorPeer ? [anchorPeer.id] : [],
      timestamp: Date.now(),
    };
  }

  if (horizontalPeers.length > 0 && Math.abs(dx) >= Math.abs(dy) * 0.7) {
    const closestHoriz = horizontalPeers.sort(
      (a, b) =>
        Math.abs(getElementCenter(a).x - movedCenter.x) -
        Math.abs(getElementCenter(b).x - movedCenter.x)
    )[0];

    return {
      kind: "align_pipeline",
      headline: `Forming horizontal flow with "${closestHoriz.label}"`,
      detail: `Moved ${deltaSummary} · aligned along row`,
      subjectId: moved.id,
      delta: { dx, dy, distance },
      relatedIds: [closestHoriz.id, ...horizontalPeers.slice(1, 3).map((p) => p.id)],
      timestamp: Date.now(),
    };
  }

  if (verticalPeers.length > 0) {
    const closestVert = verticalPeers.sort(
      (a, b) =>
        Math.abs(getElementCenter(a).y - movedCenter.y) -
        Math.abs(getElementCenter(b).y - movedCenter.y)
    )[0];

    return {
      kind: "align_column",
      headline: `Stacking "${label}" vertically with "${closestVert.label}"`,
      detail: `Moved ${deltaSummary} · aligned in column`,
      subjectId: moved.id,
      delta: { dx, dy, distance },
      relatedIds: [closestVert.id, ...verticalPeers.slice(1, 3).map((p) => p.id)],
      timestamp: Date.now(),
    };
  }

  if (nearestUnconnected) {
    return {
      kind: "connect_nearby",
      headline: `Positioned "${label}" beside "${nearestUnconnected.el.label}"`,
      detail: `Moved ${deltaSummary} · ready to connect or group`,
      subjectId: moved.id,
      delta: { dx, dy, distance },
      relatedIds: [nearestUnconnected.el.id],
      timestamp: Date.now(),
    };
  }

  return {
    kind: "domain_continue",
    headline: `Repositioned "${label}" (${deltaSummary})`,
    detail: `Previous position saved in motion memory`,
    subjectId: moved.id,
    delta: { dx, dy, distance },
    relatedIds: [],
    timestamp: Date.now(),
  };
}

/**
 * Analyzes creation or text edit of an element to trigger smart domain predictions.
 */
export function detectCreationIntent(
  el: JevElement,
  allElements: JevElement[],
  fromPrompt = false
): SpatialIntent {
  const label = el.label || "Untitled";
  if (el.kind === "diamond" || label.includes("?")) {
    return {
      kind: "decision_branch",
      headline: `Decision point "${label}"`,
      detail: "Ready to branch Yes / No outcomes",
      subjectId: el.id,
      relatedIds: [],
      timestamp: Date.now(),
    };
  }

  if (fromPrompt) {
    return {
      kind: "prompt_follow_up",
      headline: `Drew "${label}" from your prompt`,
      detail: "Tab + Enter to expand architecture instantaneously",
      subjectId: el.id,
      relatedIds: allElements.slice(-4).map((e) => e.id),
      timestamp: Date.now(),
    };
  }

  return {
    kind: "domain_continue",
    headline: `Added "${label}"`,
    detail: "Predicted 3 next steps · Tab to preview, Enter to apply",
    subjectId: el.id,
    relatedIds: [],
    timestamp: Date.now(),
  };
}
