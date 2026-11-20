"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolvePointerCancelDecision } from "@/lib/jev/board-history";
import { getTonePalette, inferToneFromLabel } from "@/lib/jev/colors";
import {
  computeBounds,
  distanceBetween,
  getEdgeHandles,
  getElementCenter,
  getElementRect,
  isShapeElement,
  makeSeed,
  pointToSegmentDistance,
  rectsOverlap,
  resolveArrowEndpoints,
  uid,
} from "@/lib/jev/geometry";
import {
  computeArrowHeadPath,
  generateArrowPath,
  generateShapePaths,
  smoothFreedrawPath,
} from "@/lib/jev/rough-paths";
import {
  BoardTheme,
  ElementBox,
  ElementKind,
  JevElement,
  PeerCursor,
  Point,
  PredictedAction,
  RenderStyle,
  ToolType,
  Viewport,
} from "@/lib/jev/types";

export interface CanvasStrokeEvent {
  phase: "start" | "move" | "end";
  strokeId: string;
  elementId?: string;
  kind: ElementKind;
  startPoint: Point;
  endPoint: Point;
  label?: string;
  fromId?: string;
  toId?: string;
  timestamp: number;
}

interface JevCanvasProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  startEditRef?: React.MutableRefObject<((id: string) => void) | null>;
  remoteSyncGenerationRef?: React.RefObject<number>;
  elements: JevElement[];
  selectedIds: string[];
  tool: ToolType;
  theme: BoardTheme;
  renderStyle: RenderStyle;
  viewport: Viewport;
  activePrediction: PredictedAction | null;
  promptPreviewElements: JevElement[];
  peers: PeerCursor[];
  forkActive?: boolean;
  talkToDrawActive?: boolean;
  onStrokeEvent?: (ev: CanvasStrokeEvent) => void;
  onViewportChange: (vp: Viewport) => void;
  onSelectIds: (ids: string[]) => void;
  onToolChange: (tool: ToolType) => void;
  onElementsChange: (
    updater: (prev: JevElement[]) => JevElement[],
    opts?: {
      recordUndo?: boolean;
      undoSnapshot?: JevElement[];
      expectedRemoteSyncGeneration?: number;
      throttleBroadcast?: boolean;
      flushBroadcast?: boolean;
    }
  ) => JevElement[];
  onElementMoved: (moved: JevElement, dragStart: ElementBox) => void;
  onElementCreated: (created: JevElement) => void;
  onElementLabelEdited: (edited: JevElement) => void;
  onCursorMove?: (worldPoint: Point) => void;
  onInteractingChange?: (busy: boolean) => void;
}

interface DragState {
  mode: "pan" | "move" | "resize" | "connect" | "draw_shape" | "freedraw" | "marquee";
  startScreen: Point;
  startWorld: Point;
  startViewport: Viewport;
  targetId?: string;
  originBox?: ElementBox;
  originBoxes?: Record<string, ElementBox>;
  preDragElements?: JevElement[];
  dragStartSyncGeneration?: number;
  initialSelectedIds?: string[];
  currentWorld: Point;
  hoverTargetId?: string | null;
  draftId?: string;
  freedrawPoints?: Point[];
  movedEnough?: boolean;
}

interface SnapGuide {
  orientation: "h" | "v";
  pos: number;
}

const ShapePathsMemo = React.memo(function ShapePathsMemo({
  el,
  stroke,
  fill,
  renderStyle,
  isGhost,
}: {
  el: JevElement;
  stroke: string;
  fill: string;
  renderStyle: RenderStyle;
  isGhost?: boolean;
}) {
  const paths = useMemo(
    () => generateShapePaths(el, stroke, fill, renderStyle, isGhost),
    [el, stroke, fill, renderStyle, isGhost]
  );

  return (
    <>
      {paths.map((p, idx) => (
        <path
          key={idx}
          d={p.d}
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          fill={p.fill}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={
            isGhost
              ? "7 5"
              : el.kind === "frame" && renderStyle === "clean"
                ? "8 6"
                : undefined
          }
          className={isGhost ? "jev-ghost-dash" : undefined}
        />
      ))}
    </>
  );
});

export function JevCanvas({
  svgRef,
  startEditRef,
  remoteSyncGenerationRef,
  elements,
  selectedIds,
  tool,
  theme,
  renderStyle,
  viewport,
  activePrediction,
  promptPreviewElements,
  peers,
  forkActive = false,
  talkToDrawActive,
  onStrokeEvent,
  onViewportChange,
  onSelectIds,
  onToolChange,
  onElementsChange,
  onElementMoved,
  onElementCreated,
  onElementLabelEdited,
  onCursorMove,
  onInteractingChange,
}: JevCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [spacePressed, setSpacePressed] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const primarySelectedId = selectedIds.length === 1 ? selectedIds[0] : null;

  // Notify parent when actively dragging/resizing/selecting or inline-editing so floating dialogs never interfere
  const isInteracting =
    Boolean(editingId) ||
    Boolean(
      drag &&
        (drag.mode === "move"
          ? drag.movedEnough
          : drag.mode === "resize" ||
            drag.mode === "connect" ||
            drag.mode === "draw_shape" ||
            drag.mode === "freedraw" ||
            drag.mode === "marquee")
    );

  useEffect(() => {
    onInteractingChange?.(isInteracting);
  }, [isInteracting, onInteractingChange]);

  const elementsById = useMemo(
    () => new Map(elements.map((e) => [e.id, e])),
    [elements]
  );

  // Merge ghost elements with real elements for resolving ghost arrow endpoints
  const ghostElementsMap = useMemo(() => {
    const map = new Map(elementsById);
    if (activePrediction) {
      if (activePrediction.patchElements) {
        for (const patch of activePrediction.patchElements) {
          const base = map.get(patch.id);
          if (base) {
            map.set(patch.id, { ...base, ...patch });
          }
        }
      }
      for (const ge of activePrediction.addElements) {
        map.set(ge.id, ge);
      }
    }
    for (const pe of promptPreviewElements) {
      map.set(pe.id, pe);
    }
    return map;
  }, [elementsById, activePrediction, promptPreviewElements]);

  const removedGhostSet = useMemo(
    () => new Set(activePrediction?.removeIds ?? []),
    [activePrediction]
  );

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: clientX, y: clientY };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport]
  );

  // Track Spacebar for quick Hand panning
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        setSpacePressed(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const findShapeAtPoint = useCallback(
    (pt: Point, ignoreId?: string): JevElement | null => {
      // Search top-most first, preferring non-frames over frames
      const nonFrames = elements.filter(
        (e) =>
          e.id !== ignoreId &&
          isShapeElement(e) &&
          e.kind !== "frame"
      );
      for (let i = nonFrames.length - 1; i >= 0; i--) {
        const el = nonFrames[i];
        if (
          pt.x >= el.x - 4 &&
          pt.x <= el.x + el.width + 4 &&
          pt.y >= el.y - 4 &&
          pt.y <= el.y + el.height + 4
        ) {
          return el;
        }
      }
      // Check arrows
      const arrows = elements.filter(
        (e) => e.id !== ignoreId && e.kind === "arrow"
      );
      for (let i = arrows.length - 1; i >= 0; i--) {
        const arr = arrows[i];
        const { start, end } = resolveArrowEndpoints(arr, elementsById);
        if (pointToSegmentDistance(pt, start, end) < 12) {
          return arr;
        }
      }
      // Check freedraw
      const draws = elements.filter(
        (e) => e.id !== ignoreId && e.kind === "freedraw" && e.points
      );
      for (let i = draws.length - 1; i >= 0; i--) {
        const dr = draws[i];
        if (
          dr.points?.some((p) => distanceBetween(p, pt) < 14)
        ) {
          return dr;
        }
      }
      // Check frames last
      const frames = elements.filter(
        (e) => e.id !== ignoreId && e.kind === "frame"
      );
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        // Frame hit on border or title bar
        const inOuter =
          pt.x >= f.x - 6 &&
          pt.x <= f.x + f.width + 6 &&
          pt.y >= f.y - 6 &&
          pt.y <= f.y + f.height + 6;
        const inInner =
          pt.x >= f.x + 16 &&
          pt.x <= f.x + f.width - 16 &&
          pt.y >= f.y + 34 &&
          pt.y <= f.y + f.height - 16;
        if (inOuter && !inInner) {
          return f;
        }
      }
      return null;
    },
    [elements, elementsById]
  );

  useEffect(() => {
    if (!startEditRef) return;
    startEditRef.current = (id: string) => {
      const target = elementsById.get(id);
      if (!target || target.kind === "freedraw") return;
      setEditingId(target.id);
      setEditingText(target.label);
    };
    return () => {
      startEditRef.current = null;
    };
  }, [startEditRef, elementsById]);

  const commitInlineEdit = useCallback(() => {
    if (!editingId) return;
    const id = editingId;
    const nextLabel = editingText.trim();
    setEditingId(null);

    const nextElements = onElementsChange(
      (prev) =>
        prev.map((el) => {
          if (el.id !== id) return el;
          const label =
            nextLabel || (el.kind === "arrow" ? "" : el.label || "Node");
          return {
            ...el,
            label,
            updatedAt: Date.now(),
          };
        }),
      { recordUndo: true, flushBroadcast: true }
    );
    const updatedEl = nextElements.find((el) => el.id === id);
    if (updatedEl) {
      onElementLabelEdited(updatedEl);
    }
  }, [editingId, editingText, onElementsChange, onElementLabelEdited]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.09 : 0.92;
        const nextZoom = Math.min(2.6, Math.max(0.28, viewport.zoom * factor));
        const ratio = nextZoom / viewport.zoom;
        onViewportChange({
          zoom: nextZoom,
          x: mouseX - (mouseX - viewport.x) * ratio,
          y: mouseY - (mouseY - viewport.y) * ratio,
        });
      } else {
        onViewportChange({
          ...viewport,
          x: viewport.x - e.deltaX,
          y: viewport.y - e.deltaY,
        });
      }
    },
    [viewport, onViewportChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (editingId) {
      commitInlineEdit();
    }

    const world = screenToWorld(e.clientX, e.clientY);
    const screen = { x: e.clientX, y: e.clientY };

    // Middle mouse or Hand tool or Spacebar => Pan
    if (e.button === 1 || tool === "hand" || spacePressed) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({
        mode: "pan",
        startScreen: screen,
        startWorld: world,
        startViewport: { ...viewport },
        currentWorld: world,
      });
      return;
    }

    if (e.button !== 0) return;

    // Freedraw tool
    if (tool === "freedraw") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const id = uid("ink");
      onStrokeEvent?.({
        phase: "start",
        strokeId: id,
        kind: "freedraw",
        startPoint: world,
        endPoint: world,
        timestamp: Date.now(),
      });
      setDrag({
        mode: "freedraw",
        startScreen: screen,
        startWorld: world,
        startViewport: { ...viewport },
        currentWorld: world,
        draftId: id,
        freedrawPoints: [world],
      });
      return;
    }

    // Arrow tool
    if (tool === "arrow") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const hit = findShapeAtPoint(world);
      const strokeId = uid("stk");
      const startPt = hit ? getElementCenter(hit) : world;
      const fromId = hit && isShapeElement(hit) ? hit.id : undefined;
      onStrokeEvent?.({
        phase: "start",
        strokeId,
        kind: "arrow",
        startPoint: startPt,
        endPoint: world,
        fromId,
        timestamp: Date.now(),
      });
      setDrag({
        mode: "connect",
        startScreen: screen,
        startWorld: startPt,
        startViewport: { ...viewport },
        targetId: fromId,
        draftId: strokeId,
        currentWorld: world,
      });
      return;
    }

    // Shape creation tools
    if (
      tool === "node" ||
      tool === "diamond" ||
      tool === "database" ||
      tool === "ellipse" ||
      tool === "frame" ||
      tool === "text"
    ) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const strokeId = uid("stk");
      onStrokeEvent?.({
        phase: "start",
        strokeId,
        kind: tool,
        startPoint: world,
        endPoint: world,
        timestamp: Date.now(),
      });
      setDrag({
        mode: "draw_shape",
        startScreen: screen,
        startWorld: world,
        startViewport: { ...viewport },
        draftId: strokeId,
        currentWorld: world,
      });
      return;
    }

    // Select tool (Excalidraw behavior: click selects, Shift+click toggles, drag on empty canvas draws marquee box)
    const hit = findShapeAtPoint(world);
    if (hit) {
      let activeIds: string[];
      if (e.shiftKey) {
        activeIds = selectedSet.has(hit.id)
          ? selectedIds.filter((id) => id !== hit.id)
          : [...selectedIds, hit.id];
        onSelectIds(activeIds);
      } else if (selectedSet.has(hit.id) && selectedIds.length > 1) {
        activeIds = selectedIds;
      } else {
        activeIds = [hit.id];
        onSelectIds(activeIds);
      }

      if (isShapeElement(hit) && activeIds.includes(hit.id)) {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const originBoxes: Record<string, ElementBox> = {};
        for (const id of activeIds) {
          const item = elementsById.get(id);
          if (item && isShapeElement(item)) {
            originBoxes[id] = {
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height,
            };
          }
        }
        setDrag({
          mode: "move",
          startScreen: screen,
          startWorld: world,
          startViewport: { ...viewport },
          targetId: hit.id,
          originBox: {
            x: hit.x,
            y: hit.y,
            width: hit.width,
            height: hit.height,
          },
          originBoxes,
          preDragElements: elements.map((el) => ({ ...el })),
          dragStartSyncGeneration: remoteSyncGenerationRef?.current ?? 0,
          currentWorld: world,
          movedEnough: false,
        });
      }
    } else {
      const baseSelection = e.shiftKey ? selectedIds : [];
      if (!e.shiftKey) onSelectIds([]);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({
        mode: "marquee",
        startScreen: screen,
        startWorld: world,
        startViewport: { ...viewport },
        initialSelectedIds: baseSelection,
        currentWorld: world,
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const world = screenToWorld(e.clientX, e.clientY);
    onCursorMove?.(world);

    if (!drag) {
      const hit = findShapeAtPoint(world);
      setHoveredId(hit?.id ?? null);
      return;
    }

    if (drag.mode === "pan") {
      const dx = e.clientX - drag.startScreen.x;
      const dy = e.clientY - drag.startScreen.y;
      onViewportChange({
        ...drag.startViewport,
        x: drag.startViewport.x + dx,
        y: drag.startViewport.y + dy,
      });
      return;
    }

    if (drag.mode === "marquee") {
      const marqueeRect = {
        x: Math.min(drag.startWorld.x, world.x),
        y: Math.min(drag.startWorld.y, world.y),
        width: Math.abs(world.x - drag.startWorld.x),
        height: Math.abs(world.y - drag.startWorld.y),
      };

      const matched = new Set<string>(drag.initialSelectedIds ?? []);
      if (marqueeRect.width > 4 || marqueeRect.height > 4) {
        for (const el of elements) {
          if (isShapeElement(el)) {
            if (rectsOverlap(marqueeRect, getElementRect(el), 0)) {
              matched.add(el.id);
            }
          } else if (el.kind === "arrow") {
            const { start, end } = resolveArrowEndpoints(el, elementsById);
            const arrowRect = {
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.max(1, Math.abs(end.x - start.x)),
              height: Math.max(1, Math.abs(end.y - start.y)),
            };
            if (rectsOverlap(marqueeRect, arrowRect, 0)) {
              matched.add(el.id);
            }
          } else if (el.kind === "freedraw" && el.points && el.points.length > 0) {
            const anyInside = el.points.some(
              (p) =>
                p.x >= marqueeRect.x &&
                p.x <= marqueeRect.x + marqueeRect.width &&
                p.y >= marqueeRect.y &&
                p.y <= marqueeRect.y + marqueeRect.height
            );
            if (anyInside) matched.add(el.id);
          }
        }
      }
      onSelectIds(Array.from(matched));
      setDrag({ ...drag, currentWorld: world });
      return;
    }

    if (drag.mode === "move" && drag.targetId && drag.originBox) {
      const rawDx = world.x - drag.startWorld.x;
      const rawDy = world.y - drag.startWorld.y;
      const originBoxes = drag.originBoxes ?? { [drag.targetId]: drag.originBox };
      const movingIds = new Set(Object.keys(originBoxes));
      const isGroupMove = movingIds.size > 1;

      let snapDx = Math.round(rawDx);
      let snapDy = Math.round(rawDy);
      const movedEnough = Math.hypot(rawDx, rawDy) > 6;

      // Smart subtle alignment snap guides to peer centers for single-element moves
      const guides: SnapGuide[] = [];
      if (!isGroupMove) {
        const nextX = Math.round(drag.originBox.x + rawDx);
        const nextY = Math.round(drag.originBox.y + rawDy);
        const cx = nextX + drag.originBox.width / 2;
        const cy = nextY + drag.originBox.height / 2;

        for (const other of elements) {
          if (movingIds.has(other.id) || !isShapeElement(other) || other.kind === "frame") {
            continue;
          }
          const oc = getElementCenter(other);
          if (Math.abs(cy - oc.y) < 10) {
            snapDy = Math.round(oc.y - drag.originBox.height / 2 - drag.originBox.y);
            guides.push({ orientation: "h", pos: oc.y });
          }
          if (Math.abs(cx - oc.x) < 10) {
            snapDx = Math.round(oc.x - drag.originBox.width / 2 - drag.originBox.x);
            guides.push({ orientation: "v", pos: oc.x });
          }
        }
      }
      setSnapGuides(guides.slice(0, 2));

      onElementsChange(
        (prev) =>
          prev.map((el) => {
            const orig = originBoxes[el.id];
            if (!orig) return el;
            return {
              ...el,
              x: Math.round(orig.x + snapDx),
              y: Math.round(orig.y + snapDy),
              updatedAt: Date.now(),
            };
          }),
        { recordUndo: false, throttleBroadcast: true }
      );
      setDrag({ ...drag, currentWorld: world, movedEnough });
      return;
    }

    if (drag.mode === "resize" && drag.targetId && drag.originBox) {
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      const nextW = Math.max(88, Math.round(drag.originBox.width + dx));
      const nextH = Math.max(48, Math.round(drag.originBox.height + dy));
      onElementsChange(
        (prev) =>
          prev.map((el) =>
            el.id === drag.targetId
              ? { ...el, width: nextW, height: nextH, updatedAt: Date.now() }
              : el
          ),
        { recordUndo: false, throttleBroadcast: true }
      );
      setDrag({ ...drag, currentWorld: world, movedEnough: true });
      return;
    }

    if (drag.mode === "connect") {
      const hit = findShapeAtPoint(world, drag.targetId);
      if (drag.draftId) {
        onStrokeEvent?.({
          phase: "move",
          strokeId: drag.draftId,
          kind: "arrow",
          startPoint: drag.startWorld,
          endPoint: world,
          fromId: drag.targetId,
          toId: hit && isShapeElement(hit) && hit.kind !== "frame" ? hit.id : undefined,
          timestamp: Date.now(),
        });
      }
      setDrag({
        ...drag,
        currentWorld: world,
        hoverTargetId: hit && isShapeElement(hit) && hit.kind !== "frame" ? hit.id : null,
      });
      return;
    }

    if (drag.mode === "draw_shape") {
      if (drag.draftId) {
        onStrokeEvent?.({
          phase: "move",
          strokeId: drag.draftId,
          kind: tool as ElementKind,
          startPoint: drag.startWorld,
          endPoint: world,
          timestamp: Date.now(),
        });
      }
      setDrag({ ...drag, currentWorld: world });
      return;
    }

    if (drag.mode === "freedraw") {
      const pts = drag.freedrawPoints ?? [];
      const last = pts[pts.length - 1];
      if (!last || distanceBetween(last, world) > 3) {
        if (drag.draftId) {
          onStrokeEvent?.({
            phase: "move",
            strokeId: drag.draftId,
            kind: "freedraw",
            startPoint: drag.startWorld,
            endPoint: world,
            timestamp: Date.now(),
          });
        }
        setDrag({
          ...drag,
          currentWorld: world,
          freedrawPoints: [...pts, world],
        });
      }
    }
  };

  const handlePointerUp = () => {
    if (!drag) return;
    setSnapGuides([]);
    const currentSyncGen = remoteSyncGenerationRef?.current ?? 0;
    const remoteChangedMidDrag =
      drag.dragStartSyncGeneration !== undefined &&
      drag.dragStartSyncGeneration !== currentSyncGen;

    if (drag.mode === "move" && drag.targetId && drag.originBox && drag.movedEnough) {
      const origin = drag.originBox;
      const nextElements = onElementsChange(
        (prev) =>
          prev.map((el) =>
            el.id === drag.targetId
              ? { ...el, updatedAt: Date.now() }
              : el
          ),
        {
          recordUndo: !remoteChangedMidDrag,
          undoSnapshot: remoteChangedMidDrag ? undefined : drag.preDragElements,
          expectedRemoteSyncGeneration: drag.dragStartSyncGeneration,
          flushBroadcast: true,
        }
      );
      const movedFinal = nextElements.find((el) => el.id === drag.targetId);
      if (movedFinal) {
        onElementMoved(movedFinal, origin);
      }
    }

    if (drag.mode === "resize" && drag.targetId && drag.originBox && drag.movedEnough) {
      onElementsChange(
        (prev) =>
          prev.map((el) =>
            el.id === drag.targetId
              ? { ...el, updatedAt: Date.now() }
              : el
          ),
        {
          recordUndo: !remoteChangedMidDrag,
          undoSnapshot: remoteChangedMidDrag ? undefined : drag.preDragElements,
          expectedRemoteSyncGeneration: drag.dragStartSyncGeneration,
          flushBroadcast: true,
        }
      );
    }

    if (drag.mode === "connect") {
      const dist = distanceBetween(drag.startWorld, drag.currentWorld);
      if (dist > 24) {
        const fromId = drag.targetId;
        const toId = drag.hoverTargetId ?? undefined;
        const now = Date.now();

        if (fromId && toId && fromId !== toId) {
          const arrowId = uid("arr");
          const arrow: JevElement = {
            id: arrowId,
            kind: "arrow",
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            label: "",
            tone: "ink",
            seed: makeSeed(arrowId),
            fromId,
            toId,
            arrowStyle: "curved",
            createdAt: now,
            updatedAt: now,
          };
          onElementsChange((prev) => [...prev, arrow], { recordUndo: true });
          if (drag.draftId) {
            onStrokeEvent?.({
              phase: "end",
              strokeId: drag.draftId,
              elementId: arrowId,
              kind: "arrow",
              startPoint: drag.startWorld,
              endPoint: drag.currentWorld,
              fromId,
              toId,
              label: "",
              timestamp: now,
            });
          }
          const targetEl = elementsById.get(toId);
          if (targetEl) onElementCreated(targetEl);
        } else if (fromId && !toId) {
          // Dropping an arrow on open space spawns a brand new connected node right there!
          const newNodeId = uid("el");
          const newNode: JevElement = {
            id: newNodeId,
            kind: "node",
            x: Math.round(drag.currentWorld.x - 84),
            y: Math.round(drag.currentWorld.y - 36),
            width: 168,
            height: 72,
            label: "New Step",
            tone: "cobalt",
            seed: makeSeed(newNodeId),
            createdAt: now,
            updatedAt: now,
          };
          const arrowId = uid("arr");
          const arrow: JevElement = {
            id: arrowId,
            kind: "arrow",
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            label: "",
            tone: "ink",
            seed: makeSeed(arrowId),
            fromId,
            toId: newNodeId,
            arrowStyle: "curved",
            createdAt: now,
            updatedAt: now,
          };
          onElementsChange((prev) => [...prev, newNode, arrow], {
            recordUndo: true,
          });
          if (drag.draftId) {
            onStrokeEvent?.({
              phase: "end",
              strokeId: drag.draftId,
              elementId: arrowId,
              kind: "arrow",
              startPoint: drag.startWorld,
              endPoint: drag.currentWorld,
              fromId,
              toId: newNodeId,
              label: "",
              timestamp: now,
            });
          }
          onSelectIds([talkToDrawActive ? arrowId : newNodeId]);
          if (!talkToDrawActive) {
            setEditingId(newNodeId);
            setEditingText("New Step");
          }
          onElementCreated(newNode);
        } else {
          // Free-floating arrow
          const arrowId = uid("arr");
          const arrow: JevElement = {
            id: arrowId,
            kind: "arrow",
            x: drag.startWorld.x,
            y: drag.startWorld.y,
            width: drag.currentWorld.x - drag.startWorld.x,
            height: drag.currentWorld.y - drag.startWorld.y,
            fromPoint: drag.startWorld,
            toPoint: drag.currentWorld,
            label: "",
            tone: "ink",
            seed: makeSeed(arrowId),
            arrowStyle: "curved",
            createdAt: now,
            updatedAt: now,
          };
          onElementsChange((prev) => [...prev, arrow], { recordUndo: true });
          if (drag.draftId) {
            onStrokeEvent?.({
              phase: "end",
              strokeId: drag.draftId,
              elementId: arrowId,
              kind: "arrow",
              startPoint: drag.startWorld,
              endPoint: drag.currentWorld,
              label: "",
              timestamp: now,
            });
          }
        }
        if (tool === "arrow") onToolChange("select");
      }
    }

    if (drag.mode === "draw_shape") {
      const kind = tool as ElementKind;
      const wRaw = Math.abs(drag.currentWorld.x - drag.startWorld.x);
      const hRaw = Math.abs(drag.currentWorld.y - drag.startWorld.y);
      const defaults: Record<string, { w: number; h: number; label: string }> = {
        node: { w: 172, h: 72, label: "Service" },
        diamond: { w: 148, h: 96, label: "Condition?" },
        database: { w: 156, h: 86, label: "Database" },
        ellipse: { w: 152, h: 74, label: "User" },
        frame: { w: 340, h: 220, label: "System Zone" },
        text: { w: 180, h: 42, label: "Note" },
      };
      const def = defaults[kind] ?? defaults.node;
      const useDragged = wRaw > 30 && hRaw > 24;
      const width = useDragged ? Math.round(wRaw) : def.w;
      const height = useDragged ? Math.round(hRaw) : def.h;
      const x = useDragged
        ? Math.round(Math.min(drag.startWorld.x, drag.currentWorld.x))
        : Math.round(drag.startWorld.x - width / 2);
      const y = useDragged
        ? Math.round(Math.min(drag.startWorld.y, drag.currentWorld.y))
        : Math.round(drag.startWorld.y - height / 2);

      const id = uid(kind === "frame" ? "frm" : "el");
      const now = Date.now();
      const created: JevElement = {
        id,
        kind,
        x,
        y,
        width,
        height,
        label: def.label,
        tone: kind === "frame" ? "slate" : inferToneFromLabel(def.label),
        seed: makeSeed(id),
        createdAt: now,
        updatedAt: now,
      };
      onElementsChange(
        (prev) => (kind === "frame" ? [created, ...prev] : [...prev, created]),
        { recordUndo: true }
      );
      if (drag.draftId) {
        onStrokeEvent?.({
          phase: "end",
          strokeId: drag.draftId,
          elementId: id,
          kind,
          startPoint: { x, y },
          endPoint: { x: x + width, y: y + height },
          label: def.label,
          timestamp: now,
        });
      }
      onSelectIds([id]);
      if (!talkToDrawActive) {
        setEditingId(id);
        setEditingText(def.label);
      }
      onElementCreated(created);
      onToolChange("select");
    }

    if (drag.mode === "freedraw" && drag.freedrawPoints && drag.freedrawPoints.length > 2) {
      const id = drag.draftId ?? uid("ink");
      const now = Date.now();
      const ink: JevElement = {
        id,
        kind: "freedraw",
        x: drag.freedrawPoints[0].x,
        y: drag.freedrawPoints[0].y,
        width: 0,
        height: 0,
        label: "",
        tone: "ink",
        seed: makeSeed(id),
        points: drag.freedrawPoints,
        createdAt: now,
        updatedAt: now,
      };
      onElementsChange((prev) => [...prev, ink], { recordUndo: true });
      const firstPt = drag.freedrawPoints[0];
      const lastPt = drag.freedrawPoints[drag.freedrawPoints.length - 1];
      onStrokeEvent?.({
        phase: "end",
        strokeId: id,
        elementId: id,
        kind: "freedraw",
        startPoint: firstPt,
        endPoint: lastPt,
        label: "",
        timestamp: now,
      });
    }

    setDrag(null);
  };

  const handlePointerCancel = (e: React.PointerEvent) => {
    try {
      const target = e.currentTarget as HTMLElement;
      if (target.hasPointerCapture?.(e.pointerId)) {
        target.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore pointer capture release errors
    }

    setSnapGuides([]);
    if (!drag) return;

    const decision = resolvePointerCancelDecision({
      mode: drag.mode,
      movedEnough: drag.movedEnough,
      hasPreDragElements: Boolean(drag.preDragElements),
      dragStartSyncGeneration: drag.dragStartSyncGeneration,
      currentSyncGeneration: remoteSyncGenerationRef?.current ?? 0,
    });

    if (decision.shouldRestorePreDrag && drag.preDragElements) {
      const restoreSnapshot = drag.preDragElements;
      onElementsChange(() => restoreSnapshot, {
        recordUndo: false,
        flushBroadcast: true,
      });
    }

    setDrag(null);
  };

  const startHandleConnect = useCallback(
    (e: React.PointerEvent, el: JevElement, handlePoint: Point) => {
      e.stopPropagation();
      containerRef.current?.setPointerCapture(e.pointerId);
      const strokeId = uid("stk");
      onStrokeEvent?.({
        phase: "start",
        strokeId,
        kind: "arrow",
        startPoint: handlePoint,
        endPoint: handlePoint,
        fromId: el.id,
        timestamp: Date.now(),
      });
      setDrag({
        mode: "connect",
        startScreen: { x: e.clientX, y: e.clientY },
        startWorld: handlePoint,
        startViewport: { ...viewport },
        targetId: el.id,
        draftId: strokeId,
        currentWorld: handlePoint,
      });
    },
    [onStrokeEvent, viewport]
  );

  const startResize = (e: React.PointerEvent, el: JevElement) => {
    e.stopPropagation();
    containerRef.current?.setPointerCapture(e.pointerId);
    setDrag({
      mode: "resize",
      startScreen: { x: e.clientX, y: e.clientY },
      startWorld: screenToWorld(e.clientX, e.clientY),
      startViewport: { ...viewport },
      targetId: el.id,
      originBox: {
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
      },
      preDragElements: elements.map((item) => ({ ...item })),
      dragStartSyncGeneration: remoteSyncGenerationRef?.current ?? 0,
      currentWorld: screenToWorld(e.clientX, e.clientY),
      movedEnough: false,
    });
  };

  const startDoubleClickEdit = (el: JevElement) => {
    if (el.kind === "freedraw") return;
    onSelectIds([el.id]);
    setEditingId(el.id);
    setEditingText(el.label);
  };

  const ghostStroke = theme === "midnight" ? "#38BDF8" : "#2563EB";
  const ghostFill =
    theme === "midnight"
      ? "rgba(56, 189, 248, 0.12)"
      : "rgba(37, 99, 235, 0.085)";
  const accentColor = theme === "midnight" ? "#F0643E" : "#D94E28";

  // Sort layers cleanly: frames -> arrows -> freedraw -> shapes
  const frames = elements.filter((e) => e.kind === "frame");
  const arrows = elements.filter((e) => e.kind === "arrow");
  const freedraws = elements.filter((e) => e.kind === "freedraw");
  const shapes = elements.filter(
    (e) => isShapeElement(e) && e.kind !== "frame"
  );

  // Active ghost elements (either live prompt preview OR active Tab prediction)
  const ghostItems: JevElement[] =
    promptPreviewElements.length > 0
      ? promptPreviewElements
      : activePrediction?.addElements ?? [];
  const ghostFrames = ghostItems.filter((e) => e.kind === "frame");
  const ghostArrows = ghostItems.filter((e) => e.kind === "arrow");
  const ghostShapes = ghostItems.filter(
    (e) => isShapeElement(e) && e.kind !== "frame"
  );

  const cursorClass =
    drag?.mode === "pan"
      ? "cursor-grabbing"
      : tool === "hand" || spacePressed
        ? "cursor-grab"
        : tool === "select"
          ? "cursor-default"
          : "cursor-crosshair";

  const labelFontClass =
    renderStyle === "sketch" ? "font-sketch" : "font-sans";

  const gridSpacing = 28 * viewport.zoom;
  const gridOffsetX = ((viewport.x % gridSpacing) + gridSpacing) % gridSpacing;
  const gridOffsetY = ((viewport.y % gridSpacing) + gridSpacing) % gridSpacing;

  const editingElement = editingId ? elementsById.get(editingId) : null;

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className={`relative h-full w-full select-none overflow-hidden touch-none ${cursorClass}`}
      style={{
        backgroundColor: "var(--jev-paper)",
        backgroundImage: `radial-gradient(circle, var(--jev-grid-dot) ${Math.max(0.8, Math.min(1.5, viewport.zoom * 1.15))}px, transparent 1px)`,
        backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
        backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px`,
      }}
    >
      <svg
        ref={svgRef}
        className="h-full w-full overflow-visible"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {/* 1. FRAMES */}
          {frames.map((el) => {
            const pal = getTonePalette(el.tone, theme);
            const isSelected = selectedSet.has(el.id);
            const isBeingReplaced = removedGhostSet.has(el.id);
            return (
              <g
                key={el.id}
                opacity={isBeingReplaced ? (forkActive ? 0.34 : 0.22) : 1}
                transform={`translate(${el.x}, ${el.y})`}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  startDoubleClickEdit(el);
                }}
              >
                <ShapePathsMemo
                  el={el}
                  stroke={isSelected ? accentColor : pal.stroke}
                  fill={pal.fill}
                  renderStyle={renderStyle}
                />
                <text
                  x={16}
                  y={24}
                  fill={pal.subtext}
                  className="font-mono text-[11px] font-medium uppercase tracking-[0.09em]"
                >
                  {el.label}
                </text>
                {isSelected && (
                  <rect
                    x={el.width - 6}
                    y={el.height - 6}
                    width={12}
                    height={12}
                    rx={3}
                    fill={accentColor}
                    className="cursor-nwse-resize"
                    onPointerDown={(ev) => startResize(ev, el)}
                  />
                )}
              </g>
            );
          })}

          {/* 2. ALIGNMENT SNAP GUIDES */}
          {snapGuides.map((g, idx) =>
            g.orientation === "h" ? (
              <line
                key={idx}
                x1={-4000}
                y1={g.pos}
                x2={4000}
                y2={g.pos}
                stroke={accentColor}
                strokeOpacity={0.35}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ) : (
              <line
                key={idx}
                x1={g.pos}
                y1={-4000}
                x2={g.pos}
                y2={4000}
                stroke={accentColor}
                strokeOpacity={0.35}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            )
          )}

          {/* 4. ARROWS */}
          {arrows.map((arrow) => {
            const pal = getTonePalette(arrow.tone, theme);
            const { start, end, control } = resolveArrowEndpoints(
              arrow,
              elementsById
            );
            const isSelected = selectedSet.has(arrow.id);
            const isBeingReplaced = removedGhostSet.has(arrow.id);
            const stroke = isSelected ? accentColor : pal.stroke;
            const paths = generateArrowPath(
              start,
              control,
              end,
              arrow.seed,
              stroke,
              renderStyle,
              arrow.dashed
            );
            const isLifeline = arrow.morphMeta?.role === "lifeline";
            const headEnd = isLifeline
              ? null
              : computeArrowHeadPath(control, end, 8.5);
            const headStart =
              arrow.bidirectional && !isLifeline
                ? computeArrowHeadPath(control, start, 8.5)
                : null;

            const labelX = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
            const labelY = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;

            return (
              <g
                key={arrow.id}
                opacity={isBeingReplaced ? (forkActive ? 0.34 : 0.25) : 1}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  startDoubleClickEdit(arrow);
                }}
              >
                {paths.map((p, idx) => (
                  <path
                    key={idx}
                    d={p.d}
                    stroke={p.stroke}
                    strokeWidth={isSelected ? 1.9 : p.strokeWidth}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={
                      arrow.dashed && renderStyle === "clean" ? "6 5" : undefined
                    }
                  />
                ))}
                {headEnd && (
                  <path
                    d={headEnd}
                    stroke={stroke}
                    strokeWidth={isSelected ? 1.85 : 1.45}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {headStart && (
                  <path
                    d={headStart}
                    stroke={stroke}
                    strokeWidth={isSelected ? 1.85 : 1.45}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {arrow.label && (
                  <g transform={`translate(${labelX}, ${labelY})`}>
                    <rect
                      x={-(arrow.label.length * 3.6 + 9)}
                      y={-11}
                      width={arrow.label.length * 7.2 + 18}
                      height={20}
                      rx={6}
                      fill={theme === "midnight" ? "#151A24" : "#FAF8F2"}
                      stroke={stroke}
                      strokeOpacity={0.2}
                      strokeWidth={1}
                    />
                    <text
                      x={0}
                      y={3}
                      textAnchor="middle"
                      fill={pal.subtext}
                      className="font-mono text-[10.5px] font-medium"
                    >
                      {arrow.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* 5. FREEDRAW STROKES */}
          {freedraws.map((dr) => {
            if (!dr.points || dr.points.length < 2) return null;
            const pal = getTonePalette(dr.tone, theme);
            const isSelected = selectedSet.has(dr.id);
            return (
              <path
                key={dr.id}
                d={smoothFreedrawPath(dr.points)}
                stroke={isSelected ? accentColor : pal.stroke}
                strokeWidth={2.4}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}

          {/* Live in-progress freedraw stroke */}
          {drag?.mode === "freedraw" &&
            drag.freedrawPoints &&
            drag.freedrawPoints.length > 1 && (
              <path
                d={smoothFreedrawPath(drag.freedrawPoints)}
                stroke={accentColor}
                strokeWidth={2.4}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

          {/* 6. SHAPES (Nodes, Diamonds, Databases, Ellipses, Text) */}
          {shapes.map((el) => {
            const pal = getTonePalette(el.tone, theme);
            const isSelected = selectedSet.has(el.id);
            const isBeingReplaced = removedGhostSet.has(el.id);
            const isHovered = el.id === hoveredId;
            const isConnectTarget = drag?.hoverTargetId === el.id;
            const handles = getEdgeHandles(el);

            return (
              <g
                key={el.id}
                opacity={isBeingReplaced ? (forkActive ? 0.34 : 0.22) : 1}
                transform={`translate(${el.x}, ${el.y})`}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  startDoubleClickEdit(el);
                }}
              >
                {/* Connect target glow */}
                {isConnectTarget && (
                  <rect
                    x={-7}
                    y={-7}
                    width={el.width + 14}
                    height={el.height + 14}
                    rx={16}
                    fill="none"
                    stroke={ghostStroke}
                    strokeWidth={2.5}
                    strokeDasharray="6 4"
                  />
                )}

                {el.kind !== "text" && (
                  <ShapePathsMemo
                    el={el}
                    stroke={isSelected ? accentColor : pal.stroke}
                    fill={pal.fill}
                    renderStyle={renderStyle}
                  />
                )}

                {/* Clean title + ER entity card / state sublabel rendering */}
                {editingId !== el.id &&
                  (el.morphMeta?.role === "entity" && el.sublabel ? (
                    <foreignObject
                      x={8}
                      y={6}
                      width={Math.max(20, el.width - 16)}
                      height={Math.max(20, el.height - 12)}
                      className="pointer-events-none"
                    >
                      <div className="flex h-full w-full flex-col overflow-hidden text-left">
                        <div
                          className="border-b pb-1 text-center"
                          style={{ borderColor: `${pal.stroke}33` }}
                        >
                          <span
                            className={`${labelFontClass} block truncate text-[13px] font-bold tracking-[-0.01em]`}
                            style={{ color: pal.text }}
                          >
                            {el.label}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-col gap-0.5 px-1">
                          {el.sublabel
                            .split("\n")
                            .map((line) => line.trim())
                            .filter(Boolean)
                            .slice(0, 5)
                            .map((attr, idx) => (
                              <span
                                key={idx}
                                className="block truncate font-mono text-[10px] leading-snug"
                                style={{ color: pal.subtext }}
                              >
                                {attr}
                              </span>
                            ))}
                        </div>
                      </div>
                    </foreignObject>
                  ) : (
                    <foreignObject
                      x={el.kind === "diamond" ? 18 : 10}
                      y={el.kind === "database" ? 16 : 6}
                      width={Math.max(20, el.width - (el.kind === "diamond" ? 36 : 20))}
                      height={Math.max(20, el.height - (el.kind === "database" ? 22 : 12))}
                      className="pointer-events-none"
                    >
                      <div className="flex h-full w-full flex-col items-center justify-center text-center leading-tight">
                        <span
                          className={`${labelFontClass} text-[14px] font-semibold tracking-[-0.01em] break-words`}
                          style={{ color: pal.text }}
                        >
                          {el.label}
                        </span>
                        {el.sublabel && (
                          <span
                            className="mt-0.5 block max-w-full truncate font-mono text-[9.5px] font-medium"
                            style={{ color: pal.subtext }}
                          >
                            {el.sublabel}
                          </span>
                        )}
                      </div>
                    </foreignObject>
                  ))}

                {/* Selection outline & resize handle */}
                {isSelected && !forkActive && (
                  <>
                    <rect
                      x={-5}
                      y={-5}
                      width={el.width + 10}
                      height={el.height + 10}
                      rx={14}
                      fill="none"
                      stroke={accentColor}
                      strokeOpacity={0.45}
                      strokeWidth={1.25}
                      strokeDasharray="4 4"
                      className="pointer-events-none"
                    />
                    {isSelected && primarySelectedId === el.id && (
                      <rect
                        x={el.width - 5}
                        y={el.height - 5}
                        width={11}
                        height={11}
                        rx={3}
                        fill={accentColor}
                        stroke={theme === "midnight" ? "#11151D" : "#FFFFFF"}
                        strokeWidth={1.5}
                        className="cursor-nwse-resize"
                        onPointerDown={(ev) => startResize(ev, el)}
                      />
                    )}
                  </>
                )}

                {/* Quick edge connection handles on hover/select */}
                {(isSelected || isHovered) && !forkActive && tool === "select" && el.kind !== "text" && (
                  <>
                    {handles.map((h) => (
                      <circle
                        key={h.side}
                        cx={h.point.x - el.x}
                        cy={h.point.y - el.y}
                        r={5}
                        fill={theme === "midnight" ? "#181D28" : "#FFFDF8"}
                        stroke={accentColor}
                        strokeWidth={2}
                        className="cursor-crosshair transition-transform hover:scale-125"
                        onPointerDown={(ev) =>
                          startHandleConnect(ev, el, h.point)
                        }
                      />
                    ))}
                  </>
                )}
              </g>
            );
          })}

          {/* 7. GHOST PREDICTION / LIVE PROMPT PREVIEW LAYER */}
          {ghostFrames.map((el) => (
            <g
              key={`ghost_${el.id}`}
              transform={`translate(${el.x}, ${el.y})`}
              className="pointer-events-none jev-ghost-pulse"
            >
              <ShapePathsMemo
                el={el}
                stroke={ghostStroke}
                fill={ghostFill}
                renderStyle="clean"
                isGhost
              />
              <text
                x={16}
                y={24}
                fill={ghostStroke}
                className="font-mono text-[11px] font-medium uppercase tracking-[0.09em]"
              >
                {el.label} · ghost
              </text>
            </g>
          ))}

          {/* Ghost patch preview (e.g. aligning a row OR Talk-to-Draw label update) */}
          {promptPreviewElements.length === 0 &&
            activePrediction?.patchElements?.map((patch) => {
              const target = elementsById.get(patch.id);
              if (!target) return null;

              const hasMove = patch.x !== undefined || patch.y !== undefined;
              const hasLabel =
                typeof patch.label === "string" &&
                patch.label.trim().length > 0 &&
                patch.label.trim() !== target.label.trim();

              if (!hasMove && !hasLabel) return null;

              if (!hasMove && hasLabel) {
                if (target.kind === "arrow") {
                  const patchedArrow: JevElement = {
                    ...target,
                    ...(patch.toId !== undefined ? { toId: patch.toId } : {}),
                    ...(patch.fromId !== undefined ? { fromId: patch.fromId } : {}),
                  };
                  const { start, end, control } = resolveArrowEndpoints(
                    patchedArrow,
                    ghostElementsMap
                  );
                  const lx = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
                  const ly = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;
                  const lbl = patch.label!.trim();
                  const pillW = Math.max(48, lbl.length * 7.2 + 22);
                  return (
                    <g
                      key={`ghost_patch_lbl_${patch.id}`}
                      className="pointer-events-none jev-ghost-pulse"
                    >
                      <path
                        d={`M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`}
                        stroke={ghostStroke}
                        strokeWidth={2}
                        fill="none"
                        strokeDasharray="6 5"
                        className="jev-ghost-dash"
                      />
                      <g transform={`translate(${lx}, ${ly})`}>
                        <rect
                          x={-pillW / 2}
                          y={-12}
                          width={pillW}
                          height={22}
                          rx={7}
                          fill={ghostStroke}
                        />
                        <text
                          x={0}
                          y={3}
                          textAnchor="middle"
                          fill="#FFFFFF"
                          className="font-mono text-[10.5px] font-semibold"
                        >
                          {lbl}
                        </text>
                      </g>
                    </g>
                  );
                }

                // Shape label update ghost preview
                const lbl = patch.label!.trim();
                const pillW = Math.max(76, lbl.length * 7.4 + 26);
                return (
                  <g
                    key={`ghost_patch_lbl_${patch.id}`}
                    className="pointer-events-none jev-ghost-pulse"
                  >
                    <rect
                      x={target.x - 4}
                      y={target.y - 4}
                      width={target.width + 8}
                      height={target.height + 8}
                      rx={13}
                      fill={ghostFill}
                      stroke={ghostStroke}
                      strokeWidth={2}
                      strokeDasharray="7 5"
                      className="jev-ghost-dash"
                    />
                    <g
                      transform={`translate(${target.x + target.width / 2}, ${target.y - 16})`}
                    >
                      <rect
                        x={-pillW / 2}
                        y={-11}
                        width={pillW}
                        height={21}
                        rx={7}
                        fill={ghostStroke}
                      />
                      <text
                        x={0}
                        y={3.5}
                        textAnchor="middle"
                        fill="#FFFFFF"
                        className="font-mono text-[10.5px] font-semibold"
                      >
                        {lbl}
                      </text>
                    </g>
                  </g>
                );
              }

              const px = patch.x ?? target.x;
              const py = patch.y ?? target.y;
              const tc = getElementCenter(target);
              const pc = { x: px + target.width / 2, y: py + target.height / 2 };
              return (
                <g
                  key={`ghost_patch_${patch.id}`}
                  className="pointer-events-none jev-ghost-pulse"
                >
                  <line
                    x1={tc.x}
                    y1={tc.y}
                    x2={pc.x}
                    y2={pc.y}
                    stroke={ghostStroke}
                    strokeWidth={1.6}
                    strokeDasharray="5 4"
                    className="jev-ghost-dash"
                  />
                  <rect
                    x={px}
                    y={py}
                    width={target.width}
                    height={target.height}
                    rx={12}
                    fill={ghostFill}
                    stroke={ghostStroke}
                    strokeWidth={2}
                    strokeDasharray="7 5"
                    className="jev-ghost-dash"
                  />
                </g>
              );
            })}

          {ghostArrows.map((arrow) => {
            const { start, end, control } = resolveArrowEndpoints(
              arrow,
              ghostElementsMap
            );
            const d = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
            const head = computeArrowHeadPath(control, end, 8);
            const labelX = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
            const labelY = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;
            return (
              <g
                key={`ghost_${arrow.id}`}
                className="pointer-events-none jev-ghost-pulse"
              >
                <path
                  d={d}
                  stroke={ghostStroke}
                  strokeWidth={1.5}
                  fill="none"
                  strokeDasharray="6 5"
                  className="jev-ghost-dash"
                />
                <path
                  d={head}
                  stroke={ghostStroke}
                  strokeWidth={1.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {arrow.label && (
                  <g transform={`translate(${labelX}, ${labelY})`}>
                    <rect
                      x={-(arrow.label.length * 3.5 + 8)}
                      y={-10}
                      width={arrow.label.length * 7 + 16}
                      height={18}
                      rx={5}
                      fill={theme === "midnight" ? "#151A24" : "#FAF8F2"}
                      stroke={ghostStroke}
                      strokeOpacity={0.35}
                      strokeWidth={1}
                    />
                    <text
                      x={0}
                      y={3}
                      textAnchor="middle"
                      fill={ghostStroke}
                      className="font-mono text-[10px] font-medium"
                    >
                      {arrow.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {ghostShapes.map((el, idx) => (
            <g
              key={`ghost_${el.id}`}
              transform={`translate(${el.x}, ${el.y})`}
              className="pointer-events-none jev-ghost-pulse"
            >
              <ShapePathsMemo
                el={el}
                stroke={ghostStroke}
                fill={ghostFill}
                renderStyle="clean"
                isGhost
              />
              <foreignObject
                x={el.kind === "diamond" ? 18 : 10}
                y={el.kind === "database" ? 16 : 6}
                width={Math.max(20, el.width - (el.kind === "diamond" ? 36 : 20))}
                height={Math.max(20, el.height - (el.kind === "database" ? 22 : 12))}
              >
                <div className="flex h-full w-full flex-col items-center justify-center text-center leading-tight">
                  <span
                    className="font-sans text-[13.5px] font-semibold break-words"
                    style={{ color: ghostStroke }}
                  >
                    {el.label}
                  </span>
                  {el.sublabel && (
                    <span
                      className="mt-0.5 block max-w-full truncate font-mono text-[9.5px] font-medium opacity-80"
                      style={{ color: ghostStroke }}
                    >
                      {el.sublabel}
                    </span>
                  )}
                </div>
              </foreignObject>
              {idx === 0 && (
                <g transform={`translate(${Math.max(0, el.width - 62)}, -11)`}>
                  <rect
                    x={0}
                    y={0}
                    width={62}
                    height={19}
                    rx={6}
                    fill={ghostStroke}
                  />
                  <text
                    x={31}
                    y={13}
                    textAnchor="middle"
                    fill="#FFFFFF"
                    className="font-mono text-[9.5px] font-semibold"
                  >
                    Enter ↵
                  </text>
                </g>
              )}
            </g>
          ))}

          {/* 8. LIVE IN-PROGRESS ARROW / SHAPE DRAG PREVIEW */}
          {drag?.mode === "connect" && (
            <g className="pointer-events-none">
              <line
                x1={drag.startWorld.x}
                y1={drag.startWorld.y}
                x2={drag.currentWorld.x}
                y2={drag.currentWorld.y}
                stroke={accentColor}
                strokeWidth={2}
                strokeDasharray="6 4"
              />
              <path
                d={computeArrowHeadPath(drag.startWorld, drag.currentWorld, 10)}
                stroke={accentColor}
                strokeWidth={2}
                fill="none"
              />
            </g>
          )}

          {drag?.mode === "draw_shape" && (
            <rect
              x={Math.min(drag.startWorld.x, drag.currentWorld.x)}
              y={Math.min(drag.startWorld.y, drag.currentWorld.y)}
              width={Math.max(4, Math.abs(drag.currentWorld.x - drag.startWorld.x))}
              height={Math.max(4, Math.abs(drag.currentWorld.y - drag.startWorld.y))}
              rx={10}
              fill={ghostFill}
              stroke={accentColor}
              strokeWidth={1.6}
              strokeDasharray="5 4"
              className="pointer-events-none"
            />
          )}

          {drag?.mode === "marquee" && (
            <rect
              x={Math.min(drag.startWorld.x, drag.currentWorld.x)}
              y={Math.min(drag.startWorld.y, drag.currentWorld.y)}
              width={Math.max(1, Math.abs(drag.currentWorld.x - drag.startWorld.x))}
              height={Math.max(1, Math.abs(drag.currentWorld.y - drag.startWorld.y))}
              rx={4}
              fill={ghostFill}
              stroke={ghostStroke}
              strokeWidth={1.4 / viewport.zoom}
              className="pointer-events-none"
            />
          )}

          {/* Multi-selection group bounding box (or subtle dimmed Before frame during Fork) */}
          {selectedIds.length > 1 &&
            (() => {
              const selectedEls = elements.filter((e) => selectedSet.has(e.id));
              const groupBounds = computeBounds(selectedEls);
              if (!groupBounds) return null;
              return (
                <g className="pointer-events-none">
                  <rect
                    x={groupBounds.x - 10}
                    y={groupBounds.y - 10}
                    width={groupBounds.width + 20}
                    height={groupBounds.height + 20}
                    rx={14}
                    fill="none"
                    stroke={forkActive ? accentColor : ghostStroke}
                    strokeOpacity={forkActive ? 0.35 : 0.55}
                    strokeWidth={1.4 / viewport.zoom}
                    strokeDasharray={`${6 / viewport.zoom} ${4 / viewport.zoom}`}
                  />
                  {forkActive && (
                    <g
                      transform={`translate(${groupBounds.x - 6}, ${groupBounds.y - 26})`}
                    >
                      <rect
                        x={0}
                        y={0}
                        width={64}
                        height={18}
                        rx={5}
                        fill={theme === "midnight" ? "#1E2432" : "#EDE8DD"}
                        stroke={accentColor}
                        strokeOpacity={0.35}
                        strokeWidth={1}
                      />
                      <text
                        x={32}
                        y={12.5}
                        textAnchor="middle"
                        fill={accentColor}
                        className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em]"
                      >
                        Current
                      </text>
                    </g>
                  )}
                </g>
              );
            })()}

          {/* 9. LIVE REMOTE PEER CURSORS (WebRTC / BroadcastChannel) */}
          {peers.map((peer) => (
            <g
              key={peer.peerId}
              transform={`translate(${peer.x}, ${peer.y})`}
              className="pointer-events-none transition-transform duration-75"
            >
              <path
                d="M 0 0 L 4 17 L 8.5 11.5 L 15 10.5 Z"
                fill={peer.color}
                stroke="#FFFFFF"
                strokeWidth={1.4}
                strokeLinejoin="round"
              />
              <g transform="translate(13, 14)">
                <rect
                  x={0}
                  y={0}
                  width={Math.max(66, peer.name.length * 7.2 + 26)}
                  height={22}
                  rx={7}
                  fill={peer.color}
                />
                <text
                  x={9}
                  y={14.5}
                  fill="#FFFFFF"
                  className="font-sans text-[11px] font-medium"
                >
                  {peer.name}
                  {peer.transport === "webrtc" ? " · P2P" : ""}
                </text>
              </g>
            </g>
          ))}
        </g>
      </svg>

      {/* SEAMLESS IN-PLACE TITLE EDITOR */}
      {editingElement && (() => {
        const editPal = getTonePalette(editingElement.tone, theme);
        const isArrow = editingElement.kind === "arrow";
        const isFrame = editingElement.kind === "frame";
        const arrowMid = isArrow
          ? resolveArrowEndpoints(editingElement, elementsById)
          : null;
        const left = isArrow && arrowMid
          ? viewport.x + ((arrowMid.start.x + arrowMid.end.x) / 2) * viewport.zoom - 64
          : isFrame
            ? viewport.x + (editingElement.x + 12) * viewport.zoom
            : viewport.x + (editingElement.x + 10) * viewport.zoom;
        const top = isArrow && arrowMid
          ? viewport.y + ((arrowMid.start.y + arrowMid.end.y) / 2) * viewport.zoom - 14
          : isFrame
            ? viewport.y + (editingElement.y + 6) * viewport.zoom
            : viewport.y +
              (editingElement.y +
                (editingElement.kind === "database"
                  ? editingElement.height * 0.54
                  : editingElement.height / 2)) *
                viewport.zoom -
              Math.max(12, 11 * viewport.zoom);
        const width = isArrow
          ? 128
          : isFrame
            ? Math.max(130, 180 * viewport.zoom)
            : Math.max(96, (editingElement.width - 20) * viewport.zoom);
        const fontSize = isArrow
          ? 11.5
          : isFrame
            ? Math.max(10, Math.round(11 * viewport.zoom))
            : Math.max(11, Math.round(14 * viewport.zoom));

        return (
          <div
            className="absolute z-30"
            style={{ left, top, width }}
          >
            <input
              autoFocus
              value={editingText}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setEditingText(e.target.value)}
              onBlur={commitInlineEdit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitInlineEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingId(null);
                }
              }}
              style={{
                fontSize: `${fontSize}px`,
                color: isArrow ? undefined : editPal.text,
              }}
              className={`w-full outline-none ${
                isArrow
                  ? "rounded-md border border-[#D94E28]/60 bg-card/95 px-2 py-0.5 text-center font-mono font-medium text-foreground shadow-sm"
                  : isFrame
                    ? "rounded bg-card/90 px-1.5 py-0.5 font-mono font-semibold uppercase tracking-[0.08em] ring-1 ring-[#D94E28]/50"
                    : `${labelFontClass} rounded-md bg-transparent px-1 py-0.5 text-center font-semibold tracking-[-0.01em] caret-[#D94E28] ring-1 ring-[#D94E28]/35`
              }`}
            />
          </div>
        );
      })()}
    </div>
  );
}
