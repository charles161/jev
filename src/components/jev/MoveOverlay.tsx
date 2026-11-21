"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IconClose, IconTrace } from "@/brand/icons";
import { getElementRect, resolveArrowEndpoints } from "@/lib/jev/geometry";
import type { TracePath } from "@/lib/jev/sd-moves/trace";
import type { BoardTheme, JevElement, Point, Viewport } from "@/lib/jev/types";
import type { MoveHighlight, TraceState } from "./use-moves";

export const TRACE_COLORS: Record<TracePath, Record<BoardTheme, string>> = {
  write: { midnight: "#FF8562", vellum: "#C2411D" },
  read: { midnight: "#38BDF8", vellum: "#1D4ED8" },
};
const PIN_COLOR: Record<BoardTheme, string> = { midnight: "#FF8562", vellum: "#C2411D" };
const STEP_MS = 750;
const HOLD_MS = 1600;
/** Step badges sit a fifth of the way along the arrow, clear of the arrow's own label at its midpoint. */
const BADGE_T = 0.2;

interface Segment {
  n: number;
  start: Point;
  control: Point;
  end: Point;
}

function bezier(s: Segment, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * s.start.x + 2 * u * t * s.control.x + t * t * s.end.x,
    y: u * u * s.start.y + 2 * u * t * s.control.y + t * t * s.end.y,
  };
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = window.matchMedia(REDUCED_MOTION);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false
  );
}

/** Milliseconds since the trace started, looping after every step has played and held. */
function useTraceClock(active: boolean, total: number, frozen: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active || frozen) return;
    const t0 = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      setElapsed((now - t0) % total);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, total, frozen]);
  return active && !frozen ? elapsed : total;
}

interface MoveOverlayProps {
  elements: JevElement[];
  viewport: Viewport;
  theme: BoardTheme;
  trace: TraceState | null;
  highlights: MoveHighlight[];
  onStop: () => void;
  onTracePath: (path: TracePath) => void;
}

/** Move feedback drawn over the board, never into it: the traced request path and pins on shapes. Esc clears it. */
export function MoveOverlay({ elements, viewport, theme, trace, highlights, onStop, onTracePath }: MoveOverlayProps) {
  const reduced = usePrefersReducedMotion();
  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements]);
  const segments = useMemo<Segment[]>(() => {
    if (!trace) return [];
    return trace.steps.flatMap((step) => {
      const arrow = byId.get(step.edgeId);
      if (!arrow) return [];
      const reversed = arrow.fromId !== step.fromId;
      const { start, control, end } = resolveArrowEndpoints(arrow, byId);
      return [{ n: step.n, start: reversed ? end : start, control, end: reversed ? start : end }];
    });
  }, [trace, byId]);
  const total = segments.length * STEP_MS + HOLD_MS;
  const elapsed = useTraceClock(segments.length > 0, total, reduced);
  const pins = highlights.filter((h) => byId.has(h.id) && byId.has(h.ownerId));
  const active = Boolean(trace) || pins.length > 0;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onStop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onStop]);

  if (!active) return null;
  const color = trace ? TRACE_COLORS[trace.path][theme] : PIN_COLOR[theme];
  const reached = Math.min(segments.length, Math.floor(elapsed / STEP_MS));
  const t = Math.min(1, (elapsed % STEP_MS) / STEP_MS);
  const current = reached < segments.length ? segments[reached] : null;
  const pulse = current ? bezier(current, t) : null;
  const startEl = trace?.startId ? byId.get(trace.startId) : undefined;
  const z = viewport.zoom;
  const badgeText = theme === "midnight" ? "#0F172A" : "#FFFFFF";
  const pathD = (s: Segment) => `M${s.start.x} ${s.start.y}Q${s.control.x} ${s.control.y} ${s.end.x} ${s.end.y}`;

  return (
    <>
      <svg
        aria-hidden="true"
        data-testid="move-overlay"
        className="pointer-events-none absolute inset-0 z-[5] h-full w-full overflow-visible"
      >
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${z})`}>
          {startEl && (
            <rect
              x={startEl.x - 8}
              y={startEl.y - 8}
              width={startEl.width + 16}
              height={startEl.height + 16}
              rx={12}
              fill="none"
              stroke={color}
              strokeWidth={2 / z}
              strokeDasharray={`${6 / z} ${5 / z}`}
            />
          )}
          {segments.map((s) => (
            <path key={`base-${s.n}`} d={pathD(s)} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={10 / z} strokeLinecap="round" />
          ))}
          {segments.slice(0, reached).map((s) => (
            <path key={`lit-${s.n}`} data-trace-lit="" d={pathD(s)} fill="none" stroke={color} strokeWidth={3.5 / z} strokeLinecap="round" />
          ))}
          {segments.slice(0, Math.min(segments.length, reached + 1)).map((s) => {
            const mid = bezier(s, BADGE_T);
            return (
              <g key={`badge-${s.n}`} data-trace-step={s.n}>
                <circle cx={mid.x} cy={mid.y} r={11 / z} fill={color} />
                <text
                  x={mid.x}
                  y={mid.y}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize={12 / z}
                  fontWeight={700}
                  fontFamily="var(--font-mono, ui-monospace, monospace)"
                  fill={badgeText}
                >
                  {s.n}
                </text>
              </g>
            );
          })}
          {pulse && (
            <g data-testid="trace-pulse" data-x={Math.round(pulse.x)} data-y={Math.round(pulse.y)}>
              <circle cx={pulse.x} cy={pulse.y} r={14 / z} fill={color} fillOpacity={0.25} />
              <circle cx={pulse.x} cy={pulse.y} r={6 / z} fill={color} />
            </g>
          )}
          {pins.map((h) => {
            const r = getElementRect(byId.get(h.id)!);
            return (
              <g key={`hl-${h.id}`} data-testid="move-highlight" data-element-id={h.id}>
                <rect
                  x={r.x - 7}
                  y={r.y - 7}
                  width={r.width + 14}
                  height={r.height + 14}
                  rx={12}
                  fill="none"
                  stroke={PIN_COLOR[theme]}
                  strokeWidth={2.5 / z}
                  strokeDasharray={`${7 / z} ${5 / z}`}
                  className="jev-ghost-pulse"
                />
                {h.pin && (
                  <g>
                    <rect
                      x={r.x + r.width + 4 - (9 + 3.6 * h.pin.length) / z}
                      y={r.y - 4 - 11 / z}
                      width={(18 + 7.2 * h.pin.length) / z}
                      height={22 / z}
                      rx={11 / z}
                      fill={PIN_COLOR[theme]}
                    />
                    <text
                      x={r.x + r.width + 4}
                      y={r.y - 4}
                      dy="0.35em"
                      textAnchor="middle"
                      fontSize={12 / z}
                      fontWeight={700}
                      fontFamily="var(--font-mono, ui-monospace, monospace)"
                      fill={badgeText}
                    >
                      {h.pin}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {trace && (
        <div className="pointer-events-none fixed inset-x-0 top-[124px] z-30 flex justify-center px-3 sm:top-[76px]">
          <div
            role="group"
            aria-label="Trace legend"
            data-testid="trace-legend"
            className="jev-glass pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-2xl px-2.5 py-1.5 text-[11.5px] shadow-[0_14px_36px_-12px_rgba(15,23,42,0.28)]"
          >
            <IconTrace className="h-3.5 w-3.5 shrink-0 text-foreground/80" aria-hidden="true" />
            {(["write", "read"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={trace.path === p}
                onClick={() => onTracePath(p)}
                className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-xl px-2 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 ${
                  trace.path === p ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="h-1 w-4 rounded-full" style={{ backgroundColor: TRACE_COLORS[p][theme] }} aria-hidden="true" />
                {p === "write" ? "Write path" : "Read path"}
              </button>
            ))}
            <span className="px-1 font-mono text-[10.5px] text-muted-foreground" aria-live="polite">
              {segments.length} step{segments.length === 1 ? "" : "s"}
            </span>
            <kbd className="hidden rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground/85 sm:inline-block">
              Esc
            </kbd>
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop trace"
              className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0 sm:p-1"
            >
              <IconClose className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
