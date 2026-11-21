import type { PointerEvent } from "react";
import {
  EDGE_HANDLE_HIT_RADIUS,
  EDGE_HANDLE_RADIUS,
  EDGE_HANDLE_STROKE,
  getEdgeHandles,
} from "@/lib/jev/geometry";
import type { JevElement, Point } from "@/lib/jev/types";

interface EdgeHandlesProps {
  el: JevElement;
  fill: string;
  stroke: string;
  onHandlePointerDown: (ev: PointerEvent, el: JevElement, point: Point) => void;
}

/**
 * Rendered inside the node's `translate(el.x, el.y)` group. Each handle is an
 * unscaled hit circle plus a pointer-events:none dot; hover feedback scales the
 * dot only (globals.css), so the hit area never moves under the pointer.
 */
export function EdgeHandles({ el, fill, stroke, onHandlePointerDown }: EdgeHandlesProps) {
  return (
    <g className="jev-edge-handles">
      {getEdgeHandles(el).map((h) => {
        const cx = h.point.x - el.x;
        const cy = h.point.y - el.y;
        return (
          <g
            key={h.side}
            className="jev-edge-handle cursor-crosshair"
            data-side={h.side}
            onPointerDown={(ev) => onHandlePointerDown(ev, el, h.point)}
          >
            <circle
              className="jev-edge-handle__hit"
              cx={cx}
              cy={cy}
              r={EDGE_HANDLE_HIT_RADIUS}
              fill="none"
              pointerEvents="all"
            />
            <circle
              className="jev-edge-handle__dot"
              cx={cx}
              cy={cy}
              r={EDGE_HANDLE_RADIUS}
              fill={fill}
              stroke={stroke}
              strokeWidth={EDGE_HANDLE_STROKE}
              pointerEvents="none"
            />
          </g>
        );
      })}
    </g>
  );
}
