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
import { computeBounds, makeSeed, Rect, uid } from "@/lib/jev/geometry";
import {
  detectCreationIntent,
  detectMoveIntent,
} from "@/lib/jev/intent-engine";
import {
  buildPlacementPlan,
  createAutoConnectArrow,
  extractFlowLabels,
  LastPromptFlow,
  PlacementSlotId,
  positionElementsAtTopLeft,
} from "@/lib/jev/placement-engine";
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
import { PlacementBadgeInfo, ThoughtBar } from "./ThoughtBar";

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

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [canvasInteracting, setCanvasInteracting] = useState(false);
  const [tool, setTool] = useState<ToolType>("select");
  const [theme, setTheme] = useState<BoardTheme>("vellum");
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("sketch");
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 40, zoom: 1 });
  const [screenSize, setScreenSize] = useState({ width: 1280, height: 800 });

  useEffect(() => {
    const sync = () =>
      setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // Exact world-space viewport rect & visual center of the user's zoomed view
  const viewportWorld = useMemo<Rect>(() => {
    const safeTop = 76;
    const safeBottom = 175;
    const visibleH = Math.max(220, screenSize.height - safeTop - safeBottom);
    return {
      x: -viewport.x / viewport.zoom,
      y: (safeTop - viewport.y) / viewport.zoom,
      width: screenSize.width / viewport.zoom,
      height: visibleH / viewport.zoom,
    };
  }, [screenSize.width, screenSize.height, viewport.x, viewport.y, viewport.zoom]);

  const viewportCenterWorld = useMemo<Point>(() => {
    return {
      x: Math.round(viewportWorld.x + viewportWorld.width / 2),
      y: Math.round(viewportWorld.y + viewportWorld.height / 2),
    };
  }, [viewportWorld]);

  const [thoughtPrompt, setThoughtPrompt] = useState("");
  const [lastPromptFlow, setLastPromptFlow] = useState<LastPromptFlow | null>(null);
  const lastPromptFlowRef = useRef<LastPromptFlow | null>(null);
  const [livePlacementDecision, setLivePlacementDecision] = useState<{
    prompt: string;
    slotId: PlacementSlotId;
    confidence?: number;
    connectTargetId?: string | null;
    connectConfidence?: number;
    fromJev: boolean;
    pattern?: DiagramPatternHint | null;
    evaluating: boolean;
  } | null>(null);
  const placeAbortRef = useRef<AbortController | null>(null);
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

  // Keep lastPromptFlowRef in sync for async Enter submissions
  useEffect(() => {
    lastPromptFlowRef.current = lastPromptFlow;
  }, [lastPromptFlow]);

  // 1) Parse the live Thought Bar prompt & compute deterministic collision-free placement candidates
  const livePromptBundle = useMemo(() => {
    const trimmed = thoughtPrompt.trim();
    if (!trimmed) return null;
    const patternHint =
      livePlacementDecision?.prompt === trimmed
        ? livePlacementDecision.pattern ?? null
        : null;
    const base = parsePromptToElements(
      trimmed,
      elements,
      viewportCenterWorld,
      patternHint
    );
    if (base.elements.length === 0) return null;

    const plan = buildPlacementPlan({
      prompt: trimmed,
      generatedElements: base.elements,
      existingElements: elements,
      viewportWorld,
      lastPromptFlow,
      selectedIds,
    });

    const preferredSlotId =
      livePlacementDecision?.prompt === trimmed
        ? livePlacementDecision.slotId
        : plan.defaultSlotId;

    const chosen =
      plan.candidates.find((c) => c.id === preferredSlotId) ??
      plan.candidates[0];

    const preferredConnectId =
      plan.isSingleComponent && plan.connectTargets.length > 0
        ? livePlacementDecision?.prompt === trimmed &&
          livePlacementDecision.connectTargetId !== undefined
          ? livePlacementDecision.connectTargetId
          : plan.defaultConnectTargetId
        : null;

    const chosenConnect =
      preferredConnectId && preferredConnectId !== "none"
        ? plan.connectTargets.find((c) => c.id === preferredConnectId) ?? null
        : null;

    let positioned = chosenConnect
      ? positionElementsAtTopLeft(base.elements, chosenConnect.topLeft)
      : chosen
        ? positionElementsAtTopLeft(base.elements, chosen.topLeft)
        : base.elements;

    if (chosenConnect && positioned.length === 1) {
      const ghostConnArrow = createAutoConnectArrow(
        chosenConnect.id,
        positioned[0].id,
        "ghost_autoconn"
      );
      positioned = [...positioned, ghostConnArrow];
    }

    const badge: PlacementBadgeInfo | null = chosenConnect
      ? {
          label: chosenConnect.label,
          confidence:
            livePlacementDecision?.prompt === trimmed &&
            typeof livePlacementDecision.connectConfidence === "number"
              ? livePlacementDecision.connectConfidence
              : chosenConnect.prior,
          fromJev:
            livePlacementDecision?.prompt === trimmed
              ? livePlacementDecision.fromJev
              : false,
          evaluating:
            livePlacementDecision?.prompt === trimmed
              ? livePlacementDecision.evaluating
              : false,
        }
      : chosen
        ? {
            label: chosen.label,
            confidence:
              livePlacementDecision?.prompt === trimmed
                ? livePlacementDecision.confidence
                : chosen.prior,
            fromJev:
              livePlacementDecision?.prompt === trimmed
                ? livePlacementDecision.fromJev
                : false,
            evaluating:
              livePlacementDecision?.prompt === trimmed
                ? livePlacementDecision.evaluating
                : false,
          }
        : null;

    return {
      trimmed,
      base,
      plan,
      chosen,
      chosenConnect,
      elements: positioned,
      summary: base.summary,
      badge,
    };
  }, [
    thoughtPrompt,
    elements,
    viewportCenterWorld,
    viewportWorld,
    lastPromptFlow,
    selectedIds,
    livePlacementDecision,
  ]);

  const promptPreview = useMemo(
    () =>
      livePromptBundle
        ? { elements: livePromptBundle.elements, summary: livePromptBundle.summary }
        : { elements: [], summary: "" },
    [livePromptBundle]
  );

  // 2) Debounced live Jev System One spatial placement evaluation while typing
  useEffect(() => {
    const trimmed = thoughtPrompt.trim();
    if (!trimmed || !livePromptBundle || livePromptBundle.plan.candidates.length === 0) {
      placeAbortRef.current?.abort();
      return;
    }

    const { plan } = livePromptBundle;
    const hasExplicitArrows = /(->|=>|→|<->|↔)/.test(trimmed);

    const timer = window.setTimeout(async () => {
      placeAbortRef.current?.abort();
      const controller = new AbortController();
      placeAbortRef.current = controller;

      setLivePlacementDecision((prev) => ({
        prompt: trimmed,
        slotId: prev?.prompt === trimmed ? prev.slotId : plan.defaultSlotId,
        confidence: prev?.prompt === trimmed ? prev.confidence : undefined,
        connectTargetId:
          prev?.prompt === trimmed
            ? prev.connectTargetId
            : plan.defaultConnectTargetId,
        connectConfidence:
          prev?.prompt === trimmed ? prev.connectConfidence : undefined,
        fromJev: prev?.prompt === trimmed ? prev.fromJev : false,
        pattern: prev?.prompt === trimmed ? prev.pattern : null,
        evaluating: true,
      }));

      try {
        const res = await fetch("/api/jev/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: "place_diagram",
            prompt: trimmed,
            stateSummary: plan.stateSummary,
            classifyPattern: !hasExplicitArrows && !plan.isSingleComponent,
            candidates: plan.candidates.map((c) => ({
              id: c.id,
              label: c.label,
              description: c.description,
              prior: c.prior,
            })),
            connectTargets: plan.connectTargets.map((ct) => ({
              id: ct.id,
              label: ct.label,
              description: ct.description,
              prior: ct.prior,
            })),
          }),
        });
        if (!res.ok || controller.signal.aborted) return;

        const data = (await res.json()) as {
          source: "typesafe-jev" | "local-fallback";
          model: string;
          latencyMs: number;
          chosenSlotId?: PlacementSlotId;
          slotConfidence?: number;
          connectTargetId?: string | null;
          connectConfidence?: number | null;
          pattern?: DiagramPatternHint | null;
        };
        if (controller.signal.aborted) return;

        const chosenSlotId =
          data.chosenSlotId &&
          plan.candidates.some((c) => c.id === data.chosenSlotId)
            ? data.chosenSlotId
            : plan.defaultSlotId;

        const resolvedConnectId =
          data.connectTargetId &&
          plan.connectTargets.some((ct) => ct.id === data.connectTargetId)
            ? data.connectTargetId
            : plan.defaultConnectTargetId;

        setLivePlacementDecision({
          prompt: trimmed,
          slotId: chosenSlotId,
          confidence: data.slotConfidence,
          connectTargetId: resolvedConnectId,
          connectConfidence:
            typeof data.connectConfidence === "number"
              ? data.connectConfidence
              : undefined,
          fromJev: data.source === "typesafe-jev",
          pattern: data.source === "typesafe-jev" ? data.pattern ?? null : null,
          evaluating: false,
        });

        setTelemetry({
          source: data.source,
          model: data.model,
          latencyMs: data.latencyMs,
          evaluating: false,
        });
      } catch {
        if (!controller.signal.aborted) {
          setLivePlacementDecision((prev) =>
            prev?.prompt === trimmed ? { ...prev, evaluating: false } : prev
          );
        }
      }
    }, 240);

    return () => {
      window.clearTimeout(timer);
    };
    // Intentionally trigger when the prompt text changes (or previous flow changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thoughtPrompt, lastPromptFlow]);

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
        setSelectedIds([nextFocus.id]);
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
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim();
      if (!prompt) return;

      const currentEls = elementsRef.current;
      const hasExplicitArrows = /(->|=>|→|<->|↔)/.test(prompt);

      // Build initial geometry + deterministic spatial placement candidates
      const initialParsed = parsePromptToElements(
        prompt,
        currentEls,
        viewportCenterWorld
      );
      if (initialParsed.elements.length === 0) return;

      const plan = buildPlacementPlan({
        prompt,
        generatedElements: initialParsed.elements,
        existingElements: currentEls,
        viewportWorld,
        lastPromptFlow: lastPromptFlowRef.current,
        selectedIds,
      });

      let chosenSlotId: PlacementSlotId = plan.defaultSlotId;
      let chosenConnectId: string | null = plan.defaultConnectTargetId;
      let patternHint: DiagramPatternHint | null = null;

      // Reuse already-resolved Jev placement for this exact prompt, or ask Jev now
      if (
        livePlacementDecision &&
        livePlacementDecision.prompt === prompt &&
        !livePlacementDecision.evaluating
      ) {
        if (plan.candidates.some((c) => c.id === livePlacementDecision.slotId)) {
          chosenSlotId = livePlacementDecision.slotId;
        }
        if (
          livePlacementDecision.connectTargetId &&
          plan.connectTargets.some(
            (ct) => ct.id === livePlacementDecision.connectTargetId
          )
        ) {
          chosenConnectId = livePlacementDecision.connectTargetId;
        }
        patternHint = livePlacementDecision.pattern ?? null;
      } else {
        try {
          const res = await fetch("/api/jev/decide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "place_diagram",
              prompt,
              stateSummary: plan.stateSummary,
              classifyPattern: !hasExplicitArrows && !plan.isSingleComponent,
              candidates: plan.candidates.map((c) => ({
                id: c.id,
                label: c.label,
                description: c.description,
                prior: c.prior,
              })),
              connectTargets: plan.connectTargets.map((ct) => ({
                id: ct.id,
                label: ct.label,
                description: ct.description,
                prior: ct.prior,
              })),
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              source: "typesafe-jev" | "local-fallback";
              model: string;
              latencyMs: number;
              chosenSlotId?: PlacementSlotId;
              connectTargetId?: string | null;
              pattern?: DiagramPatternHint | null;
            };
            if (
              data.chosenSlotId &&
              plan.candidates.some((c) => c.id === data.chosenSlotId)
            ) {
              chosenSlotId = data.chosenSlotId;
            }
            if (
              data.connectTargetId &&
              plan.connectTargets.some((ct) => ct.id === data.connectTargetId)
            ) {
              chosenConnectId = data.connectTargetId;
            }
            if (data.source === "typesafe-jev" && data.pattern) {
              patternHint = data.pattern;
            }
            setTelemetry({
              source: data.source,
              model: data.model,
              latencyMs: data.latencyMs,
              evaluating: false,
            });
          }
        } catch {
          // fall back seamlessly to deterministic placement plan
        }
      }

      const finalParsed = patternHint
        ? parsePromptToElements(
            prompt,
            currentEls,
            viewportCenterWorld,
            patternHint
          )
        : initialParsed;
      if (finalParsed.elements.length === 0) return;

      // Recompute exact top-left if pattern changed diagram dimensions
      const finalPlan = patternHint
        ? buildPlacementPlan({
            prompt,
            generatedElements: finalParsed.elements,
            existingElements: currentEls,
            viewportWorld,
            lastPromptFlow: lastPromptFlowRef.current,
            selectedIds,
          })
        : plan;

      const connectTarget =
        finalPlan.isSingleComponent &&
        chosenConnectId &&
        chosenConnectId !== "none"
          ? finalPlan.connectTargets.find((ct) => ct.id === chosenConnectId) ??
            null
          : null;

      const slot =
        finalPlan.candidates.find((c) => c.id === chosenSlotId) ??
        finalPlan.candidates[0];

      let positioned = connectTarget
        ? positionElementsAtTopLeft(finalParsed.elements, connectTarget.topLeft)
        : slot
          ? positionElementsAtTopLeft(finalParsed.elements, slot.topLeft)
          : finalParsed.elements;

      let connectedNodeId: string | null = null;
      if (connectTarget && positioned.length === 1) {
        connectedNodeId = positioned[0].id;
        const autoArrow = createAutoConnectArrow(
          connectTarget.id,
          connectedNodeId
        );
        positioned = [...positioned, autoArrow];
      }

      let combined: JevElement[] = [];
      updateElements((prev) => {
        const framesToAdd = positioned.filter((e) => e.kind === "frame");
        const rest = positioned.filter((e) => e.kind !== "frame");
        combined = [...framesToAdd, ...prev, ...rest];
        return combined;
      });

      // Track the active flow row (if chained via auto-connect onto the previous flow,
      // expand the flow record so a subsequent multi-node prompt stacks cleanly beneath it)
      const prevFlow = lastPromptFlowRef.current;
      const chainedOntoPrev =
        Boolean(connectTarget) &&
        Boolean(prevFlow) &&
        prevFlow!.elementIds.includes(connectTarget!.id);

      const flowElementIds = chainedOntoPrev
        ? [...prevFlow!.elementIds, ...positioned.map((e) => e.id)]
        : positioned.map((e) => e.id);
      const flowEls = combined.filter((e) => flowElementIds.includes(e.id));
      const placedBounds = computeBounds(positioned);
      const flowBounds = computeBounds(flowEls) ?? placedBounds;

      if (flowBounds) {
        const flowRecord: LastPromptFlow = {
          bounds: flowBounds,
          labels: extractFlowLabels(flowEls),
          prompt: chainedOntoPrev ? `${prevFlow!.prompt} -> ${prompt}` : prompt,
          elementIds: flowElementIds,
        };
        lastPromptFlowRef.current = flowRecord;
        setLastPromptFlow(flowRecord);
      }

      if (placedBounds) {
        // Preserve exact zoom! Only nudge pan gently if new node(s) crossed outside the visible safe viewport
        const pad = 28 / viewport.zoom;
        let panWorldDx = 0;
        let panWorldDy = 0;
        if (placedBounds.y + placedBounds.height > viewportWorld.y + viewportWorld.height - pad) {
          panWorldDy =
            viewportWorld.y +
            viewportWorld.height -
            pad -
            (placedBounds.y + placedBounds.height);
        } else if (placedBounds.y < viewportWorld.y + pad) {
          panWorldDy = viewportWorld.y + pad - placedBounds.y;
        }
        if (placedBounds.x + placedBounds.width > viewportWorld.x + viewportWorld.width - pad) {
          panWorldDx =
            viewportWorld.x +
            viewportWorld.width -
            pad -
            (placedBounds.x + placedBounds.width);
        } else if (placedBounds.x < viewportWorld.x + pad) {
          panWorldDx = viewportWorld.x + pad - placedBounds.x;
        }

        if (Math.abs(panWorldDx) > 4 || Math.abs(panWorldDy) > 4) {
          setViewport((v) => ({
            ...v,
            x: Math.round(v.x + panWorldDx * v.zoom),
            y: Math.round(v.y + panWorldDy * v.zoom),
          }));
        }
      }

      setThoughtPrompt("");
      setLivePlacementDecision(null);
      thoughtInputRef.current?.blur();

      const focusEl = connectedNodeId
        ? combined.find((e) => e.id === connectedNodeId)
        : finalParsed.focusId
          ? combined.find((e) => e.id === finalParsed.focusId)
          : combined[combined.length - 1];
      if (focusEl) {
        setSelectedIds([focusEl.id]);
        const detected = detectCreationIntent(focusEl, combined, true);
        refreshPredictions(detected, combined);
      }
    },
    [
      updateElements,
      refreshPredictions,
      viewportCenterWorld,
      viewportWorld,
      viewport.zoom,
      selectedIds,
      livePlacementDecision,
    ]
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

  const handleDeleteIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const delSet = new Set(ids);
      updateElements((prev) =>
        prev.filter(
          (e) =>
            !delSet.has(e.id) &&
            (!e.fromId || !delSet.has(e.fromId)) &&
            (!e.toId || !delSet.has(e.toId))
        )
      );
      setSelectedIds((curr) => curr.filter((id) => !delSet.has(id)));
      setPredictions([]);
    },
    [updateElements]
  );

  const handleDuplicateIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const srcSet = new Set(ids);
      const sources = elementsRef.current.filter((e) => srcSet.has(e.id));
      if (sources.length === 0) return;
      const now = Date.now();
      const clones: JevElement[] = sources.map((src) => {
        const cloneId = uid(src.kind === "frame" ? "frm" : "el");
        return {
          ...src,
          id: cloneId,
          x: src.x + 42,
          y: src.y + 42,
          seed: makeSeed(cloneId),
          createdAt: now,
          updatedAt: now,
        };
      });
      updateElements((prev) => [...prev, ...clones]);
      setSelectedIds(clones.map((c) => c.id));
      if (clones.length === 1) {
        handleElementCreated(clones[0]);
      }
    },
    [updateElements, handleElementCreated]
  );

  const handleWrapSelectionInFrame = useCallback(() => {
    const selectedSet = new Set(selectedIds);
    const chosen = elementsRef.current.filter((e) => selectedSet.has(e.id));
    const bounds = computeBounds(chosen);
    if (!bounds) return;
    const id = uid("frm");
    const now = Date.now();
    const frame: JevElement = {
      id,
      kind: "frame",
      x: Math.round(bounds.x - 32),
      y: Math.round(bounds.y - 44),
      width: Math.round(bounds.width + 64),
      height: Math.round(bounds.height + 72),
      label: "Group Zone",
      tone: "slate",
      seed: makeSeed(id),
      createdAt: now,
      updatedAt: now,
    };
    updateElements((prev) => [frame, ...prev]);
    setSelectedIds([id]);
  }, [selectedIds, updateElements]);

  const spawnShapeAtCenter = useCallback(
    (kind: ToolType) => {
      if (
        kind !== "node" &&
        kind !== "diamond" &&
        kind !== "database" &&
        kind !== "ellipse" &&
        kind !== "frame" &&
        kind !== "text"
      ) {
        return;
      }
      const defaults: Record<string, { w: number; h: number; label: string }> = {
        node: { w: 172, h: 72, label: "Service" },
        diamond: { w: 148, h: 96, label: "Condition?" },
        database: { w: 156, h: 86, label: "Database" },
        ellipse: { w: 152, h: 74, label: "User" },
        frame: { w: 340, h: 220, label: "System Zone" },
        text: { w: 180, h: 42, label: "Note" },
      };
      const def = defaults[kind];
      const id = uid(kind === "frame" ? "frm" : "el");
      const now = Date.now();
      const created: JevElement = {
        id,
        kind,
        x: Math.round(viewportCenterWorld.x - def.w / 2),
        y: Math.round(viewportCenterWorld.y - def.h / 2),
        width: def.w,
        height: def.h,
        label: def.label,
        tone: kind === "frame" ? "slate" : "cobalt",
        seed: makeSeed(id),
        createdAt: now,
        updatedAt: now,
      };
      updateElements((prev) =>
        kind === "frame" ? [created, ...prev] : [...prev, created]
      );
      setSelectedIds([id]);
      handleElementCreated(created);
      setTool("select");
    },
    [viewportCenterWorld, updateElements, handleElementCreated]
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
          setSelectedIds([]);
          setTool("select");
        }
        return;
      }

      // Select all (⌘A)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedIds(elementsRef.current.map((el) => el.id));
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
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "d" &&
        selectedIds.length > 0
      ) {
        e.preventDefault();
        handleDuplicateIds(selectedIds);
        return;
      }

      // Delete
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        selectedIds.length > 0
      ) {
        e.preventDefault();
        handleDeleteIds(selectedIds);
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
    selectedIds,
    handleUndo,
    handleRedo,
    handleDuplicateIds,
    handleDeleteIds,
  ]);

  const handleCursorMove = useCallback(
    (worldPt: Point) => {
      const now = performance.now();
      if (now - lastCursorSentRef.current < 45) return;
      lastCursorSentRef.current = now;
      collabRef.current?.broadcastCursor(
        worldPt.x,
        worldPt.y,
        selectedIds[0] ?? null
      );
    },
    [selectedIds]
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
    setSelectedIds([]);
    setLastPromptFlow(null);
    lastPromptFlowRef.current = null;
    fitToView(fresh);
    const anchor = fresh.find((e) => e.id === "starter_mesh");
    if (anchor) {
      refreshPredictions(detectCreationIntent(anchor, fresh, false), fresh);
    }
  };

  const clearBoard = () => {
    updateElements(() => []);
    setSelectedIds([]);
    setLastPromptFlow(null);
    lastPromptFlowRef.current = null;
    setPredictions([]);
    setIntent(null);
  };

  const selectedElement = useMemo(
    () =>
      selectedIds.length === 1
        ? elements.find((e) => e.id === selectedIds[0]) ?? null
        : null,
    [elements, selectedIds]
  );

  const multiSelectBarPos = useMemo(() => {
    if (selectedIds.length < 2) return null;
    const set = new Set(selectedIds);
    const groupBounds = computeBounds(elements.filter((e) => set.has(e.id)));
    if (!groupBounds) return null;
    const centerScreenX =
      viewport.x + (groupBounds.x + groupBounds.width / 2) * viewport.zoom;
    const topScreenY = viewport.y + groupBounds.y * viewport.zoom - 56;
    const barW = 246;
    const x = Math.max(
      14,
      Math.min(screenSize.width - 14 - barW, Math.round(centerScreenX - barW / 2))
    );
    const y = Math.max(
      76,
      Math.min(screenSize.height - 230, Math.round(topScreenY))
    );
    return { x, y };
  }, [selectedIds, elements, viewport, screenSize]);

  const activePrediction = predictions[activePredIdx] ?? null;

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* FULL-BLEED INFINITE CANVAS */}
      <JevCanvas
        svgRef={svgRef}
        elements={elements}
        selectedIds={selectedIds}
        tool={tool}
        theme={theme}
        renderStyle={renderStyle}
        viewport={viewport}
        activePrediction={activePrediction}
        promptPreviewElements={promptPreview.elements}
        peers={allPeers}
        onViewportChange={setViewport}
        onSelectIds={setSelectedIds}
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
                      onDoubleClick={() => spawnShapeAtCenter(t.id)}
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
        onDuplicate={(id) => handleDuplicateIds([id])}
        onDelete={(id) => handleDeleteIds([id])}
        onClose={() => setSelectedIds([])}
      />

      {/* MULTI-SELECTION FLOATING ACTION BAR */}
      {multiSelectBarPos && !canvasInteracting && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            transform: `translate3d(${multiSelectBarPos.x}px, ${multiSelectBarPos.y}px, 0)`,
          }}
          className="jev-glass fixed left-0 top-0 z-30 flex items-center gap-1.5 rounded-2xl px-2.5 py-1.5 shadow-[0_14px_36px_-12px_rgba(15,23,42,0.26)]"
        >
          <span className="px-1 font-mono text-[11px] font-semibold text-foreground">
            {selectedIds.length} selected
          </span>
          <span className="h-3.5 w-px bg-border" />
          <button
            type="button"
            onClick={handleWrapSelectionInFrame}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Frame className="h-3.5 w-3.5" />
            Frame
          </button>
          <button
            type="button"
            onClick={() => handleDuplicateIds(selectedIds)}
            className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => handleDeleteIds(selectedIds)}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            title="Delete selected"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
          placementInfo={livePromptBundle?.badge ?? null}
          onChange={setThoughtPrompt}
          onSubmit={handleSubmitThought}
          onClear={() => {
            setThoughtPrompt("");
            setLivePlacementDecision(null);
          }}
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
