"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Database,
  Diamond,
  Download,
  Frame,
  Hand,
  Maximize2,
  Minus,
  Moon,
  MousePointer2,
  Pencil,
  PenTool,
  Plus,
  Radio,
  Redo2,
  RotateCcw,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DiagramPatternHint,
  parsePromptToElements,
} from "@/lib/jev/diagram-parser";
import { computeBounds, makeSeed, uid } from "@/lib/jev/geometry";
import {
  detectCreationIntent,
  detectMoveIntent,
} from "@/lib/jev/intent-engine";
import {
  generateCandidatePool,
  serializeCanvasStateForJev,
} from "@/lib/jev/prediction-engine";
import { createStarterElements } from "@/lib/jev/templates";
import {
  BoardTheme,
  ElementBox,
  JevElement,
  JevTelemetry,
  PeerCursor,
  Point,
  PredictedAction,
  RenderStyle,
  SpatialIntent,
  ToolType,
  Viewport,
} from "@/lib/jev/types";
import { JevP2PCollab } from "@/lib/jev/webrtc-collab";
import { JevCanvas } from "./JevCanvas";
import { PredictionHud } from "./PredictionHud";
import { SelectionInspector } from "./SelectionInspector";
import { ShareP2PDialog } from "./ShareP2PDialog";
import { ThoughtBar } from "./ThoughtBar";

const TOOLS: Array<{
  id: ToolType;
  label: string;
  key: string;
  icon: React.ReactNode;
}> = [
  { id: "select", label: "Select", key: "V", icon: <MousePointer2 className="h-4 w-4" /> },
  { id: "hand", label: "Pan Canvas", key: "H", icon: <Hand className="h-4 w-4" /> },
  { id: "node", label: "Box", key: "R", icon: <Square className="h-4 w-4" /> },
  { id: "diamond", label: "Decision", key: "D", icon: <Diamond className="h-4 w-4" /> },
  { id: "database", label: "Database", key: "O", icon: <Database className="h-4 w-4" /> },
  { id: "ellipse", label: "Actor", key: "C", icon: <Circle className="h-4 w-4" /> },
  { id: "arrow", label: "Smart Arrow", key: "A", icon: <ArrowUpRight className="h-4 w-4" /> },
  { id: "frame", label: "Zone Frame", key: "F", icon: <Frame className="h-4 w-4" /> },
  { id: "freedraw", label: "Ink Pen", key: "P", icon: <Pencil className="h-4 w-4" /> },
  { id: "text", label: "Text Note", key: "T", icon: <Type className="h-4 w-4" /> },
];

const PEER_NAMES = ["Maya", "Soren", "Nadia", "Kavi", "Elena", "Theo"];

function getOrCreateRoomId(): string {
  if (typeof window === "undefined") return "jev-studio";
  const params = new URLSearchParams(window.location.search);
  const existing = params.get("room");
  if (existing && /^[a-zA-Z0-9_-]{3,40}$/.test(existing)) {
    return existing;
  }
  const fresh = `jev-${Math.random().toString(36).slice(2, 6)}`;
  const url = new URL(window.location.href);
  url.searchParams.set("room", fresh);
  window.history.replaceState({}, "", url.toString());
  return fresh;
}

export function JevWorkspace() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const thoughtInputRef = useRef<HTMLInputElement | null>(null);
  const collabRef = useRef<JevP2PCollab | null>(null);
  const lastCursorSentRef = useRef<number>(0);

  const [roomId, setRoomId] = useState("jev-studio");
  const [boardTitle, setBoardTitle] = useState("System Sketch");
  const [elements, setElements] = useState<JevElement[]>(() =>
    createStarterElements()
  );
  const [undoStack, setUndoStack] = useState<JevElement[][]>([]);
  const [redoStack, setRedoStack] = useState<JevElement[][]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasInteracting, setCanvasInteracting] = useState(false);
  const [tool, setTool] = useState<ToolType>("select");
  const [theme, setTheme] = useState<BoardTheme>("vellum");
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("sketch");
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 40, zoom: 1 });

  const [thoughtPrompt, setThoughtPrompt] = useState("");
  const [intent, setIntent] = useState<SpatialIntent | null>(null);
  const [predictions, setPredictions] = useState<PredictedAction[]>([]);
  const [activePredIdx, setActivePredIdx] = useState(0);
  const [telemetry, setTelemetry] = useState<JevTelemetry | null>(null);
  const decideAbortRef = useRef<AbortController | null>(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [remotePeers, setRemotePeers] = useState<PeerCursor[]>([]);
  const [demoPeerEnabled, setDemoPeerEnabled] = useState(false);
  const [demoPeer, setDemoPeer] = useState<PeerCursor | null>(null);
  const [collabStatus, setCollabStatus] = useState({
    webrtcPeers: 0,
    broadcastPeers: 0,
    signalingActive: false,
  });

  const elementsRef = useRef(elements);
  const boardTitleRef = useRef(boardTitle);
  useEffect(() => {
    elementsRef.current = elements;
  }, [elements]);
  useEffect(() => {
    boardTitleRef.current = boardTitle;
  }, [boardTitle]);

  // Sync dark mode class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "midnight");
  }, [theme]);

  // Fit diagram comfortably on mount + seed initial Tab+Enter predictions
  const fitToView = useCallback((targetEls?: JevElement[]) => {
    const list = targetEls ?? elementsRef.current;
    const bounds = computeBounds(list);
    if (!bounds || typeof window === "undefined") {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const padX = 140;
    const padTop = 130;
    const padBottom = 250;
    const availW = Math.max(300, vw - padX * 2);
    const availH = Math.max(240, vh - padTop - padBottom);
    const zoom = Math.min(
      1.15,
      Math.max(0.45, Math.min(availW / bounds.width, availH / bounds.height))
    );
    const x = Math.round(
      (vw - bounds.width * zoom) / 2 - bounds.x * zoom
    );
    const y = Math.round(
      padTop + (availH - bounds.height * zoom) / 2 - bounds.y * zoom
    );
    setViewport({ x, y, zoom });
  }, []);

  const rankWithTypeSafeJev = useCallback(
    async (
      nextIntent: SpatialIntent,
      currentEls: JevElement[],
      pool: PredictedAction[]
    ) => {
      if (pool.length === 0) return;

      decideAbortRef.current?.abort();
      const controller = new AbortController();
      decideAbortRef.current = controller;

      setTelemetry((prev) => ({
        source: prev?.source ?? "local-fallback",
        model: prev?.model ?? "jev-latest",
        latencyMs: prev?.latencyMs ?? 0,
        evaluating: true,
      }));

      try {
        const res = await fetch("/api/jev/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: "rank_actions",
            stateSummary: serializeCanvasStateForJev(nextIntent, currentEls),
            candidates: pool.map((c) => ({
              id: c.id,
              title: c.title,
              subtitle: c.subtitle,
              category: c.category,
            })),
          }),
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = (await res.json()) as {
          source: "typesafe-jev" | "local-fallback";
          model: string;
          latencyMs: number;
          usage?: { input_tokens?: number };
          nextActionProbabilities?: Record<string, number>;
          intentChoice?: string | null;
          intentConfidence?: number | null;
          shouldConnectProb?: number | null;
        };
        if (controller.signal.aborted) return;

        const probs = data.nextActionProbabilities ?? {};
        const ranked = pool
          .map((action) => ({
            ...action,
            probability:
              typeof probs[action.id] === "number"
                ? probs[action.id]
                : action.probability,
          }))
          .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
          .slice(0, 3);

        setPredictions(ranked);
        setActivePredIdx(0);
        setTelemetry({
          source: data.source,
          model: data.model,
          latencyMs: data.latencyMs,
          inputTokens: data.usage?.input_tokens,
          intentChoice: data.intentChoice,
          intentConfidence: data.intentConfidence,
          shouldConnectProb: data.shouldConnectProb,
          evaluating: false,
        });
      } catch {
        setTelemetry((prev) => (prev ? { ...prev, evaluating: false } : null));
      }
    },
    []
  );

  // Initialize room, load saved state if present, and start WebRTC P2P session
  useEffect(() => {
    const rid = getOrCreateRoomId();
    const initTimer = window.setTimeout(() => {
      setRoomId(rid);
      let initialEls = elementsRef.current;
      let restored = false;
      try {
        const saved = window.localStorage.getItem(`jev_board_${rid}`);
        if (saved) {
          const parsed = JSON.parse(saved) as {
            elements: JevElement[];
            boardTitle?: string;
          };
          if (Array.isArray(parsed.elements) && parsed.elements.length > 0) {
            initialEls = parsed.elements;
            restored = true;
            setElements(parsed.elements);
            if (parsed.boardTitle) setBoardTitle(parsed.boardTitle);
          }
        }
      } catch {
        // ignore storage errors
      }
      fitToView(initialEls);
      const anchor =
        initialEls.find((e) => e.id === "starter_mesh") ??
        initialEls[initialEls.length - 1];
      if (anchor) {
        const initialIntent: SpatialIntent = {
          kind: "domain_continue",
          headline: restored
            ? "Restored your room — drag any node or press Tab + Enter"
            : "Drag any node to test spatial intent — or press Tab + Enter",
          detail: `Predicted 3 continuations from "${anchor.label}"`,
          subjectId: anchor.id,
          relatedIds: [],
          timestamp: Date.now(),
        };
        setIntent(initialIntent);
        const pool = generateCandidatePool(initialIntent, initialEls);
        setPredictions(pool.slice(0, 3));
        setActivePredIdx(0);
        void rankWithTypeSafeJev(initialIntent, initialEls, pool);
      }
    }, 0);

    // Start WebRTC + BroadcastChannel P2P session
    const myName =
      PEER_NAMES[Math.floor(Math.random() * PEER_NAMES.length)];
    const collab = new JevP2PCollab(rid, myName, {
      onPeersChange: (list) => setRemotePeers(list),
      onRemoteState: (remoteEls, remoteTitle) => {
        setElements(remoteEls);
        setBoardTitle(remoteTitle);
      },
      onGetLocalState: () => ({
        elements: elementsRef.current,
        boardTitle: boardTitleRef.current,
      }),
      onStatusChange: (status) => setCollabStatus(status),
    });
    collab.start();
    collabRef.current = collab;

    return () => {
      window.clearTimeout(initTimer);
      decideAbortRef.current?.abort();
      collab.destroy();
      collabRef.current = null;
    };
  }, [fitToView, rankWithTypeSafeJev]);

  // Persist to localStorage quietly
  useEffect(() => {
    if (!roomId) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          `jev_board_${roomId}`,
          JSON.stringify({ elements, boardTitle })
        );
      } catch {
        // ignore quota errors
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [elements, boardTitle, roomId]);

  // Optional Live Collaborator Demo Peer animation
  useEffect(() => {
    if (!demoPeerEnabled) return;
    let frame = 0;
    const interval = window.setInterval(() => {
      frame += 1;
      const t = frame * 0.09;
      const anchor = elementsRef.current[0];
      const cx = (anchor?.x ?? 320) + 210 + Math.cos(t) * 190;
      const cy = (anchor?.y ?? 240) + 40 + Math.sin(t * 1.4) * 95;
      setDemoPeer({
        peerId: "demo_peer_ada",
        name: "Ada (Demo)",
        color: "#0F766E",
        x: cx,
        y: cy,
        transport: "simulated",
        lastSeen: Date.now(),
        rttMs: 12,
      });
    }, 65);
    return () => window.clearInterval(interval);
  }, [demoPeerEnabled]);

  const allPeers = useMemo(
    () =>
      demoPeerEnabled && demoPeer ? [...remotePeers, demoPeer] : remotePeers,
    [remotePeers, demoPeer, demoPeerEnabled]
  );

  // Live instant preview while typing in the Jev Thought Bar
  const promptPreview = useMemo(() => {
    if (!thoughtPrompt.trim()) return { elements: [], summary: "" };
    return parsePromptToElements(thoughtPrompt, elements);
  }, [thoughtPrompt, elements]);

  const updateElements = useCallback(
    (
      updater: (prev: JevElement[]) => JevElement[],
      opts?: { recordUndo?: boolean; broadcast?: boolean }
    ) => {
      const recordUndo = opts?.recordUndo ?? true;
      const shouldBroadcast = opts?.broadcast ?? true;

      setElements((prev) => {
        if (recordUndo) {
          setUndoStack((u) => [...u.slice(-39), prev]);
          setRedoStack([]);
        }
        const next = updater(prev);
        if (shouldBroadcast) {
          collabRef.current?.broadcastState(next, boardTitleRef.current);
        }
        return next;
      });
    },
    []
  );

  const refreshPredictions = useCallback(
    (nextIntent: SpatialIntent, currentEls: JevElement[]) => {
      setIntent(nextIntent);
      const pool = generateCandidatePool(nextIntent, currentEls);
      setPredictions(pool.slice(0, 3));
      setActivePredIdx(0);
      void rankWithTypeSafeJev(nextIntent, currentEls, pool);
    },
    [rankWithTypeSafeJev]
  );

  const handleElementMoved = useCallback(
    (moved: JevElement, dragStart: ElementBox) => {
      const latest = elementsRef.current.map((e) =>
        e.id === moved.id ? moved : e
      );
      const detected = detectMoveIntent(moved, dragStart, latest);
      refreshPredictions(detected, latest);
    },
    [refreshPredictions]
  );

  const handleElementCreated = useCallback(
    (created: JevElement) => {
      const latest = elementsRef.current.some((e) => e.id === created.id)
        ? elementsRef.current
        : [...elementsRef.current, created];
      const detected = detectCreationIntent(created, latest, false);
      refreshPredictions(detected, latest);
    },
    [refreshPredictions]
  );

  const handleElementLabelEdited = useCallback(
    (edited: JevElement) => {
      const latest = elementsRef.current.map((e) =>
        e.id === edited.id ? edited : e
      );
      const detected = detectCreationIntent(edited, latest, false);
      refreshPredictions(detected, latest);
    },
    [refreshPredictions]
  );

  const applyPrediction = useCallback(
    (idx: number) => {
      const pred = predictions[idx];
      if (!pred) return;

      const removeSet = new Set(pred.removeIds ?? []);
      const patchMap = new Map(
        (pred.patchElements ?? []).map((p) => [p.id, p])
      );

      let nextElsSnapshot: JevElement[] = [];
      updateElements((prev) => {
        const updated = prev
          .filter((el) => !removeSet.has(el.id))
          .map((el) => {
            const p = patchMap.get(el.id);
            if (!p) return el;
            return {
              ...el,
              ...p,
              updatedAt: Date.now(),
            };
          });

        const framesToAdd = pred.addElements.filter((e) => e.kind === "frame");
        const othersToAdd = pred.addElements.filter((e) => e.kind !== "frame");
        nextElsSnapshot = [...framesToAdd, ...updated, ...othersToAdd];
        return nextElsSnapshot;
      });

      const nextFocus = pred.focusId
        ? nextElsSnapshot.find((e) => e.id === pred.focusId)
        : undefined;
      if (nextFocus) {
        setSelectedId(nextFocus.id);
        const chainedIntent: SpatialIntent = {
          kind:
            nextFocus.kind === "diamond" ? "decision_branch" : "domain_continue",
          headline: `Applied "${pred.title}"`,
          detail: "Tab + Enter again to keep building at speed",
          subjectId: nextFocus.id,
          relatedIds: [],
          timestamp: Date.now(),
        };
        refreshPredictions(chainedIntent, nextElsSnapshot);
      } else {
        setPredictions([]);
      }
    },
    [predictions, updateElements, refreshPredictions]
  );

  const handleSubmitThought = useCallback(
    async (prompt: string) => {
      let patternHint: DiagramPatternHint | null = null;
      const hasExplicitArrows = /(->|=>|→|<->|↔)/.test(prompt);

      if (!hasExplicitArrows) {
        try {
          const res = await fetch("/api/jev/decide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "classify_prompt", prompt }),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              source: "typesafe-jev" | "local-fallback";
              model: string;
              latencyMs: number;
              pattern?: DiagramPatternHint | null;
            };
            if (data.source === "typesafe-jev" && data.pattern) {
              patternHint = data.pattern;
              setTelemetry({
                source: data.source,
                model: data.model,
                latencyMs: data.latencyMs,
                evaluating: false,
              });
            }
          }
        } catch {
          // fall back to instant local parser
        }
      }

      const parsed = parsePromptToElements(
        prompt,
        elementsRef.current,
        undefined,
        patternHint
      );
      if (parsed.elements.length === 0) return;

      let combined: JevElement[] = [];
      updateElements((prev) => {
        const framesToAdd = parsed.elements.filter((e) => e.kind === "frame");
        const rest = parsed.elements.filter((e) => e.kind !== "frame");
        combined = [...framesToAdd, ...prev, ...rest];
        return combined;
      });

      setThoughtPrompt("");
      thoughtInputRef.current?.blur();

      const focusEl = parsed.focusId
        ? combined.find((e) => e.id === parsed.focusId)
        : combined[combined.length - 1];
      if (focusEl) {
        setSelectedId(focusEl.id);
        const detected = detectCreationIntent(focusEl, combined, true);
        refreshPredictions(detected, combined);
      }
      fitToView(combined);
    },
    [updateElements, refreshPredictions, fitToView]
  );

  const handleUndo = useCallback(() => {
    setUndoStack((u) => {
      if (u.length === 0) return u;
      const previous = u[u.length - 1];
      setRedoStack((r) => [...r.slice(-39), elementsRef.current]);
      setElements(previous);
      collabRef.current?.broadcastState(previous, boardTitleRef.current);
      return u.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const next = r[r.length - 1];
      setUndoStack((u) => [...u.slice(-39), elementsRef.current]);
      setElements(next);
      collabRef.current?.broadcastState(next, boardTitleRef.current);
      return r.slice(0, -1);
    });
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      updateElements((prev) =>
        prev.filter((e) => e.id !== id && e.fromId !== id && e.toId !== id)
      );
      if (selectedId === id) setSelectedId(null);
      setPredictions([]);
    },
    [selectedId, updateElements]
  );

  const handleDuplicate = useCallback(
    (id: string) => {
      const src = elementsRef.current.find((e) => e.id === id);
      if (!src) return;
      const cloneId = uid("el");
      const clone: JevElement = {
        ...src,
        id: cloneId,
        x: src.x + 42,
        y: src.y + 42,
        seed: makeSeed(cloneId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updateElements((prev) => [...prev, clone]);
      setSelectedId(cloneId);
      handleElementCreated(clone);
    },
    [updateElements, handleElementCreated]
  );

  const handlePatchElement = useCallback(
    (id: string, patch: Partial<JevElement>) => {
      updateElements((prev) =>
        prev.map((el) =>
          el.id === id ? { ...el, ...patch, updatedAt: Date.now() } : el
        )
      );
    },
    [updateElements]
  );

  // Global keyboard shortcuts (Tab + Enter predictions, /, tools, Undo/Redo)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (inInput) return;

      // "/" focuses the Thought Bar
      if (e.key === "/") {
        e.preventDefault();
        thoughtInputRef.current?.focus();
        return;
      }

      // Tab cycles through the 3 predictions
      if (e.key === "Tab" && predictions.length > 0) {
        e.preventDefault();
        setActivePredIdx((idx) =>
          e.shiftKey
            ? (idx - 1 + predictions.length) % predictions.length
            : (idx + 1) % predictions.length
        );
        return;
      }

      // Enter materializes the active ghost prediction!
      if (e.key === "Enter" && predictions.length > 0) {
        e.preventDefault();
        applyPrediction(activePredIdx);
        return;
      }

      // 1 / 2 / 3 quick select prediction
      if (
        (e.key === "1" || e.key === "2" || e.key === "3") &&
        predictions.length > 0 &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        const idx = Number(e.key) - 1;
        if (idx < predictions.length) {
          e.preventDefault();
          if (activePredIdx === idx) {
            applyPrediction(idx);
          } else {
            setActivePredIdx(idx);
          }
          return;
        }
      }

      if (e.key === "Escape") {
        if (predictions.length > 0) {
          setPredictions([]);
          setIntent(null);
        } else {
          setSelectedId(null);
          setTool("select");
        }
        return;
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Duplicate
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedId) {
        e.preventDefault();
        handleDuplicate(selectedId);
        return;
      }

      // Delete
      if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        handleDelete(selectedId);
        return;
      }

      // Single-letter tool shortcuts
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const match = TOOLS.find(
          (t) => t.key.toLowerCase() === e.key.toLowerCase()
        );
        if (match) {
          setTool(match.id);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    predictions,
    activePredIdx,
    applyPrediction,
    selectedId,
    handleUndo,
    handleRedo,
    handleDuplicate,
    handleDelete,
  ]);

  const handleCursorMove = useCallback(
    (worldPt: Point) => {
      const now = performance.now();
      if (now - lastCursorSentRef.current < 45) return;
      lastCursorSentRef.current = now;
      collabRef.current?.broadcastCursor(worldPt.x, worldPt.y, selectedId);
    },
    [selectedId]
  );

  // Export board to crisp SVG
  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("width", "100%");
    bgRect.setAttribute("height", "100%");
    bgRect.setAttribute("fill", theme === "midnight" ? "#11151D" : "#F7F4ED");
    clone.insertBefore(bgRect, clone.firstChild);

    const serialized = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${boardTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "jev-board"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetToStarter = () => {
    const fresh = createStarterElements();
    updateElements(() => fresh);
    setSelectedId("starter_mesh");
    fitToView(fresh);
    const anchor = fresh.find((e) => e.id === "starter_mesh");
    if (anchor) {
      refreshPredictions(detectCreationIntent(anchor, fresh, false), fresh);
    }
  };

  const clearBoard = () => {
    updateElements(() => []);
    setSelectedId(null);
    setPredictions([]);
    setIntent(null);
  };

  const selectedElement = useMemo(
    () => elements.find((e) => e.id === selectedId) ?? null,
    [elements, selectedId]
  );

  const activePrediction = predictions[activePredIdx] ?? null;

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* FULL-BLEED INFINITE CANVAS */}
      <JevCanvas
        svgRef={svgRef}
        elements={elements}
        selectedId={selectedId}
        tool={tool}
        theme={theme}
        renderStyle={renderStyle}
        viewport={viewport}
        activePrediction={activePrediction}
        promptPreviewElements={promptPreview.elements}
        peers={allPeers}
        onViewportChange={setViewport}
        onSelect={setSelectedId}
        onToolChange={setTool}
        onElementsChange={updateElements}
        onElementMoved={handleElementMoved}
        onElementCreated={handleElementCreated}
        onElementLabelEdited={handleElementLabelEdited}
        onCursorMove={handleCursorMove}
        onInteractingChange={setCanvasInteracting}
      />

      {/* TOP FLOATING STUDIO BAR */}
      <header className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3 sm:p-4">
        {/* Left: Jev Wordmark & Board Menu */}
        <div className="jev-glass pointer-events-auto flex items-center gap-2 rounded-2xl px-3 py-1.5 shadow-sm">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-xl pr-1.5 text-left outline-none transition-opacity hover:opacity-80">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-[#D94E28] text-white shadow-xs">
                <PenTool className="h-3.5 w-3.5" />
              </span>
              <span className="font-editorial text-[21px] font-semibold leading-none tracking-[-0.02em] text-foreground">
                Jev
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 rounded-xl">
              <DropdownMenuItem onClick={exportSvg} className="gap-2 text-xs">
                <Download className="h-3.5 w-3.5" />
                Export Diagram (.svg)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => fitToView()}
                className="gap-2 text-xs"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Zoom to Fit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={resetToStarter}
                className="gap-2 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Load Starter Canvas
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={clearBoard}
                className="gap-2 text-xs text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Blank Sheet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="h-4 w-px bg-border" />

          <input
            value={boardTitle}
            onChange={(e) => {
              setBoardTitle(e.target.value);
              collabRef.current?.broadcastState(elements, e.target.value);
            }}
            aria-label="Board title"
            className="hidden w-32 bg-transparent text-xs font-semibold text-foreground/90 outline-none focus:text-foreground sm:block"
          />

          <div className="hidden items-center gap-0.5 border-l border-border pl-1.5 lg:flex">
            <button
              type="button"
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              title="Undo (⌘Z)"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-35"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              title="Redo (⌘⇧Z)"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-35"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Center: Tactile Drafting Tool Dock */}
        <nav
          aria-label="Drawing tools"
          className="jev-glass pointer-events-auto flex max-w-[calc(100vw-210px)] items-center gap-0.5 overflow-x-auto rounded-2xl p-1 shadow-sm"
        >
          {TOOLS.map((t) => {
            const active = tool === t.id;
            return (
              <Tooltip key={t.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setTool(t.id)}
                      className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all ${
                        active
                          ? "bg-[#1C2028] text-[#F8F6F1] shadow-xs dark:bg-[#F1EDE4] dark:text-[#11151D]"
                          : "text-foreground/75 hover:bg-secondary hover:text-foreground"
                      }`}
                    />
                  }
                >
                  {t.icon}
                  <span className="pointer-events-none absolute bottom-0.5 right-1 font-mono text-[8px] opacity-55">
                    {t.key}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t.label} <span className="ml-1 font-mono opacity-70">{t.key}</span>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* Right: Render Style, Motion Trails, Theme & WebRTC P2P */}
        <div className="jev-glass pointer-events-auto flex items-center gap-1 rounded-2xl p-1.5 shadow-sm">
          {/* Sketch vs Clean drafting style */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() =>
                    setRenderStyle((s) => (s === "sketch" ? "clean" : "sketch"))
                  }
                  className="hidden items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-secondary sm:inline-flex"
                />
              }
            >
              <Sparkles className="h-3.5 w-3.5 text-[#D94E28]" />
              {renderStyle === "sketch" ? "Sketch" : "Clean"}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Toggle hand-drawn RoughJS ink vs crisp vector lines
            </TooltipContent>
          </Tooltip>

          {/* Studio Vellum vs Midnight Blueprint */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() =>
                    setTheme((t) => (t === "vellum" ? "midnight" : "vellum"))
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-xl text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground"
                />
              }
            >
              {theme === "vellum" ? (
                <Moon className="h-3.5 w-3.5" />
              ) : (
                <Sun className="h-3.5 w-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Switch to {theme === "vellum" ? "Midnight Blueprint" : "Studio Vellum"}
            </TooltipContent>
          </Tooltip>

          {/* Live WebRTC P2P Button */}
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#0F766E] px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[#0D655E]"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-200" />
            </span>
            <Radio className="hidden h-3.5 w-3.5 sm:block" />
            <span>
              {allPeers.length > 0 ? `P2P · ${allPeers.length + 1}` : "Share P2P"}
            </span>
          </button>
        </div>
      </header>

      {/* SPATIALLY ANCHORED CONTEXTUAL EDITOR (zoom & collision aware) */}
      <SelectionInspector
        element={selectedElement}
        allElements={elements}
        ghostElements={
          promptPreview.elements.length > 0
            ? promptPreview.elements
            : activePrediction?.addElements ?? []
        }
        viewport={viewport}
        theme={theme}
        hasPredictionHud={!thoughtPrompt.trim() && (Boolean(intent) || predictions.length > 0)}
        hiddenWhileInteracting={canvasInteracting}
        onPatch={handlePatchElement}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onClose={() => setSelectedId(null)}
      />

      {/* BOTTOM FLOATING INTELLIGENCE DOCK: 3-Option Tab+Enter HUD + Thought Bar */}
      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-20 flex flex-col items-center gap-2.5 sm:bottom-4">
        {!thoughtPrompt.trim() && (
          <PredictionHud
            intent={intent}
            predictions={predictions}
            activeIndex={activePredIdx}
            telemetry={telemetry}
            onHoverIndex={setActivePredIdx}
            onApply={applyPrediction}
            onDismiss={() => {
              setPredictions([]);
              setIntent(null);
            }}
          />
        )}

        <ThoughtBar
          inputRef={thoughtInputRef}
          value={thoughtPrompt}
          previewCount={promptPreview.elements.length}
          onChange={setThoughtPrompt}
          onSubmit={handleSubmitThought}
          onClear={() => setThoughtPrompt("")}
        />
      </div>

      {/* BOTTOM-RIGHT ZOOM & FIT PILL */}
      <div className="jev-glass fixed bottom-4 right-4 z-20 hidden items-center gap-1 rounded-xl p-1 shadow-sm lg:flex">
        <button
          type="button"
          onClick={() =>
            setViewport((v) => ({ ...v, zoom: Math.max(0.3, v.zoom * 0.88) }))
          }
          aria-label="Zoom out"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => fitToView()}
          title="Fit diagram to viewport"
          className="min-w-[48px] rounded-lg px-1.5 py-1 font-mono text-[11px] font-medium text-foreground/85 transition-colors hover:bg-secondary"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() =>
            setViewport((v) => ({ ...v, zoom: Math.min(2.5, v.zoom * 1.14) }))
          }
          aria-label="Zoom in"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* PEER-TO-PEER WEBRTC COLLABORATION MODAL */}
      <ShareP2PDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        roomId={roomId}
        peers={allPeers}
        webrtcPeers={collabStatus.webrtcPeers}
        broadcastPeers={collabStatus.broadcastPeers}
        demoPeerEnabled={demoPeerEnabled}
        onToggleDemoPeer={setDemoPeerEnabled}
        onCreateManualOffer={async () => {
          if (!collabRef.current) throw new Error("Session not ready");
          return collabRef.current.createManualOfferCode();
        }}
        onAcceptManualOffer={async (code) => {
          if (!collabRef.current) throw new Error("Session not ready");
          return collabRef.current.acceptManualOfferAndCreateAnswer(code);
        }}
        onCompleteManualAnswer={async (code) => {
          if (!collabRef.current) throw new Error("Session not ready");
          await collabRef.current.completeManualAnswer(code);
        }}
      />
    </div>
  );
}
