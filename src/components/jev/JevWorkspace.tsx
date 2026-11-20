"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Database,
  Diamond,
  Download,
  Frame,
  GitFork,
  Hand,
  Maximize2,
  Mic,
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
  X,
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
import { ALL_TONES } from "@/lib/jev/colors";
import {
  DiagramPatternHint,
  layoutGraphToPromptElements,
  parsePromptToElements,
} from "@/lib/jev/diagram-parser";
import {
  buildFeedbackPreferenceSummary,
  loadFeedbackProfile,
  rankCandidatesWithFeedback,
  recordSuggestionAccepted,
  recordSuggestionRejected,
  recordSuggestionShown,
} from "@/lib/jev/feedback-store";
import {
  applyForkTakeToBoard,
  buildLocalForkTakes,
  type ForkTake,
  materializeForkTake,
  type SelectedSubgraph,
  validateForkTakesPayload,
} from "@/lib/jev/fork-engine";
import {
  computeBounds,
  computeViewportEnsureVisible,
  computeViewportFit,
  isShapeElement,
  makeSeed,
  Rect,
  uid,
  type ViewportMargins,
} from "@/lib/jev/geometry";
import {
  detectCreationIntent,
  detectMoveIntent,
} from "@/lib/jev/intent-engine";
import {
  applyMorphToBoard,
  detectSelectionMorphState,
  MORPH_NOTATION_LABELS,
  morphSelectionToNotation,
  validateMorphSemanticSpec,
} from "@/lib/jev/notation-morph";
import {
  buildTalkToDrawPrediction,
  correlateUtteranceToStroke,
  recordStrokeEnd,
  recordStrokeMove,
  recordStrokeStart,
  type StrokeTimelineEntry,
  validateTalkToDrawLlmResult,
} from "@/lib/jev/talk-to-draw";
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
import {
  type BoardEditDelta,
  serializeBoardToGraph,
  validateSemanticGraph,
} from "@/lib/jev/semantic-graph";
import {
  exportBoardToSvg,
  sanitizeExportFilename,
} from "@/lib/jev/svg-export";
import {
  createForkArchitectureStarterElements,
  createRequestFlowStarterElements,
  createStarterElements,
} from "@/lib/jev/templates";
import {
  BoardTheme,
  ElementBox,
  JevElement,
  JevTelemetry,
  MorphNotation,
  PeerCursor,
  Point,
  PredictedAction,
  RenderStyle,
  SpatialIntent,
  TombstoneMap,
  ToolType,
  Viewport,
} from "@/lib/jev/types";
import {
  BoardHistoryController,
  BroadcastThrottler,
} from "@/lib/jev/board-history";
import {
  applyLocalElementsChange,
  BoardSyncState,
  computeMaxKnownRev,
  createBoardEpoch,
  mergeRemoteBoardState,
  TOMBSTONE_TTL_MS,
} from "@/lib/jev/board-sync";
import {
  popRecoverySnapshot,
  pushRecoverySnapshot,
  type BoardRecoveryEntry,
} from "@/lib/jev/recovery-buffer";
import {
  RemoteChangeGuard,
  type PeerQuarantineIncident,
} from "@/lib/jev/remote-guard";
import {
  parseStoredBoardSnapshot,
  type StoredBoardSnapshot,
} from "@/lib/jev/sync-validation";
import {
  formatRoomHash,
  generateRoomCredentials,
  parseRoomHash,
  RoomCredentials,
} from "@/lib/jev/room-auth";
import { JevP2PCollab } from "@/lib/jev/webrtc-collab";
import { FirstRunEmptyState } from "./FirstRunEmptyState";
import { ForkHud } from "./ForkHud";
import { JevCanvas, type CanvasStrokeEvent } from "./JevCanvas";
import { NotationMorphBar } from "./NotationMorphBar";
import { PredictionHud } from "./PredictionHud";
import { SelectionInspector } from "./SelectionInspector";
import { ShareP2PDialog } from "./ShareP2PDialog";
import { TalkToDrawBar } from "./TalkToDrawBar";
import { PlacementBadgeInfo, ThoughtBar } from "./ThoughtBar";

const TOOLS: Array<{
  id: ToolType;
  label: string;
  key: string;
  icon: React.ReactNode;
}> = [
  { id: "select", label: "Select", key: "S", icon: <MousePointer2 className="h-4 w-4" /> },
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

function getOrCreateRoomCredentials(): RoomCredentials & {
  createdNew: boolean;
} {
  if (typeof window === "undefined") {
    return { roomId: "", roomSecret: "", createdNew: false };
  }
  const parsed = parseRoomHash(window.location.hash);
  if (parsed) {
    return { ...parsed, createdNew: false };
  }
  const fresh = generateRoomCredentials();
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  url.hash = formatRoomHash(fresh.roomId, fresh.roomSecret);
  window.history.replaceState({}, "", url.toString());
  return { ...fresh, createdNew: true };
}

interface BroadcastSyncPayload {
  elements: JevElement[];
  boardTitle: string;
  titleRev: number;
  titleUpdatedBy: string;
  tombstones: TombstoneMap;
  tombstoneHorizonRev: number;
  tombstoneHorizonAt: number;
  boardEpoch: string;
  boardEpochCreatedAt: number;
  baseRev: number;
  baseTimestamp: number;
  hasLocalEdits: boolean;
}

interface RecoveryToastState {
  entry: BoardRecoveryEntry;
  removedCount: number;
  editedCount: number;
  changedCount: number;
  localCount: number;
  kind: "full_replace" | "bulk_delete" | "remote_changes";
  savedSnapshotsCount: number;
}

interface ForkSessionState {
  subgraph: SelectedSubgraph;
  replacedIds: string[];
  takes: ForkTake[];
  activeIndex: number;
  source: "typesafe-jev" | "llm-json" | "heuristic";
  model: string;
  isHeuristic: boolean;
  latencyMs: number;
  evaluating: boolean;
}

function getBrowserStorage() {
  return typeof window !== "undefined" ? window.localStorage : null;
}

export function JevWorkspace() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const startInlineEditRef = useRef<((id: string) => void) | null>(null);
  const thoughtInputRef = useRef<HTMLInputElement | null>(null);
  const collabRef = useRef<JevP2PCollab | null>(null);
  const lastCursorSentRef = useRef<number>(0);

  const [roomId, setRoomId] = useState("");
  const [roomSecret, setRoomSecret] = useState("");
  const [boardTitle, setBoardTitle] = useState("Untitled Sheet");
  const [elements, setElements] = useState<JevElement[]>([]);
  const [boardReady, setBoardReady] = useState(false);
  const [joiningSharedRoom, setJoiningSharedRoom] = useState(false);
  const [historyCounts, setHistoryCounts] = useState({ undo: 0, redo: 0 });
  const historyRef = useRef<BoardHistoryController | null>(null);
  const remoteSyncGenerationRef = useRef<number>(0);
  const tombstonesRef = useRef<TombstoneMap>({});
  const tombstoneHorizonRevRef = useRef<number>(0);
  const tombstoneHorizonAtRef = useRef<number>(0);
  const boardEpochRef = useRef<string>(createBoardEpoch());
  const boardEpochCreatedAtRef = useRef<number>(0);
  const baseTimestampRef = useRef<number>(0);
  const titleRevRef = useRef<number>(0);
  const titleUpdatedByRef = useRef<string>("");
  const hasLocalEditsRef = useRef<boolean>(false);
  const canPersistRef = useRef<boolean>(false);
  const broadcastThrottlerRef =
    useRef<BroadcastThrottler<BroadcastSyncPayload> | null>(null);
  const remoteGuardRef = useRef<RemoteChangeGuard | null>(null);
  const [recoveryToast, setRecoveryToast] = useState<RecoveryToastState | null>(
    null
  );
  const [peerIncidents, setPeerIncidents] = useState<PeerQuarantineIncident[]>(
    []
  );
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const announceStatus = useCallback((message: string) => {
    setLiveAnnouncement("");
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => setLiveAnnouncement(message));
    } else {
      setLiveAnnouncement(message);
    }
  }, []);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [canvasInteracting, setCanvasInteracting] = useState(false);
  const [tool, setTool] = useState<ToolType>("select");
  const [theme, setTheme] = useState<BoardTheme>("vellum");
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("sketch");
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 40, zoom: 1 });
  const [screenSize, setScreenSize] = useState({ width: 1280, height: 800 });

  // Chunk 5b: Notation Morph & Talk-to-Draw state
  const [morphEvaluating, setMorphEvaluating] = useState(false);
  const [morphIsHeuristic, setMorphIsHeuristic] = useState(true);
  const morphAbortRef = useRef<AbortController | null>(null);

  const [talkToDrawActive, setTalkToDrawActive] = useState(false);
  const [talkEvaluating, setTalkEvaluating] = useState(false);
  const [talkIsHeuristic, setTalkIsHeuristic] = useState(true);
  const [lastTalkTranscript, setLastTalkTranscript] = useState("");
  const [latestStroke, setLatestStroke] = useState<StrokeTimelineEntry | null>(null);
  const strokeTimelineRef = useRef<StrokeTimelineEntry[]>([]);
  const talkAbortRef = useRef<AbortController | null>(null);

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
  const [placementCycleOffset, setPlacementCycleOffset] = useState(0);
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

  const [forkSession, setForkSession] = useState<ForkSessionState | null>(null);
  const forkAbortRef = useRef<AbortController | null>(null);
  const recentDeltasRef = useRef<BoardEditDelta[]>([]);

  const pushEditDelta = useCallback((delta: Omit<BoardEditDelta, "timestamp">) => {
    recentDeltasRef.current = [
      ...recentDeltasRef.current.slice(-15),
      { ...delta, timestamp: Date.now() },
    ];
  }, []);

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
  const getHistory = useCallback(() => {
    if (!historyRef.current) {
      historyRef.current = new BoardHistoryController(elementsRef.current);
    }
    return historyRef.current;
  }, []);
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

  // Fit diagram comfortably inside HUD-safe margins
  const fitToView = useCallback(
    (targetEls?: JevElement[], margins?: ViewportMargins) => {
      const list = targetEls ?? elementsRef.current;
      const bounds = computeBounds(list);
      if (!bounds || typeof window === "undefined") {
        setViewport({ x: 0, y: 0, zoom: 1 });
        return;
      }
      setViewport(
        computeViewportFit(bounds, {
          screenWidth: window.innerWidth,
          screenHeight: window.innerHeight,
          margins,
        })
      );
    },
    []
  );

  // Ensure new diagrams, morphs, or ghosts stay cleanly inside HUD-safe viewport bounds
  const ensureElementsVisible = useCallback(
    (targetEls: JevElement[], margins?: ViewportMargins) => {
      const bounds = computeBounds(targetEls);
      if (!bounds || typeof window === "undefined") return;
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;
      setViewport((prev) =>
        computeViewportEnsureVisible(prev, bounds, {
          screenWidth,
          screenHeight,
          margins,
        })
      );
    },
    []
  );

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

      const feedbackProfile = loadFeedbackProfile(getBrowserStorage());
      const preferenceSummary = buildFeedbackPreferenceSummary(feedbackProfile);
      const boardGraph = serializeBoardToGraph(currentEls, {
        subjectId: nextIntent.subjectId,
        recentDeltas: recentDeltasRef.current,
        boardTitle: boardTitleRef.current,
      });

      setTelemetry((prev) => ({
        source: prev?.source ?? "heuristic",
        model: prev?.model ?? "heuristic",
        isHeuristic: prev?.isHeuristic ?? true,
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
            boardGraph,
            intentSummary: `${nextIntent.headline} (${nextIntent.detail})`.slice(0, 320),
            stateSummary: serializeCanvasStateForJev(nextIntent, currentEls),
            ...(preferenceSummary ? { preferenceSummary } : {}),
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
          source: "typesafe-jev" | "llm-json" | "heuristic";
          model: string;
          isHeuristic?: boolean;
          latencyMs: number;
          usage?: { input_tokens?: number };
          nextActionProbabilities?: Record<string, number> | null;
          intentChoice?: string | null;
          intentConfidence?: number | null;
          shouldConnectProb?: number | null;
        };
        if (controller.signal.aborted) return;

        const isLiveModel =
          data.source === "typesafe-jev" && data.isHeuristic !== true;
        const probs = isLiveModel ? data.nextActionProbabilities ?? null : null;
        const ranked = (
          probs
            ? pool
                .map((action) => ({
                  ...action,
                  probability:
                    typeof probs[action.id] === "number"
                      ? probs[action.id]
                      : undefined,
                }))
                .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
            : rankCandidatesWithFeedback(
                pool.map((action) => ({
                  ...action,
                  feedbackKeys: action.feedbackKeys ?? [`cat:${action.category}`],
                })),
                feedbackProfile
              ).map(({ item }) => ({ ...item, probability: undefined }))
        ).slice(0, 3);

        setPredictions(ranked);
        setActivePredIdx(0);
        setTelemetry({
          source: isLiveModel ? "typesafe-jev" : "heuristic",
          model: data.model,
          isHeuristic: !isLiveModel,
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
    const creds = getOrCreateRoomCredentials();
    const rid = creds.roomId;
    const rsecret = creds.roomSecret;

    const throttler = new BroadcastThrottler<BroadcastSyncPayload>(
      (payload) => {
        collabRef.current?.broadcastState(payload.elements, payload.boardTitle, {
          titleRev: payload.titleRev,
          titleUpdatedBy: payload.titleUpdatedBy,
          tombstones: payload.tombstones,
          tombstoneHorizonRev: payload.tombstoneHorizonRev,
          tombstoneHorizonAt: payload.tombstoneHorizonAt,
          boardEpoch: payload.boardEpoch,
          boardEpochCreatedAt: payload.boardEpochCreatedAt,
          baseRev: payload.baseRev,
          baseTimestamp: payload.baseTimestamp,
          hasLocalEdits: payload.hasLocalEdits,
        });
      },
      60
    );
    broadcastThrottlerRef.current = throttler;

    const initNow = Date.now();
    boardEpochCreatedAtRef.current = initNow;
    baseTimestampRef.current = initNow;

    // Synchronously validate and restore any saved board snapshot before starting P2P
    // so the room host's state is immediately available for incoming handshakes.
    let initialEls = elementsRef.current;
    let initialTitle = boardTitleRef.current;
    let restored = false;
    try {
      const saved = window.localStorage.getItem(`jev_board_${rid}`);
      if (saved) {
        const parsed = parseStoredBoardSnapshot(saved);
        if (parsed && (parsed.elements.length > 0 || parsed.hasLocalEdits)) {
          initialEls = parsed.elements;
          if (parsed.boardTitle !== undefined) {
            initialTitle = parsed.boardTitle;
          }
          tombstonesRef.current = parsed.tombstones ?? {};
          tombstoneHorizonRevRef.current = parsed.tombstoneHorizonRev ?? 0;
          tombstoneHorizonAtRef.current = parsed.tombstoneHorizonAt ?? 0;
          if (parsed.boardEpoch) {
            boardEpochRef.current = parsed.boardEpoch;
          }
          if (parsed.boardEpochCreatedAt !== undefined) {
            boardEpochCreatedAtRef.current = parsed.boardEpochCreatedAt;
          }
          if (parsed.baseTimestamp !== undefined) {
            baseTimestampRef.current = parsed.baseTimestamp;
          }
          titleRevRef.current = parsed.titleRev ?? 0;
          titleUpdatedByRef.current = parsed.titleUpdatedBy ?? "";
          hasLocalEditsRef.current = parsed.hasLocalEdits ?? true;
          canPersistRef.current = true;
          elementsRef.current = initialEls;
          boardTitleRef.current = initialTitle;
          getHistory().replaceWithoutHistory(initialEls);
          restored = true;
        }
      }
    } catch {
      // ignore storage errors
    }

    if (creds.createdNew) {
      canPersistRef.current = true;
    }

    const initTimer = window.setTimeout(() => {
      setRoomId(rid);
      setRoomSecret(rsecret);
      if (restored) {
        setElements(initialEls);
        setBoardTitle(initialTitle);
        setJoiningSharedRoom(false);
        setBoardReady(true);
        if (initialEls.length > 0) {
          fitToView(initialEls);
          const anchor =
            initialEls.find((e) => e.id === "starter_mesh") ??
            initialEls[initialEls.length - 1];
          if (anchor) {
            const initialIntent: SpatialIntent = {
              kind: "domain_continue",
              headline: "Restored your room — drag any node or press Tab + Enter",
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
        }
      } else {
        setJoiningSharedRoom(!creds.createdNew);
        setBoardReady(true);
      }
    }, 0);

    // Start WebRTC + BroadcastChannel P2P session
    const remoteGuard = new RemoteChangeGuard(initNow);
    remoteGuardRef.current = remoteGuard;

    const myName =
      PEER_NAMES[Math.floor(Math.random() * PEER_NAMES.length)];
    const collab: JevP2PCollab = new JevP2PCollab(
      rid,
      rsecret,
      myName,
      {
        onPeersChange: (list) => setRemotePeers(list),
        onRemoteState: (remoteEls, remoteTitle, meta) => {
          const now = Date.now();
          const localSync: BoardSyncState = {
            elements: elementsRef.current,
            boardTitle: boardTitleRef.current,
            titleRev: titleRevRef.current,
            titleUpdatedBy: titleUpdatedByRef.current || collab.peerId,
            tombstones: tombstonesRef.current,
            tombstoneHorizonRev: tombstoneHorizonRevRef.current,
            tombstoneHorizonAt: tombstoneHorizonAtRef.current,
            boardEpoch: boardEpochRef.current,
            boardEpochCreatedAt: boardEpochCreatedAtRef.current,
            baseRev: computeMaxKnownRev({
              elements: elementsRef.current,
              tombstones: tombstonesRef.current,
              titleRev: titleRevRef.current,
              tombstoneHorizonRev: tombstoneHorizonRevRef.current,
            }),
            baseTimestamp: baseTimestampRef.current,
            hasLocalEdits: hasLocalEditsRef.current,
          };
          const evaluated = remoteGuard.evaluateIncoming({
            local: localSync,
            remote: {
              elements: remoteEls,
              boardTitle: remoteTitle,
              titleRev: meta?.titleRev,
              titleUpdatedBy: meta?.titleUpdatedBy,
              titleUpdatedAt: meta?.titleUpdatedAt,
              tombstones: meta?.tombstones,
              tombstoneHorizonRev: meta?.tombstoneHorizonRev,
              tombstoneHorizonAt: meta?.tombstoneHorizonAt,
              boardEpoch: meta?.boardEpoch,
              boardEpochCreatedAt: meta?.boardEpochCreatedAt,
              baseRev: meta?.baseRev,
              baseTimestamp: meta?.baseTimestamp,
              fullResync: meta?.fullResync,
              hasLocalEdits: meta?.hasLocalEdits,
              senderPeerId: meta?.senderPeerId ?? "remote",
              verifiedSenderPeerId: meta?.verifiedSenderPeerId,
            },
            localPeerId: collab.peerId,
            senderName: meta?.senderName,
            mergeOptions: {
              authoritativePeerId: meta?.authoritativePeerId,
              now,
              tombstoneTtlMs: TOMBSTONE_TTL_MS,
            },
            now,
          });

          if (evaluated.decision === "resync") {
            if (meta?.authoritativePeerId === collab.peerId) {
              collab.sendFullResync(
                meta?.verifiedSenderPeerId ?? meta?.senderPeerId
              );
            } else {
              collab.requestFullResync(meta?.authoritativePeerId ?? undefined);
            }
            return;
          }

          if (evaluated.decision === "noop") {
            return;
          }

          const storage =
            typeof window !== "undefined" ? window.localStorage : null;

          if (evaluated.decision === "paused") {
            if (evaluated.recoveryEntry) {
              pushRecoverySnapshot(storage, rid, evaluated.recoveryEntry);
            }
            setPeerIncidents(remoteGuard.getActiveIncidents());
            return;
          }

          const merged = evaluated.merged;
          if (evaluated.recoveryEntry) {
            const savedList = pushRecoverySnapshot(
              storage,
              rid,
              evaluated.recoveryEntry
            );
            if (evaluated.showRestoreToast && evaluated.toastSummary) {
              setRecoveryToast({
                entry: evaluated.recoveryEntry,
                removedCount: evaluated.toastSummary.removedCount,
                editedCount: evaluated.toastSummary.editedCount,
                changedCount: evaluated.toastSummary.changedCount,
                localCount: evaluated.toastSummary.localCount,
                kind: evaluated.toastSummary.kind,
                savedSnapshotsCount: Math.max(1, savedList.length),
              });
            }
          }

          const wasEmptyBeforeSync = elementsRef.current.length === 0;
          elementsRef.current = merged.state.elements;
          boardTitleRef.current = merged.state.boardTitle;
          titleRevRef.current = merged.state.titleRev ?? 0;
          titleUpdatedByRef.current = merged.state.titleUpdatedBy ?? "";
          tombstonesRef.current = merged.state.tombstones;
          tombstoneHorizonRevRef.current = merged.state.tombstoneHorizonRev ?? 0;
          tombstoneHorizonAtRef.current = merged.state.tombstoneHorizonAt ?? 0;
          if (merged.state.boardEpoch) {
            boardEpochRef.current = merged.state.boardEpoch;
          }
          if (merged.state.boardEpochCreatedAt !== undefined) {
            boardEpochCreatedAtRef.current = merged.state.boardEpochCreatedAt;
          }
          baseTimestampRef.current = merged.state.baseTimestamp ?? now;
          hasLocalEditsRef.current = merged.state.hasLocalEdits;
          canPersistRef.current = true;

          if (merged.changed) {
            // Clear local undo/redo and bump remoteSyncGeneration so any in-progress drag drops its stale snapshot
            const history = getHistory();
            history.applyRemote(merged.state.elements, {
              clearHistory: true,
            });
            remoteSyncGenerationRef.current = history.remoteSyncGeneration;
            setHistoryCounts({ undo: 0, redo: 0 });
          }

          setJoiningSharedRoom(false);
          setElements(merged.state.elements);
          setBoardTitle(merged.state.boardTitle);
          if (wasEmptyBeforeSync && merged.state.elements.length > 0) {
            fitToView(merged.state.elements);
          }
        },
        onGetLocalState: () => ({
          elements: elementsRef.current,
          boardTitle: boardTitleRef.current,
          titleRev: titleRevRef.current,
          titleUpdatedBy: titleUpdatedByRef.current || collab.peerId,
          tombstones: tombstonesRef.current,
          tombstoneHorizonRev: tombstoneHorizonRevRef.current,
          tombstoneHorizonAt: tombstoneHorizonAtRef.current,
          boardEpoch: boardEpochRef.current,
          boardEpochCreatedAt: boardEpochCreatedAtRef.current,
          baseRev: computeMaxKnownRev({
            elements: elementsRef.current,
            tombstones: tombstonesRef.current,
            titleRev: titleRevRef.current,
            tombstoneHorizonRev: tombstoneHorizonRevRef.current,
          }),
          baseTimestamp: baseTimestampRef.current,
          hasLocalEdits: hasLocalEditsRef.current,
        }),
        onStatusChange: (status) => setCollabStatus(status),
      },
      {
        isRoomCreator: creds.createdNew || restored,
      }
    );
    collab.start();
    collabRef.current = collab;

    const periodicSnapshotTimer = window.setInterval(() => {
      const now = Date.now();
      const currentState: BoardSyncState = {
        elements: elementsRef.current,
        boardTitle: boardTitleRef.current,
        titleRev: titleRevRef.current,
        titleUpdatedBy: titleUpdatedByRef.current || collab.peerId,
        tombstones: tombstonesRef.current,
        tombstoneHorizonRev: tombstoneHorizonRevRef.current,
        tombstoneHorizonAt: tombstoneHorizonAtRef.current,
        boardEpoch: boardEpochRef.current,
        boardEpochCreatedAt: boardEpochCreatedAtRef.current,
        baseTimestamp: baseTimestampRef.current,
        hasLocalEdits: hasLocalEditsRef.current,
      };
      const periodicEntry = remoteGuard.maybeTakePeriodicSnapshot(
        currentState,
        now
      );
      if (periodicEntry) {
        pushRecoverySnapshot(
          typeof window !== "undefined" ? window.localStorage : null,
          rid,
          periodicEntry
        );
      }
    }, 15_000);

    return () => {
      window.clearTimeout(initTimer);
      window.clearInterval(periodicSnapshotTimer);
      decideAbortRef.current?.abort();
      forkAbortRef.current?.abort();
      throttler.cancel();
      broadcastThrottlerRef.current = null;
      remoteGuardRef.current = null;
      collab.destroy();
      collabRef.current = null;
    };
  }, [fitToView, rankWithTypeSafeJev, getHistory]);

  // Persist to localStorage quietly (only once local edits exist or host state was synced/created)
  useEffect(() => {
    if (!roomId || !canPersistRef.current) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          `jev_board_${roomId}`,
          JSON.stringify({
            elements,
            boardTitle,
            titleRev: titleRevRef.current,
            titleUpdatedBy: titleUpdatedByRef.current || undefined,
            tombstones: tombstonesRef.current,
            tombstoneHorizonRev: tombstoneHorizonRevRef.current,
            tombstoneHorizonAt: tombstoneHorizonAtRef.current,
            boardEpoch: boardEpochRef.current,
            boardEpochCreatedAt: boardEpochCreatedAtRef.current,
            baseTimestamp: baseTimestampRef.current,
            hasLocalEdits: hasLocalEditsRef.current,
          })
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

    const orderedSlots = [
      ...plan.candidates.filter((c) => c.id === preferredSlotId),
      ...plan.candidates.filter((c) => c.id !== preferredSlotId),
    ];

    const preferredConnectId =
      plan.isSingleComponent && plan.connectTargets.length > 0
        ? livePlacementDecision?.prompt === trimmed &&
          livePlacementDecision.connectTargetId !== undefined
          ? livePlacementDecision.connectTargetId
          : plan.defaultConnectTargetId
        : null;

    const orderedConnectTargets =
      plan.isSingleComponent && plan.connectTargets.length > 0
        ? [
            ...plan.connectTargets.filter((ct) => ct.id === preferredConnectId),
            ...plan.connectTargets.filter((ct) => ct.id !== preferredConnectId),
          ]
        : [];

    const isConnectMode = orderedConnectTargets.length > 0;
    const activeConnectTarget = isConnectMode
      ? orderedConnectTargets[
          ((placementCycleOffset % orderedConnectTargets.length) +
            orderedConnectTargets.length) %
            orderedConnectTargets.length
        ]
      : null;

    const activeSlot = !isConnectMode
      ? orderedSlots[
          ((placementCycleOffset % Math.max(1, orderedSlots.length)) +
            Math.max(1, orderedSlots.length)) %
            Math.max(1, orderedSlots.length)
        ] ?? orderedSlots[0]
      : orderedSlots[0];

    const chosenConnect =
      activeConnectTarget && activeConnectTarget.id !== "none"
        ? activeConnectTarget
        : null;
    const chosen = activeSlot ?? plan.candidates[0];
    const optionCount = isConnectMode
      ? orderedConnectTargets.length
      : orderedSlots.length;

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

    const isDefaultChoice = placementCycleOffset === 0;
    const fromLiveJev =
      isDefaultChoice &&
      livePlacementDecision?.prompt === trimmed &&
      livePlacementDecision.fromJev;
    const badge: PlacementBadgeInfo | null = activeConnectTarget
      ? {
          label:
            activeConnectTarget.id === "none" && chosen
              ? chosen.label
              : activeConnectTarget.label,
          confidence:
            fromLiveJev &&
            typeof livePlacementDecision?.connectConfidence === "number"
              ? livePlacementDecision.connectConfidence
              : undefined,
          fromJev: fromLiveJev,
          evaluating:
            isDefaultChoice && livePlacementDecision?.prompt === trimmed
              ? livePlacementDecision.evaluating
              : false,
          optionCount,
        }
      : chosen
        ? {
            label: chosen.label,
            confidence: fromLiveJev
              ? livePlacementDecision?.confidence
              : undefined,
            fromJev: fromLiveJev,
            evaluating:
              isDefaultChoice && livePlacementDecision?.prompt === trimmed
                ? livePlacementDecision.evaluating
                : false,
            optionCount,
          }
        : null;

    return {
      trimmed,
      base,
      plan,
      chosen,
      chosenConnect,
      activeConnectTargetId: activeConnectTarget?.id ?? null,
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
    placementCycleOffset,
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
        const boardGraph = serializeBoardToGraph(elementsRef.current, {
          selectedIds,
          recentDeltas: recentDeltasRef.current,
          boardTitle: boardTitleRef.current,
        });
        const preferenceSummary = buildFeedbackPreferenceSummary(
          loadFeedbackProfile(getBrowserStorage())
        );

        const res = await fetch("/api/jev/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: "place_diagram",
            prompt: trimmed,
            boardGraph,
            stateSummary: plan.stateSummary,
            ...(preferenceSummary ? { preferenceSummary } : {}),
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
          source: "typesafe-jev" | "heuristic";
          model: string;
          isHeuristic?: boolean;
          latencyMs: number;
          chosenSlotId?: PlacementSlotId;
          slotConfidence?: number | null;
          connectTargetId?: string | null;
          connectConfidence?: number | null;
          pattern?: DiagramPatternHint | null;
        };
        if (controller.signal.aborted) return;

        const isLiveModel =
          data.source === "typesafe-jev" && data.isHeuristic !== true;

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
          confidence:
            isLiveModel && typeof data.slotConfidence === "number"
              ? data.slotConfidence
              : undefined,
          connectTargetId: resolvedConnectId,
          connectConfidence:
            isLiveModel && typeof data.connectConfidence === "number"
              ? data.connectConfidence
              : undefined,
          fromJev: isLiveModel,
          pattern: isLiveModel ? data.pattern ?? null : null,
          evaluating: false,
        });

        setTelemetry({
          source: isLiveModel ? "typesafe-jev" : "heuristic",
          model: data.model,
          isHeuristic: !isLiveModel,
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
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
    // Intentionally trigger when the prompt text changes (or previous flow changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thoughtPrompt, lastPromptFlow]);

  const updateElements = useCallback(
    (
      updater: (prev: JevElement[]) => JevElement[],
      opts?: {
        recordUndo?: boolean;
        undoSnapshot?: JevElement[];
        expectedRemoteSyncGeneration?: number;
        broadcast?: boolean;
        throttleBroadcast?: boolean;
        flushBroadcast?: boolean;
      }
    ): JevElement[] => {
      const recordUndo = opts?.recordUndo ?? true;
      const shouldBroadcast = opts?.broadcast ?? true;
      const prev = elementsRef.current;
      const rawNext = updater(prev);
      const peerId = collabRef.current?.peerId ?? "local";
      const now = Date.now();
      const stamped = applyLocalElementsChange(
        prev,
        rawNext,
        tombstonesRef.current,
        peerId,
        now,
        tombstoneHorizonRevRef.current,
        {
          ttlMs: TOMBSTONE_TTL_MS,
          prevHorizonAt: tombstoneHorizonAtRef.current,
        }
      );

      const history = getHistory();
      history.commitLocal(stamped.elements, {
        recordUndo,
        undoSnapshot: opts?.undoSnapshot,
        expectedRemoteSyncGeneration: opts?.expectedRemoteSyncGeneration,
      });
      elementsRef.current = stamped.elements;
      tombstonesRef.current = stamped.tombstones;
      tombstoneHorizonRevRef.current = stamped.tombstoneHorizonRev;
      tombstoneHorizonAtRef.current = stamped.tombstoneHorizonAt;
      if (
        (collabRef.current?.getConnectedPeerCount() ?? 0) > 0 ||
        baseTimestampRef.current === 0
      ) {
        baseTimestampRef.current = now;
      }
      hasLocalEditsRef.current = true;
      canPersistRef.current = true;
      remoteGuardRef.current?.markLocalChange(now);

      setElements(stamped.elements);
      setHistoryCounts({
        undo: history.undoCount,
        redo: history.redoCount,
      });

      if (shouldBroadcast) {
        const payload: BroadcastSyncPayload = {
          elements: stamped.elements,
          boardTitle: boardTitleRef.current,
          titleRev: titleRevRef.current,
          titleUpdatedBy: titleUpdatedByRef.current || peerId,
          tombstones: stamped.tombstones,
          tombstoneHorizonRev: stamped.tombstoneHorizonRev,
          tombstoneHorizonAt: stamped.tombstoneHorizonAt,
          boardEpoch: boardEpochRef.current,
          boardEpochCreatedAt: boardEpochCreatedAtRef.current,
          baseRev: computeMaxKnownRev({
            elements: stamped.elements,
            tombstones: stamped.tombstones,
            titleRev: titleRevRef.current,
            tombstoneHorizonRev: stamped.tombstoneHorizonRev,
          }),
          baseTimestamp: baseTimestampRef.current,
          hasLocalEdits: true,
        };
        if (opts?.throttleBroadcast && !opts?.flushBroadcast) {
          broadcastThrottlerRef.current?.schedule(payload);
        } else {
          broadcastThrottlerRef.current?.flushNow(payload);
        }
      }

      return stamped.elements;
    },
    [getHistory]
  );

  const refreshPredictions = useCallback(
    (nextIntent: SpatialIntent, currentEls: JevElement[]) => {
      setIntent(nextIntent);
      const pool = generateCandidatePool(nextIntent, currentEls);
      const storage = getBrowserStorage();
      const profile = loadFeedbackProfile(storage);
      const adapted = rankCandidatesWithFeedback(
        pool.map((action) => ({
          ...action,
          feedbackKeys: action.feedbackKeys ?? [`cat:${action.category}`],
        })),
        profile
      ).map(({ item }) => ({ ...item, probability: undefined }));
      const top3 = adapted.slice(0, 3);
      if (top3.length > 0) {
        recordSuggestionShown(
          storage,
          top3.flatMap((p) => p.feedbackKeys ?? [])
        );
      }
      setPredictions(top3);
      setActivePredIdx(0);
      void rankWithTypeSafeJev(nextIntent, currentEls, adapted);
    },
    [rankWithTypeSafeJev]
  );

  const dismissPredictions = useCallback(() => {
    const active = predictions[activePredIdx] ?? predictions[0];
    if (active?.feedbackKeys && active.feedbackKeys.length > 0) {
      recordSuggestionRejected(getBrowserStorage(), active.feedbackKeys);
    }
    setPredictions([]);
    setIntent(null);
  }, [predictions, activePredIdx]);

  const handleElementMoved = useCallback(
    (moved: JevElement, dragStart: ElementBox) => {
      const latest = elementsRef.current.map((e) =>
        e.id === moved.id ? moved : e
      );
      pushEditDelta({
        op: "move",
        elementIds: [moved.id],
        labels: [moved.label],
        dx: moved.x - dragStart.x,
        dy: moved.y - dragStart.y,
        summary: `Moved ${moved.label || moved.kind}`,
      });
      const detected = detectMoveIntent(moved, dragStart, latest);
      refreshPredictions(detected, latest);
    },
    [refreshPredictions, pushEditDelta]
  );

  const handleElementCreated = useCallback(
    (created: JevElement) => {
      const latest = elementsRef.current.some((e) => e.id === created.id)
        ? elementsRef.current
        : [...elementsRef.current, created];
      pushEditDelta({
        op: "add",
        elementIds: [created.id],
        labels: [created.label],
        summary: `Added ${created.label || created.kind}`,
      });
      const detected = detectCreationIntent(created, latest, false);
      refreshPredictions(detected, latest);
    },
    [refreshPredictions, pushEditDelta]
  );

  const handleElementLabelEdited = useCallback(
    (edited: JevElement) => {
      const latest = elementsRef.current.map((e) =>
        e.id === edited.id ? edited : e
      );
      pushEditDelta({
        op: "update",
        elementIds: [edited.id],
        labels: [edited.label],
        summary: `Renamed to ${edited.label || edited.kind}`,
      });
      const detected = detectCreationIntent(edited, latest, false);
      refreshPredictions(detected, latest);
    },
    [refreshPredictions, pushEditDelta]
  );

  const applyPrediction = useCallback(
    (idx: number) => {
      const pred = predictions[idx];
      if (!pred) return;

      if (pred.feedbackKeys && pred.feedbackKeys.length > 0) {
        recordSuggestionAccepted(getBrowserStorage(), pred.feedbackKeys);
      }

      const removeSet = new Set(pred.removeIds ?? []);
      const patchMap = new Map(
        (pred.patchElements ?? []).map((p) => [p.id, p])
      );

      const nextElsSnapshot = updateElements((prev) => {
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
        return [...framesToAdd, ...updated, ...othersToAdd];
      });

      pushEditDelta({
        op: "add",
        elementIds: pred.addElements.map((e) => e.id).slice(0, 8),
        summary: `Applied ${pred.title}`,
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
    [predictions, updateElements, refreshPredictions, pushEditDelta]
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
      let upstreamElementsOverride: {
        elements: JevElement[];
        summary: string;
        focusId?: string;
      } | null = null;

      const matchesLivePreview =
        livePromptBundle !== null && livePromptBundle.trimmed === prompt;

      // 100% WYSIWYG instant commit whenever the ghost preview is already settled,
      // manually cycled with Tab, explicit arrow syntax, or a focused single component!
      const canCommitImmediately =
        matchesLivePreview &&
        (placementCycleOffset !== 0 ||
          hasExplicitArrows ||
          plan.isSingleComponent ||
          (livePlacementDecision?.prompt === prompt &&
            !livePlacementDecision.evaluating));

      const boardGraph = serializeBoardToGraph(currentEls, {
        selectedIds,
        recentDeltas: recentDeltasRef.current,
        boardTitle: boardTitleRef.current,
      });
      const preferenceSummary = buildFeedbackPreferenceSummary(
        loadFeedbackProfile(getBrowserStorage())
      );

      if (canCommitImmediately && livePromptBundle) {
        if (livePromptBundle.chosen) {
          chosenSlotId = livePromptBundle.chosen.id;
        }
        chosenConnectId = livePromptBundle.activeConnectTargetId;
        if (livePlacementDecision?.prompt === prompt) {
          patternHint = livePlacementDecision.pattern ?? null;
        }
      } else {
        try {
          const res = await fetch("/api/jev/decide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "place_diagram",
              prompt,
              boardGraph,
              stateSummary: plan.stateSummary,
              ...(preferenceSummary ? { preferenceSummary } : {}),
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
              source: "typesafe-jev" | "llm-json" | "heuristic";
              model: string;
              isHeuristic?: boolean;
              latencyMs: number;
              chosenSlotId?: PlacementSlotId;
              connectTargetId?: string | null;
              pattern?: DiagramPatternHint | null;
            };
            const isLiveModel =
              data.source === "typesafe-jev" && data.isHeuristic !== true;
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
            if (isLiveModel && data.pattern) {
              patternHint = data.pattern;
            }
            setTelemetry({
              source: isLiveModel ? "typesafe-jev" : "heuristic",
              model: data.model,
              isHeuristic: !isLiveModel,
              latencyMs: data.latencyMs,
              evaluating: false,
            });
          }
        } catch {
          // fall back seamlessly to deterministic placement plan
        }
      }

      // For rich multi-word natural-language prompts, query structured generate_graph when
      // not already settled from a live heuristic/manual preview
      if (
        !hasExplicitArrows &&
        !plan.isSingleComponent &&
        prompt.split(/\s+/).length >= 3 &&
        (!matchesLivePreview || livePlacementDecision?.fromJev)
      ) {
        try {
          const genRes = await fetch("/api/jev/decide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "generate_graph",
              prompt,
              boardGraph,
              ...(preferenceSummary ? { preferenceSummary } : {}),
            }),
          });
          if (genRes.ok) {
            const genData = (await genRes.json()) as {
              source: "typesafe-jev" | "llm-json" | "heuristic";
              model: string;
              isHeuristic?: boolean;
              latencyMs: number;
              graph?: unknown;
            };
            if (genData.graph && genData.isHeuristic !== true) {
              const validated = validateSemanticGraph(genData.graph);
              if (validated.ok) {
                upstreamElementsOverride = layoutGraphToPromptElements(
                  validated.graph,
                  currentEls,
                  viewportCenterWorld
                );
                setTelemetry({
                  source: genData.source,
                  model: genData.model,
                  isHeuristic: false,
                  latencyMs: genData.latencyMs,
                  evaluating: false,
                });
              }
            }
          }
        } catch {
          // fall back seamlessly to local semantic graph
        }
      }

      const finalParsed = upstreamElementsOverride
        ? upstreamElementsOverride
        : patternHint
          ? parsePromptToElements(
              prompt,
              currentEls,
              viewportCenterWorld,
              patternHint
            )
          : initialParsed;
      if (finalParsed.elements.length === 0) return;

      // Recompute exact top-left if pattern or upstream graph changed diagram dimensions
      const finalPlan =
        upstreamElementsOverride || patternHint
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

      const combined = updateElements((prev) => {
        const framesToAdd = positioned.filter((e) => e.kind === "frame");
        const rest = positioned.filter((e) => e.kind !== "frame");
        return [...framesToAdd, ...prev, ...rest];
      });

      pushEditDelta({
        op: "prompt",
        elementIds: positioned.map((e) => e.id).slice(0, 8),
        summary: `Drew "${prompt.slice(0, 60)}"`,
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
        if (currentEls.length === 0) {
          fitToView(positioned, { top: 104, right: 64, bottom: 255, left: 64 });
        } else {
          ensureElementsVisible(positioned, {
            top: 104,
            right: 64,
            bottom: 255,
            left: 64,
          });
        }
      }

      setThoughtPrompt("");
      setPlacementCycleOffset(0);
      setLivePlacementDecision(null);

      // Focus the newly placed node as the anchor for rapid chaining without popping open the edit dialog
      const focusEl = connectedNodeId
        ? combined.find((e) => e.id === connectedNodeId)
        : finalParsed.focusId
          ? combined.find((e) => e.id === finalParsed.focusId)
          : combined[combined.length - 1];
      if (focusEl) {
        setSelectedIds([focusEl.id]);
        setInspectorOpen(false);
        const detected = detectCreationIntent(focusEl, combined, true);
        refreshPredictions(detected, combined);
      }
    },
    [
      updateElements,
      refreshPredictions,
      fitToView,
      ensureElementsVisible,
      viewportCenterWorld,
      viewportWorld,
      selectedIds,
      livePlacementDecision,
      livePromptBundle,
      placementCycleOffset,
      pushEditDelta,
    ]
  );

  // --- FORK IT: 3 Distinct Ghosted Architectural Takes ---
  const startForkSelection = useCallback(
    async (overrideIds?: string[], overrideEls?: JevElement[]) => {
      const targetIds = overrideIds ?? selectedIds;
      const currentEls = overrideEls ?? elementsRef.current;
      const localResult = buildLocalForkTakes(targetIds, currentEls);
      if (!localResult) return;

      const storage = getBrowserStorage();
      const profile = loadFeedbackProfile(storage);
      const adaptedTakes = rankCandidatesWithFeedback(
        localResult.takes,
        profile
      ).map(({ item }) => ({ ...item, probability: undefined }));

      recordSuggestionShown(
        storage,
        adaptedTakes.flatMap((t) => t.feedbackKeys)
      );

      setPredictions([]);
      setIntent(null);
      setInspectorOpen(false);
      setThoughtPrompt("");

      forkAbortRef.current?.abort();
      const controller = new AbortController();
      forkAbortRef.current = controller;

      setForkSession({
        subgraph: localResult.subgraph,
        replacedIds: localResult.replacedIds,
        takes: adaptedTakes,
        activeIndex: 0,
        source: "heuristic",
        model: "heuristic",
        isHeuristic: true,
        latencyMs: 0,
        evaluating: true,
      });

      if (adaptedTakes[0]) {
        fitToView(
          [
            ...localResult.subgraph.selectedShapes,
            ...localResult.subgraph.selectedFrames,
            ...adaptedTakes[0].previewElements,
          ],
          { top: 100, right: 64, bottom: 300, left: 64 }
        );
      }

      try {
        const boardGraph = serializeBoardToGraph(currentEls, {
          selectedIds: targetIds,
          recentDeltas: recentDeltasRef.current,
          boardTitle: boardTitleRef.current,
        });
        const preferenceSummary = buildFeedbackPreferenceSummary(profile);

        const res = await fetch("/api/jev/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: "fork_architecture",
            selectedIds: targetIds,
            boardGraph,
            ...(preferenceSummary ? { preferenceSummary } : {}),
            candidateTakes: adaptedTakes.map((t) => ({
              archetype: t.archetype,
              title: t.title,
              rationale: t.rationale,
              tradeoffTag: t.tradeoffTag,
            })),
          }),
        });
        if (!res.ok || controller.signal.aborted) {
          setForkSession((prev) => (prev ? { ...prev, evaluating: false } : null));
          return;
        }

        const data = (await res.json()) as {
          source: "typesafe-jev" | "llm-json" | "heuristic";
          model: string;
          isHeuristic?: boolean;
          latencyMs: number;
          takeProbabilities?: Record<string, number> | null;
          takes?: unknown;
        };
        if (controller.signal.aborted) return;

        const isLiveModel =
          (data.source === "typesafe-jev" || data.source === "llm-json") &&
          data.isHeuristic !== true;

        if (data.source === "llm-json" && data.takes) {
          const validated = validateForkTakesPayload({ takes: data.takes });
          if (validated.ok) {
            const materialized = validated.takes.map((spec) =>
              materializeForkTake(spec, localResult.subgraph)
            );
            setForkSession((prev) =>
              prev
                ? {
                    ...prev,
                    takes: materialized,
                    activeIndex: 0,
                    source: "llm-json",
                    model: data.model,
                    isHeuristic: false,
                    latencyMs: data.latencyMs,
                    evaluating: false,
                  }
                : null
            );
            return;
          }
        }

        if (isLiveModel && data.takeProbabilities) {
          const probs = data.takeProbabilities;
          setForkSession((prev) => {
            if (!prev) return null;
            const ranked = prev.takes
              .map((t) => ({
                ...t,
                probability:
                  typeof probs[t.archetype] === "number"
                    ? probs[t.archetype]
                    : undefined,
              }))
              .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
            return {
              ...prev,
              takes: ranked,
              activeIndex: 0,
              source: "typesafe-jev",
              model: data.model,
              isHeuristic: false,
              latencyMs: data.latencyMs,
              evaluating: false,
            };
          });
          return;
        }

        setForkSession((prev) =>
          prev
            ? {
                ...prev,
                source: "heuristic",
                model: "heuristic",
                isHeuristic: true,
                latencyMs: data.latencyMs ?? 0,
                evaluating: false,
              }
            : null
        );
      } catch {
        if (!controller.signal.aborted) {
          setForkSession((prev) => (prev ? { ...prev, evaluating: false } : null));
        }
      }
    },
    [selectedIds, fitToView]
  );

  const applyForkTake = useCallback(
    (idx: number) => {
      if (!forkSession) return;
      const take = forkSession.takes[idx];
      if (!take) return;

      forkAbortRef.current?.abort();
      recordSuggestionAccepted(getBrowserStorage(), take.feedbackKeys);

      const nextElements = updateElements((prev) =>
        applyForkTakeToBoard(prev, forkSession.replacedIds, take)
      );

      const newShapeIds = take.elements
        .filter((e) => isShapeElement(e) && e.kind !== "frame")
        .map((e) => e.id);

      pushEditDelta({
        op: "fork",
        elementIds: newShapeIds.slice(0, 8),
        summary: `Forked into ${take.title}`,
      });

      setForkSession(null);
      setSelectedIds(newShapeIds);
      setInspectorOpen(false);
      announceStatus(`Swapped in fork take: ${take.title}`);
      fitToView(nextElements, { top: 104, right: 64, bottom: 255, left: 64 });

      const anchor =
        nextElements.find((e) => e.id === take.exitElementId) ??
        nextElements.find((e) => newShapeIds.includes(e.id));
      if (anchor) {
        const followUpIntent: SpatialIntent = {
          kind: "domain_continue",
          headline: `Swapped in "${take.title}"`,
          detail: "⌘Z to undo in one step · Tab + Enter to continue",
          subjectId: anchor.id,
          relatedIds: newShapeIds.slice(0, 4),
          timestamp: Date.now(),
        };
        refreshPredictions(followUpIntent, nextElements);
      }
    },
    [forkSession, updateElements, pushEditDelta, refreshPredictions, fitToView, announceStatus]
  );

  const cancelForkSession = useCallback(() => {
    forkAbortRef.current?.abort();
    if (forkSession) {
      const active =
        forkSession.takes[forkSession.activeIndex] ?? forkSession.takes[0];
      if (active) {
        recordSuggestionRejected(getBrowserStorage(), active.feedbackKeys);
      }
      announceStatus("Cancelled Fork It preview");
    }
    setForkSession(null);
  }, [forkSession, announceStatus]);

  // --- NOTATION MORPH: Reversible In-Place Semantic Morphing ---
  const selectionMorphState = useMemo(
    () => detectSelectionMorphState(selectedIds, elements),
    [selectedIds, elements]
  );

  const handleMorphNotation = useCallback(
    async (
      targetNotation: MorphNotation,
      overrideIds?: string[],
      overrideEls?: JevElement[]
    ) => {
      const targetIds = overrideIds ?? selectedIds;
      const currentEls = overrideEls ?? elementsRef.current;
      const morph = morphSelectionToNotation(
        targetIds,
        currentEls,
        targetNotation
      );
      if (!morph) return;

      morphAbortRef.current?.abort();
      forkAbortRef.current?.abort();
      setForkSession(null);
      setPredictions([]);
      setIntent(null);

      const morphedBoard = updateElements((prev) =>
        applyMorphToBoard(prev, morph)
      );

      setSelectedIds(morph.nextSelectedIds);
      setInspectorOpen(morph.nextSelectedIds.length === 1);
      setMorphIsHeuristic(true);

      const morphedOnly = morphedBoard.filter((e) =>
        morph.nextSelectedIds.includes(e.id) ||
        e.morphMeta?.groupId === morph.groupId
      );
      if (morphedOnly.length >= morphedBoard.length * 0.7) {
        fitToView(morphedBoard, { top: 128, right: 64, bottom: 132, left: 64 });
      } else {
        ensureElementsVisible(morphedOnly, {
          top: 128,
          right: 64,
          bottom: 132,
          left: 64,
        });
      }

      pushEditDelta({
        op: "update",
        elementIds: morph.nextSelectedIds.slice(0, 8),
        summary: `Morphed to ${MORPH_NOTATION_LABELS[targetNotation]}`,
      });
      announceStatus(
        targetNotation === "sketch"
          ? "Restored selection to Sketch notation"
          : `Morphed selection to ${MORPH_NOTATION_LABELS[targetNotation]} notation`
      );

      if (targetNotation === "sketch") {
        setMorphEvaluating(false);
        return;
      }

      const controller = new AbortController();
      morphAbortRef.current = controller;
      setMorphEvaluating(true);

      try {
        const boardGraph = serializeBoardToGraph(currentEls, {
          selectedIds: targetIds,
          recentDeltas: recentDeltasRef.current,
          boardTitle: boardTitleRef.current,
        });
        const res = await fetch("/api/jev/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: "morph_notation",
            targetNotation,
            selectedIds: targetIds,
            boardGraph,
            currentSpec: morph.spec,
          }),
        });
        if (!res.ok || controller.signal.aborted) {
          setMorphEvaluating(false);
          return;
        }
        const data = (await res.json()) as {
          source: "llm-json" | "heuristic";
          model: string;
          isHeuristic?: boolean;
          latencyMs: number;
          spec?: unknown;
        };
        if (controller.signal.aborted) return;

        if (data.source === "llm-json" && data.isHeuristic !== true && data.spec) {
          const validated = validateMorphSemanticSpec(data.spec);
          if (validated.ok) {
            const refined = morphSelectionToNotation(
              morph.nextSelectedIds,
              morphedBoard,
              targetNotation,
              {
                specOverride: validated.spec,
                isHeuristic: false,
              }
            );
            if (refined) {
              const refinedBoard = updateElements(
                (prev) => applyMorphToBoard(prev, refined),
                { recordUndo: false }
              );
              setSelectedIds(refined.nextSelectedIds);
              setInspectorOpen(refined.nextSelectedIds.length === 1);
              setMorphIsHeuristic(false);
              ensureElementsVisible(refinedBoard, {
                top: 128,
                right: 64,
                bottom: 132,
                left: 64,
              });
              setTelemetry({
                source: "llm-json",
                model: data.model,
                isHeuristic: false,
                latencyMs: data.latencyMs,
                evaluating: false,
              });
              announceStatus(
                `Refined ${MORPH_NOTATION_LABELS[targetNotation]} notation with AI`
              );
            }
          }
        }
      } catch {
        // Keep deterministic local morph cleanly
      } finally {
        if (!controller.signal.aborted) {
          setMorphEvaluating(false);
        }
      }
    },
    [selectedIds, updateElements, pushEditDelta, fitToView, ensureElementsVisible, announceStatus]
  );

  // --- TALK-TO-DRAW: Stroke-Synchronized Voice-to-Sketch ---
  const handleStrokeEvent = useCallback((ev: CanvasStrokeEvent) => {
    if (ev.phase === "start") {
      strokeTimelineRef.current = recordStrokeStart(strokeTimelineRef.current, {
        strokeId: ev.strokeId,
        elementId: ev.elementId,
        kind: ev.kind,
        startPoint: ev.startPoint,
        endPoint: ev.endPoint,
        fromId: ev.fromId,
        toId: ev.toId,
        label: ev.label,
        startedAt: ev.timestamp,
      });
    } else if (ev.phase === "move") {
      strokeTimelineRef.current = recordStrokeMove(
        strokeTimelineRef.current,
        ev.strokeId,
        ev.endPoint
      );
    } else {
      strokeTimelineRef.current = recordStrokeEnd(
        strokeTimelineRef.current,
        ev.strokeId,
        {
          elementId: ev.elementId,
          endPoint: ev.endPoint,
          endedAt: ev.timestamp,
          label: ev.label,
          fromId: ev.fromId,
          toId: ev.toId,
        }
      );
    }
    const latest =
      strokeTimelineRef.current[strokeTimelineRef.current.length - 1] ?? null;
    setLatestStroke(latest);
  }, []);

  const handleTalkUtterance = useCallback(
    async (utterance: string, spokenAt: number) => {
      const cleaned = utterance.trim();
      if (!cleaned) return;
      setLastTalkTranscript(cleaned);

      const currentEls = elementsRef.current;
      let correlated = correlateUtteranceToStroke(
        strokeTimelineRef.current,
        spokenAt
      );

      // If no recent stroke within window, fall back gracefully to the selected element if present
      if (!correlated && selectedIds.length > 0) {
        const sel = currentEls.find((e) => e.id === selectedIds[0]);
        if (sel) {
          correlated = {
            strokeId: `sel_${sel.id}`,
            elementId: sel.id,
            kind: sel.kind,
            startPoint:
              sel.kind === "arrow" && sel.fromPoint
                ? sel.fromPoint
                : { x: sel.x, y: sel.y },
            endPoint:
              sel.kind === "arrow" && sel.toPoint
                ? sel.toPoint
                : { x: sel.x + sel.width, y: sel.y + sel.height },
            startedAt: spokenAt - 500,
            endedAt: spokenAt - 100,
            inProgress: false,
            label: sel.label,
            fromId: sel.fromId,
            toId: sel.toId,
          };
        }
      }

      const localPred = buildTalkToDrawPrediction({
        utterance: cleaned,
        activeStroke: correlated,
        elements: currentEls,
        selectedIds,
        viewportCenter: viewportCenterWorld,
        now: spokenAt,
      });

      if (!localPred) return;

      forkAbortRef.current?.abort();
      setForkSession(null);
      setPredictions([localPred.action]);
      setActivePredIdx(0);
      setIntent({
        kind: "domain_continue",
        headline: `Talk-to-Draw: "${cleaned.slice(0, 48)}"`,
        detail: localPred.action.subtitle,
        subjectId: localPred.correlatedStroke?.elementId,
        relatedIds: localPred.action.addElements.map((e) => e.id).slice(0, 4),
        timestamp: spokenAt,
      });
      setTalkIsHeuristic(true);
      announceStatus(`Talk-to-Draw preview ready: ${localPred.action.title}`);
      setTelemetry({
        source: "heuristic",
        model: "heuristic",
        isHeuristic: true,
        latencyMs: 0,
        evaluating: false,
      });

      talkAbortRef.current?.abort();
      const controller = new AbortController();
      talkAbortRef.current = controller;
      setTalkEvaluating(true);

      try {
        const boardGraph = serializeBoardToGraph(currentEls, {
          selectedIds,
          recentDeltas: recentDeltasRef.current,
          boardTitle: boardTitleRef.current,
        });
        const res = await fetch("/api/jev/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: "talk_to_draw",
            utterance: cleaned,
            activeStroke: correlated
              ? {
                  ...(correlated.elementId
                    ? { elementId: correlated.elementId }
                    : {}),
                  kind: correlated.kind,
                  startPoint: correlated.startPoint,
                  endPoint: correlated.endPoint,
                  ...(correlated.label ? { label: correlated.label } : {}),
                }
              : null,
            boardGraph,
          }),
        });
        if (!res.ok || controller.signal.aborted) {
          setTalkEvaluating(false);
          return;
        }
        const data = (await res.json()) as {
          source: "llm-json" | "heuristic";
          model: string;
          isHeuristic?: boolean;
          latencyMs: number;
          result?: unknown;
        };
        if (controller.signal.aborted) return;

        if (data.source === "llm-json" && data.isHeuristic !== true && data.result) {
          const validated = validateTalkToDrawLlmResult(data.result);
          if (validated.ok) {
            const refined = buildTalkToDrawPrediction({
              utterance: cleaned,
              activeStroke: correlated,
              elements: elementsRef.current,
              selectedIds,
              viewportCenter: viewportCenterWorld,
              llmOverride: validated.result,
              now: spokenAt,
            });
            if (refined) {
              setPredictions([refined.action]);
              setActivePredIdx(0);
              setTalkIsHeuristic(false);
              setTelemetry({
                source: "llm-json",
                model: data.model,
                isHeuristic: false,
                latencyMs: data.latencyMs,
                evaluating: false,
              });
            }
          }
        }
      } catch {
        // Keep deterministic local Talk-to-Draw ghost cleanly
      } finally {
        if (!controller.signal.aborted) {
          setTalkEvaluating(false);
        }
      }
    },
    [selectedIds, viewportCenterWorld, announceStatus]
  );

  const handleUndo = useCallback(() => {
    const history = getHistory();
    const prev = elementsRef.current;
    const target = history.undo();
    if (!target) return;

    const peerId = collabRef.current?.peerId ?? "local";
    const now = Date.now();
    const stamped = applyLocalElementsChange(
      prev,
      target,
      tombstonesRef.current,
      peerId,
      now,
      tombstoneHorizonRevRef.current,
      {
        ttlMs: TOMBSTONE_TTL_MS,
        prevHorizonAt: tombstoneHorizonAtRef.current,
      }
    );
    history.replaceWithoutHistory(stamped.elements);
    elementsRef.current = stamped.elements;
    tombstonesRef.current = stamped.tombstones;
    tombstoneHorizonRevRef.current = stamped.tombstoneHorizonRev;
    tombstoneHorizonAtRef.current = stamped.tombstoneHorizonAt;
    if ((collabRef.current?.getConnectedPeerCount() ?? 0) > 0) {
      baseTimestampRef.current = now;
    }
    hasLocalEditsRef.current = true;
    canPersistRef.current = true;
    remoteGuardRef.current?.markLocalChange(now);

    setElements(stamped.elements);
    forkAbortRef.current?.abort();
    setForkSession(null);
    setHistoryCounts({ undo: history.undoCount, redo: history.redoCount });
    broadcastThrottlerRef.current?.flushNow({
      elements: stamped.elements,
      boardTitle: boardTitleRef.current,
      titleRev: titleRevRef.current,
      titleUpdatedBy: titleUpdatedByRef.current || peerId,
      tombstones: stamped.tombstones,
      tombstoneHorizonRev: stamped.tombstoneHorizonRev,
      tombstoneHorizonAt: stamped.tombstoneHorizonAt,
      boardEpoch: boardEpochRef.current,
      boardEpochCreatedAt: boardEpochCreatedAtRef.current,
      baseRev: computeMaxKnownRev({
        elements: stamped.elements,
        tombstones: stamped.tombstones,
        titleRev: titleRevRef.current,
        tombstoneHorizonRev: stamped.tombstoneHorizonRev,
      }),
      baseTimestamp: baseTimestampRef.current,
      hasLocalEdits: true,
    });
  }, [getHistory]);

  const handleRedo = useCallback(() => {
    const history = getHistory();
    const prev = elementsRef.current;
    const target = history.redo();
    if (!target) return;

    const peerId = collabRef.current?.peerId ?? "local";
    const now = Date.now();
    const stamped = applyLocalElementsChange(
      prev,
      target,
      tombstonesRef.current,
      peerId,
      now,
      tombstoneHorizonRevRef.current,
      {
        ttlMs: TOMBSTONE_TTL_MS,
        prevHorizonAt: tombstoneHorizonAtRef.current,
      }
    );
    history.replaceWithoutHistory(stamped.elements);
    elementsRef.current = stamped.elements;
    tombstonesRef.current = stamped.tombstones;
    tombstoneHorizonRevRef.current = stamped.tombstoneHorizonRev;
    tombstoneHorizonAtRef.current = stamped.tombstoneHorizonAt;
    if ((collabRef.current?.getConnectedPeerCount() ?? 0) > 0) {
      baseTimestampRef.current = now;
    }
    hasLocalEditsRef.current = true;
    canPersistRef.current = true;
    remoteGuardRef.current?.markLocalChange(now);

    setElements(stamped.elements);
    forkAbortRef.current?.abort();
    setForkSession(null);
    setHistoryCounts({ undo: history.undoCount, redo: history.redoCount });
    broadcastThrottlerRef.current?.flushNow({
      elements: stamped.elements,
      boardTitle: boardTitleRef.current,
      titleRev: titleRevRef.current,
      titleUpdatedBy: titleUpdatedByRef.current || peerId,
      tombstones: stamped.tombstones,
      tombstoneHorizonRev: stamped.tombstoneHorizonRev,
      tombstoneHorizonAt: stamped.tombstoneHorizonAt,
      boardEpoch: boardEpochRef.current,
      boardEpochCreatedAt: boardEpochCreatedAtRef.current,
      baseRev: computeMaxKnownRev({
        elements: stamped.elements,
        tombstones: stamped.tombstones,
        titleRev: titleRevRef.current,
        tombstoneHorizonRev: stamped.tombstoneHorizonRev,
      }),
      baseTimestamp: baseTimestampRef.current,
      hasLocalEdits: true,
    });
  }, [getHistory]);

  const applyRestoredSnapshot = useCallback(
    (snapshot: StoredBoardSnapshot, forceBumpRevs = false) => {
      const peerId = collabRef.current?.peerId ?? "local";
      const now = Date.now();
      const prev = elementsRef.current;
      const stamped = applyLocalElementsChange(
        prev,
        snapshot.elements,
        tombstonesRef.current,
        peerId,
        now,
        tombstoneHorizonRevRef.current,
        {
          ttlMs: TOMBSTONE_TTL_MS,
          prevHorizonAt: tombstoneHorizonAtRef.current,
        }
      );

      // When reverting a quarantined incident, bump element revs so rebroadcast overrides any peer-side vandalism
      const restoredElements = forceBumpRevs
        ? stamped.elements.map((el) => ({
            ...el,
            rev: Math.max((el.rev ?? 0) + 1, tombstoneHorizonRevRef.current + 1),
            updatedAt: Math.max(now, (el.updatedAt ?? 0) + 1),
            updatedBy: peerId,
          }))
        : stamped.elements;

      const restoredTitle =
        snapshot.boardTitle !== undefined
          ? snapshot.boardTitle
          : boardTitleRef.current;
      if (forceBumpRevs || restoredTitle !== boardTitleRef.current) {
        titleRevRef.current =
          Math.max(titleRevRef.current, snapshot.titleRev ?? 0) + 1;
        titleUpdatedByRef.current = peerId;
      }

      const history = getHistory();
      history.commitLocal(restoredElements, { recordUndo: true });
      elementsRef.current = restoredElements;
      boardTitleRef.current = restoredTitle;
      tombstonesRef.current = stamped.tombstones;
      tombstoneHorizonRevRef.current = stamped.tombstoneHorizonRev;
      tombstoneHorizonAtRef.current = stamped.tombstoneHorizonAt;
      baseTimestampRef.current = now;
      hasLocalEditsRef.current = true;
      canPersistRef.current = true;
      remoteGuardRef.current?.resetAfterRestore(now);

      setElements(restoredElements);
      setBoardTitle(restoredTitle);
      forkAbortRef.current?.abort();
      setForkSession(null);
      setSelectedIds([]);
      setInspectorOpen(false);
      setHistoryCounts({ undo: history.undoCount, redo: history.redoCount });
      setRecoveryToast(null);

      broadcastThrottlerRef.current?.flushNow({
        elements: restoredElements,
        boardTitle: restoredTitle,
        titleRev: titleRevRef.current,
        titleUpdatedBy: titleUpdatedByRef.current || peerId,
        tombstones: stamped.tombstones,
        tombstoneHorizonRev: stamped.tombstoneHorizonRev,
        tombstoneHorizonAt: stamped.tombstoneHorizonAt,
        boardEpoch: boardEpochRef.current,
        boardEpochCreatedAt: boardEpochCreatedAtRef.current,
        baseRev: computeMaxKnownRev({
          elements: restoredElements,
          tombstones: stamped.tombstones,
          titleRev: titleRevRef.current,
          tombstoneHorizonRev: stamped.tombstoneHorizonRev,
        }),
        baseTimestamp: baseTimestampRef.current,
        hasLocalEdits: true,
      });
    },
    [getHistory]
  );

  const handleRestorePreviousBoard = useCallback(() => {
    const storage =
      typeof window !== "undefined" ? window.localStorage : null;
    const popped = popRecoverySnapshot(storage, roomId);
    const entry = popped.entry ?? recoveryToast?.entry ?? null;
    if (!entry) {
      setRecoveryToast(null);
      return;
    }
    applyRestoredSnapshot(entry.snapshot, false);
    announceStatus("Restored previous board snapshot");
  }, [applyRestoredSnapshot, recoveryToast, roomId, announceStatus]);

  const handleKeepPeerChanges = useCallback(
    (peerId: string) => {
      const guard = remoteGuardRef.current;
      const collab = collabRef.current;
      if (!guard) return;
      const now = Date.now();
      const resolution = guard.resolvePeerIncident(peerId, "keep", now);
      setPeerIncidents(guard.getActiveIncidents());
      if (!resolution || resolution.action !== "keep") return;

      let current: BoardSyncState = {
        elements: elementsRef.current,
        boardTitle: boardTitleRef.current,
        titleRev: titleRevRef.current,
        titleUpdatedBy: titleUpdatedByRef.current || collab?.peerId || "local",
        tombstones: tombstonesRef.current,
        tombstoneHorizonRev: tombstoneHorizonRevRef.current,
        tombstoneHorizonAt: tombstoneHorizonAtRef.current,
        boardEpoch: boardEpochRef.current,
        boardEpochCreatedAt: boardEpochCreatedAtRef.current,
        baseRev: computeMaxKnownRev({
          elements: elementsRef.current,
          tombstones: tombstonesRef.current,
          titleRev: titleRevRef.current,
          tombstoneHorizonRev: tombstoneHorizonRevRef.current,
        }),
        baseTimestamp: baseTimestampRef.current,
        hasLocalEdits: hasLocalEditsRef.current,
      };

      let anyChanged = false;
      for (const entry of resolution.entriesToApply) {
        const merged = mergeRemoteBoardState(
          current,
          entry.payload,
          collab?.peerId ?? "local",
          {
            authoritativePeerId: entry.authoritativePeerId,
            now,
            tombstoneTtlMs: TOMBSTONE_TTL_MS,
          }
        );
        if (merged.changed || merged.adoptedAuthoritative) {
          current = merged.state;
          anyChanged = true;
        }
      }

      if (anyChanged) {
        elementsRef.current = current.elements;
        boardTitleRef.current = current.boardTitle;
        titleRevRef.current = current.titleRev ?? 0;
        titleUpdatedByRef.current = current.titleUpdatedBy ?? "";
        tombstonesRef.current = current.tombstones;
        tombstoneHorizonRevRef.current = current.tombstoneHorizonRev ?? 0;
        tombstoneHorizonAtRef.current = current.tombstoneHorizonAt ?? 0;
        if (current.boardEpoch) boardEpochRef.current = current.boardEpoch;
        if (current.boardEpochCreatedAt !== undefined) {
          boardEpochCreatedAtRef.current = current.boardEpochCreatedAt;
        }
        baseTimestampRef.current = current.baseTimestamp ?? now;
        hasLocalEditsRef.current = current.hasLocalEdits;
        canPersistRef.current = true;

        const history = getHistory();
        history.applyRemote(current.elements, { clearHistory: true });
        remoteSyncGenerationRef.current = history.remoteSyncGeneration;
        setHistoryCounts({ undo: 0, redo: 0 });
        setElements(current.elements);
        setBoardTitle(current.boardTitle);
      }
      announceStatus("Kept peer board changes");
    },
    [getHistory, announceStatus]
  );

  const handleRevertPeerChanges = useCallback(
    (peerId: string) => {
      const guard = remoteGuardRef.current;
      if (!guard) return;
      const now = Date.now();
      const resolution = guard.resolvePeerIncident(peerId, "revert", now);
      setPeerIncidents(guard.getActiveIncidents());
      if (!resolution || resolution.action !== "revert") return;
      applyRestoredSnapshot(resolution.restoreSnapshot, true);
      announceStatus("Reverted peer board changes");
    },
    [applyRestoredSnapshot, announceStatus]
  );

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
      pushEditDelta({
        op: "delete",
        elementIds: ids.slice(0, 8),
        summary: `Deleted ${ids.length} element${ids.length === 1 ? "" : "s"}`,
      });
      setSelectedIds((curr) => curr.filter((id) => !delSet.has(id)));
      setPredictions([]);
      setForkSession(null);
    },
    [updateElements, pushEditDelta]
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

      // Active FORK IT session shortcuts (Tab / Shift+Tab, 1/2/3, Enter, Esc)
      if (forkSession) {
        if (e.key === "Tab") {
          e.preventDefault();
          setForkSession((prev) => {
            if (!prev || prev.takes.length === 0) return prev;
            const len = prev.takes.length;
            const nextIdx = e.shiftKey
              ? (prev.activeIndex - 1 + len) % len
              : (prev.activeIndex + 1) % len;
            return { ...prev, activeIndex: nextIdx };
          });
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          applyForkTake(forkSession.activeIndex);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancelForkSession();
          return;
        }
        if (
          (e.key === "1" || e.key === "2" || e.key === "3") &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          const idx = Number(e.key) - 1;
          if (idx < forkSession.takes.length) {
            e.preventDefault();
            if (forkSession.activeIndex === idx) {
              applyForkTake(idx);
            } else {
              setForkSession((prev) =>
                prev ? { ...prev, activeIndex: idx } : null
              );
            }
            return;
          }
        }
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

      // Enter materializes the active ghost prediction, or edits title in place when a single item is selected
      if (e.key === "Enter") {
        if (predictions.length > 0) {
          e.preventDefault();
          applyPrediction(activePredIdx);
          return;
        }
        if (selectedIds.length === 1) {
          e.preventDefault();
          startInlineEditRef.current?.(selectedIds[0]);
          return;
        }
      }

      // F with one or more shapes selected triggers Fork It! (When nothing is selected, F selects Zone Frame tool.)
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f" &&
        selectedIds.length > 0
      ) {
        const selSet = new Set(selectedIds);
        const hasForkable = elementsRef.current.some(
          (el) => selSet.has(el.id) && isShapeElement(el)
        );
        if (hasForkable) {
          e.preventDefault();
          void startForkSelection();
          return;
        }
      }

      // F2 edits selected item's title in place anytime
      if (e.key === "F2" && selectedIds.length === 1) {
        e.preventDefault();
        startInlineEditRef.current?.(selectedIds[0]);
        return;
      }

      // Left / Right arrows (or [ / ]) cycle color tone on selected element(s)
      if (
        selectedIds.length > 0 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "[" ||
          e.key === "]")
      ) {
        e.preventDefault();
        const delta = e.key === "ArrowRight" || e.key === "]" ? 1 : -1;
        const primary = elementsRef.current.find((el) => el.id === selectedIds[0]);
        if (primary) {
          const curIdx = ALL_TONES.indexOf(primary.tone);
          const nextTone =
            ALL_TONES[
              ((curIdx === -1 ? 0 : curIdx) + delta + ALL_TONES.length) %
                ALL_TONES.length
            ];
          const selSet = new Set(selectedIds);
          updateElements((prev) =>
            prev.map((el) =>
              selSet.has(el.id)
                ? { ...el, tone: nextTone, updatedAt: Date.now() }
                : el
            )
          );
        }
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
          dismissPredictions();
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

      // V toggles Talk-to-Draw voice/text sketch mode
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "v"
      ) {
        e.preventDefault();
        setTalkToDrawActive((prev) => {
          const next = !prev;
          announceStatus(
            next ? "Talk-to-Draw enabled" : "Talk-to-Draw closed"
          );
          return next;
        });
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
    forkSession,
    applyForkTake,
    cancelForkSession,
    startForkSelection,
    predictions,
    activePredIdx,
    applyPrediction,
    dismissPredictions,
    selectedIds,
    handleUndo,
    handleRedo,
    handleDuplicateIds,
    handleDeleteIds,
    updateElements,
    announceStatus,
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

  // Export board to standalone pure SVG (no DOM clone, handles, ghosts, or cursors)
  const exportSvg = () => {
    const serialized = exportBoardToSvg(elementsRef.current, {
      theme,
      renderStyle,
      title: boardTitleRef.current,
    });
    const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeExportFilename(boardTitleRef.current, "svg");
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCanvasSelectIds = useCallback((ids: string[]) => {
    thoughtInputRef.current?.blur();
    if (forkSession) {
      forkAbortRef.current?.abort();
      setForkSession(null);
    }
    setSelectedIds(ids);
    setInspectorOpen(ids.length === 1);
  }, [forkSession]);

  const resetToStarter = () => {
    forkAbortRef.current?.abort();
    setForkSession(null);
    const fresh = createStarterElements();
    updateElements(() => fresh);
    setSelectedIds([]);
    setInspectorOpen(false);
    setLastPromptFlow(null);
    lastPromptFlowRef.current = null;
    fitToView(fresh);
    const anchor = fresh.find((e) => e.id === "starter_mesh");
    if (anchor) {
      refreshPredictions(detectCreationIntent(anchor, fresh, false), fresh);
    }
  };

  const clearBoard = () => {
    forkAbortRef.current?.abort();
    setForkSession(null);
    updateElements(() => []);
    setSelectedIds([]);
    setInspectorOpen(false);
    setLastPromptFlow(null);
    lastPromptFlowRef.current = null;
    setPredictions([]);
    setIntent(null);
  };

  const handleStarterCheckout = useCallback(() => {
    setJoiningSharedRoom(false);
    boardTitleRef.current = "Checkout System";
    setBoardTitle("Checkout System");
    void handleSubmitThought(
      "Checkout system with payment gateway, fraud check, and ledger db"
    );
  }, [handleSubmitThought]);

  const handleStarterMorphSequence = useCallback(() => {
    setJoiningSharedRoom(false);
    const flow = createRequestFlowStarterElements();
    boardTitleRef.current = "Checkout Request Flow";
    setBoardTitle("Checkout Request Flow");
    const committed = updateElements(() => flow);
    const shapeIds = committed
      .filter((e) => isShapeElement(e) && e.kind !== "frame")
      .map((e) => e.id);
    setSelectedIds(shapeIds);
    void handleMorphNotation("sequence", shapeIds, committed);
  }, [updateElements, handleMorphNotation]);

  const handleStarterForkArchitecture = useCallback(() => {
    setJoiningSharedRoom(false);
    const arch = createForkArchitectureStarterElements();
    boardTitleRef.current = "Orders Architecture";
    setBoardTitle("Orders Architecture");
    const committed = updateElements(() => arch);
    const forkIds = ["arch_orders_api", "arch_orders_db"].filter((id) =>
      committed.some((e) => e.id === id)
    );
    setSelectedIds(forkIds);
    void startForkSelection(forkIds, committed);
  }, [updateElements, startForkSelection]);

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
    const topScreenY = viewport.y + groupBounds.y * viewport.zoom - 68;
    const barW = Math.min(620, screenSize.width - 24);
    const x = Math.max(
      12,
      Math.min(screenSize.width - 12 - barW, Math.round(centerScreenX - barW / 2))
    );
    const minTop = screenSize.width < 640 ? 118 : 76;
    const y = Math.max(
      minTop,
      Math.min(screenSize.height - 230, Math.round(topScreenY))
    );
    return { x, y };
  }, [selectedIds, elements, viewport, screenSize]);

  const activeForkGhost = useMemo<PredictedAction | null>(() => {
    if (!forkSession) return null;
    const take = forkSession.takes[forkSession.activeIndex];
    if (!take) return null;
    return {
      id: take.id,
      title: take.title,
      subtitle: take.rationale,
      category: "structure",
      addElements: take.previewElements,
      removeIds: forkSession.replacedIds,
      focusId: take.exitElementId,
    };
  }, [forkSession]);

  const activePrediction = activeForkGhost ?? predictions[activePredIdx] ?? null;

  // Smoothly auto-fit viewport whenever the active Fork It take changes (e.g. Tab / click / LLM upgrade)
  const activeForkTakeId = forkSession?.takes[forkSession.activeIndex]?.id ?? null;
  const activeForkAnnouncement =
    forkSession && forkSession.takes[forkSession.activeIndex]
      ? `Fork take ${forkSession.activeIndex + 1} of ${forkSession.takes.length}: ${forkSession.takes[forkSession.activeIndex].title}`
      : "";

  useEffect(() => {
    if (!forkSession || !activeForkTakeId) return;
    const take = forkSession.takes[forkSession.activeIndex];
    if (!take) return;
    const rafId = window.requestAnimationFrame(() => {
      fitToView(
        [
          ...forkSession.subgraph.selectedShapes,
          ...forkSession.subgraph.selectedFrames,
          ...take.previewElements,
        ],
        { top: 100, right: 64, bottom: 300, left: 64 }
      );
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeForkTakeId, forkSession, fitToView]);

  // Keep Tab ghost suggestions and Talk-to-Draw ghosts cleanly inside the visible safe viewport
  const activeNonForkPredId = !forkSession
    ? predictions[activePredIdx]?.id ?? null
    : null;
  useEffect(() => {
    if (!activeNonForkPredId || forkSession) return;
    const pred = predictions[activePredIdx];
    if (!pred || pred.addElements.length === 0) return;

    const contextEls: JevElement[] = [...pred.addElements];
    if (intent?.subjectId) {
      const subj = elementsRef.current.find((e) => e.id === intent.subjectId);
      if (subj) contextEls.push(subj);
    }
    for (const p of pred.patchElements ?? []) {
      const target = elementsRef.current.find((e) => e.id === p.id);
      if (target) {
        contextEls.push(target);
        if (target.fromId) {
          const fromEl = elementsRef.current.find((e) => e.id === target.fromId);
          if (fromEl) contextEls.push(fromEl);
        }
      }
    }

    const rafId = window.requestAnimationFrame(() => {
      ensureElementsVisible(contextEls, {
        top: 100,
        right: 64,
        bottom: talkToDrawActive ? 340 : 255,
        left: 64,
      });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [
    activeNonForkPredId,
    activePredIdx,
    predictions,
    forkSession,
    intent?.subjectId,
    talkToDrawActive,
    ensureElementsVisible,
  ]);

  const showFirstRunEmptyState =
    boardReady &&
    elements.length === 0 &&
    !joiningSharedRoom &&
    !thoughtPrompt.trim() &&
    !forkSession &&
    !talkToDrawActive;

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      {/* Screen-reader live status regions for Fork, Morph, Talk-to-Draw & recovery feedback */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {activeForkAnnouncement}
      </div>

      {/* FULL-BLEED INFINITE CANVAS */}
      <JevCanvas
        svgRef={svgRef}
        startEditRef={startInlineEditRef}
        remoteSyncGenerationRef={remoteSyncGenerationRef}
        elements={elements}
        selectedIds={selectedIds}
        tool={tool}
        theme={theme}
        renderStyle={renderStyle}
        viewport={viewport}
        activePrediction={activePrediction}
        promptPreviewElements={promptPreview.elements}
        peers={allPeers}
        forkActive={Boolean(forkSession)}
        talkToDrawActive={talkToDrawActive}
        onStrokeEvent={handleStrokeEvent}
        onViewportChange={setViewport}
        onSelectIds={handleCanvasSelectIds}
        onToolChange={setTool}
        onElementsChange={updateElements}
        onElementMoved={handleElementMoved}
        onElementCreated={handleElementCreated}
        onElementLabelEdited={handleElementLabelEdited}
        onCursorMove={handleCursorMove}
        onInteractingChange={(active) => {
          if (active) thoughtInputRef.current?.blur();
          setCanvasInteracting(active);
        }}
      />

      {/* FIRST-RUN 30-SECOND WOW EMPTY STATE (brand-new local boards only) */}
      {showFirstRunEmptyState && (
        <FirstRunEmptyState
          onDrawCheckout={handleStarterCheckout}
          onMorphSequence={handleStarterMorphSequence}
          onForkArchitecture={handleStarterForkArchitecture}
        />
      )}

      {/* TOP FLOATING STUDIO BAR */}
      <header className="pointer-events-none fixed inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-2 p-3 sm:flex-nowrap sm:items-start sm:p-4">
        {/* Left: Jev Wordmark & Board Menu */}
        <div className="jev-glass pointer-events-auto order-1 flex max-w-[calc(100vw-24px)] shrink-0 items-center gap-2 rounded-2xl px-3 py-1.5 shadow-sm">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Board menu"
              className="flex min-h-[36px] items-center gap-2 rounded-xl pr-1.5 text-left outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-[#D94E28] text-white shadow-xs">
                <PenTool className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="font-editorial text-[21px] font-semibold leading-none tracking-[-0.02em] text-foreground">
                Jev
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 rounded-xl">
              <DropdownMenuItem onClick={exportSvg} className="gap-2 text-xs">
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Export Diagram (.svg)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => fitToView()}
                className="gap-2 text-xs"
              >
                <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                Zoom to Fit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={resetToStarter}
                className="gap-2 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Load Starter Canvas
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={clearBoard}
                className="gap-2 text-xs text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Blank Sheet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />

          <input
            value={boardTitle}
            onChange={(e) => {
              const nextTitle = e.target.value;
              const peerId = collabRef.current?.peerId ?? "local";
              boardTitleRef.current = nextTitle;
              titleRevRef.current += 1;
              titleUpdatedByRef.current = peerId;
              hasLocalEditsRef.current = true;
              canPersistRef.current = true;
              remoteGuardRef.current?.markLocalChange(Date.now());
              setBoardTitle(nextTitle);
              broadcastThrottlerRef.current?.schedule({
                elements: elementsRef.current,
                boardTitle: nextTitle,
                titleRev: titleRevRef.current,
                titleUpdatedBy: peerId,
                tombstones: tombstonesRef.current,
                tombstoneHorizonRev: tombstoneHorizonRevRef.current,
                tombstoneHorizonAt: tombstoneHorizonAtRef.current,
                boardEpoch: boardEpochRef.current,
                boardEpochCreatedAt: boardEpochCreatedAtRef.current,
                baseRev: computeMaxKnownRev({
                  elements: elementsRef.current,
                  tombstones: tombstonesRef.current,
                  titleRev: titleRevRef.current,
                  tombstoneHorizonRev: tombstoneHorizonRevRef.current,
                }),
                baseTimestamp: baseTimestampRef.current,
                hasLocalEdits: true,
              });
            }}
            aria-label="Board title"
            className="hidden w-32 rounded-md bg-transparent px-1 py-0.5 text-xs font-semibold text-foreground/90 outline-none focus:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:block"
          />

          <div className="hidden items-center gap-0.5 border-l border-border pl-1.5 lg:flex">
            <button
              type="button"
              onClick={handleUndo}
              disabled={historyCounts.undo === 0}
              aria-label="Undo"
              title="Undo (⌘Z)"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={historyCounts.redo === 0}
              aria-label="Redo"
              title="Redo (⌘⇧Z)"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
            >
              <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Center: Tactile Drafting Tool Dock (scrolls cleanly on 390px mobile) */}
        <nav
          aria-label="Drawing tools"
          className="jev-glass pointer-events-auto order-3 mx-auto flex max-w-[calc(100vw-24px)] items-center gap-0.5 overflow-x-auto rounded-2xl p-1 shadow-sm sm:order-2 sm:mx-0 sm:max-w-[calc(100vw-420px)] lg:max-w-[calc(100vw-480px)]"
        >
          {TOOLS.map((t) => {
            const active = tool === t.id;
            return (
              <Tooltip key={t.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${t.label} tool (${t.key})`}
                      aria-pressed={active}
                      onClick={() => setTool(t.id)}
                      onDoubleClick={() => spawnShapeAtCenter(t.id)}
                      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8 ${
                        active
                          ? "bg-[#1C2028] text-[#F8F6F1] shadow-xs dark:bg-[#F1EDE4] dark:text-[#11151D]"
                          : "text-foreground/80 hover:bg-secondary hover:text-foreground"
                      }`}
                    />
                  }
                >
                  <span aria-hidden="true">{t.icon}</span>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0.5 right-1 font-mono text-[8.5px] opacity-75"
                  >
                    {t.key}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t.label} <span className="ml-1 font-mono opacity-75">{t.key}</span>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* Right: Talk-to-Draw, Render Style, Theme & WebRTC P2P */}
        <div className="jev-glass pointer-events-auto order-2 flex max-w-[calc(100vw-24px)] shrink-0 items-center gap-1 rounded-2xl p-1.5 shadow-sm sm:order-3">
          {/* Stroke-Synchronized Talk-to-Draw toggle */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => {
                    setTalkToDrawActive((v) => {
                      const next = !v;
                      announceStatus(
                        next ? "Talk-to-Draw enabled" : "Talk-to-Draw closed"
                      );
                      return next;
                    });
                  }}
                  aria-label={
                    talkToDrawActive
                      ? "Disable Talk-to-Draw (V)"
                      : "Enable Talk-to-Draw (V)"
                  }
                  aria-pressed={talkToDrawActive}
                  className={`inline-flex min-h-[36px] min-w-[36px] items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 text-[11.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0 sm:px-2.5 ${
                    talkToDrawActive
                      ? "bg-[#2563EB] text-white shadow-xs dark:bg-[#38BDF8] dark:text-[#0F172A]"
                      : "text-foreground/85 hover:bg-secondary"
                  }`}
                />
              }
            >
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden md:inline">Talk</span>
              <kbd className="hidden rounded border border-current/25 px-1 font-mono text-[9px] opacity-80 sm:inline">
                V
              </kbd>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Talk-to-Draw: speak or type while drawing arrows & shapes (V)
            </TooltipContent>
          </Tooltip>

          {/* Sketch vs Clean drafting style */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={renderStyle === "sketch"}
                  aria-label={`Drafting style: ${renderStyle === "sketch" ? "Sketch" : "Clean"}. Switch to ${renderStyle === "sketch" ? "Clean" : "Sketch"}`}
                  onClick={() =>
                    setRenderStyle((s) => (s === "sketch" ? "clean" : "sketch"))
                  }
                  className="hidden items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
                />
              }
            >
              <Sparkles className="h-3.5 w-3.5 text-[#C2411D] dark:text-[#FF8562]" aria-hidden="true" />
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
                  aria-label={
                    theme === "vellum"
                      ? "Switch to Midnight Blueprint dark theme"
                      : "Switch to Studio Vellum light theme"
                  }
                  aria-pressed={theme === "midnight"}
                  onClick={() =>
                    setTheme((t) => (t === "vellum" ? "midnight" : "vellum"))
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
                />
              }
            >
              {theme === "vellum" ? (
                <Moon className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Sun className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Switch to {theme === "vellum" ? "Midnight Blueprint" : "Studio Vellum"}
            </TooltipContent>
          </Tooltip>

          {/* Live WebRTC P2P Button */}
          <button
            type="button"
            aria-label={
              allPeers.length > 0
                ? `Peer-to-peer sharing, ${allPeers.length + 1} peers active`
                : "Open Peer-to-Peer sharing dialog"
            }
            onClick={() => setShareOpen(true)}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[#0F766E] px-2.5 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[#0D655E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card sm:min-h-0 sm:px-3"
          >
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-200" />
            </span>
            <Radio className="hidden h-3.5 w-3.5 sm:block" aria-hidden="true" />
            <span className="sm:hidden">
              {allPeers.length > 0 ? `${allPeers.length + 1}` : "P2P"}
            </span>
            <span className="hidden sm:inline">
              {allPeers.length > 0 ? `P2P · ${allPeers.length + 1}` : "Share P2P"}
            </span>
          </button>
        </div>
      </header>

      {/* PER-SENDER >50% PAUSED CHANGE GUARD & CUMULATIVE RECOVERY TOASTS */}
      {(peerIncidents.length > 0 || recoveryToast) && (
        <div className="fixed left-1/2 top-[116px] z-40 flex w-[calc(100vw-24px)] max-w-[640px] -translate-x-1/2 flex-col items-center gap-2 sm:top-[72px] sm:w-auto">
          {peerIncidents.map((incident) => (
            <div
              key={incident.peerId}
              role="alert"
              aria-live="assertive"
              className="jev-glass flex w-full flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[#D94E28]/45 px-3.5 py-2 shadow-[0_14px_36px_-12px_rgba(15,23,42,0.32)] sm:w-auto"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#D94E28]/15 text-[#C2411D] dark:text-[#FF8562]">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="text-xs font-semibold text-foreground">
                    {incident.peerName} made large changes
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Paused after {incident.changedCount} of {incident.baselineCount}{" "}
                    {incident.baselineCount === 1 ? "element" : "elements"} changed
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleKeepPeerChanges(incident.peerId)}
                  className="min-h-[36px] shrink-0 rounded-xl border border-border bg-secondary px-3 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2.5"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => handleRevertPeerChanges(incident.peerId)}
                  className="min-h-[36px] shrink-0 rounded-xl bg-[#D94E28] px-3 py-1 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[#C0411E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2.5"
                >
                  Revert
                </button>
              </div>
            </div>
          ))}

          {recoveryToast && (
            <div
              role="status"
              aria-live="polite"
              className="jev-glass flex w-full flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[#D94E28]/30 px-3.5 py-2 shadow-[0_14px_36px_-12px_rgba(15,23,42,0.28)] sm:w-auto sm:flex-nowrap"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#D94E28]/15 text-[#C2411D] dark:text-[#FF8562]">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 text-xs font-medium text-foreground">
                  {recoveryToast.kind === "full_replace"
                    ? `Host replaced the board (${recoveryToast.removedCount} ${recoveryToast.removedCount === 1 ? "element" : "elements"} removed).`
                    : recoveryToast.kind === "bulk_delete"
                      ? `Host removed ${recoveryToast.removedCount} of ${recoveryToast.localCount} elements.`
                      : `Large board update (${recoveryToast.changedCount} of ${recoveryToast.localCount} ${recoveryToast.localCount === 1 ? "element" : "elements"} changed).`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleRestorePreviousBoard}
                  className="min-h-[36px] shrink-0 rounded-xl bg-[#D94E28] px-3 py-1 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[#C0411E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2.5"
                >
                  Restore previous board
                </button>
                <button
                  type="button"
                  onClick={() => setRecoveryToast(null)}
                  aria-label="Dismiss recovery notice"
                  className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* COMPACT, UNOBTRUSIVE FLOATING PILL (colors via ←/→, shape icons, Fork It, in-place rename) */}
      <SelectionInspector
        element={
          inspectorOpen && !thoughtPrompt.trim() && !forkSession
            ? selectedElement
            : null
        }
        allElements={elements}
        ghostElements={
          promptPreview.elements.length > 0
            ? promptPreview.elements
            : activePrediction?.addElements ?? []
        }
        viewport={viewport}
        theme={theme}
        hasPredictionHud={
          Boolean(forkSession) ||
          talkToDrawActive ||
          (!thoughtPrompt.trim() && (Boolean(intent) || predictions.length > 0))
        }
        hiddenWhileInteracting={canvasInteracting}
        activeNotation={selectionMorphState.notation}
        isMorphedGroup={Boolean(selectionMorphState.groupId)}
        morphEvaluating={morphEvaluating}
        morphIsHeuristic={morphIsHeuristic}
        onPatch={handlePatchElement}
        onStartInlineEdit={(id) => startInlineEditRef.current?.(id)}
        onFork={() => void startForkSelection()}
        onMorphNotation={(notation) => void handleMorphNotation(notation)}
        onDuplicate={(id) => handleDuplicateIds([id])}
        onDelete={(id) => handleDeleteIds([id])}
      />

      {/* MULTI-SELECTION FLOATING ACTION BAR */}
      {multiSelectBarPos && !canvasInteracting && !thoughtPrompt.trim() && !forkSession && (
        <div
          role="toolbar"
          aria-label="Multi-selection actions"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            transform: `translate3d(${multiSelectBarPos.x}px, ${multiSelectBarPos.y}px, 0)`,
          }}
          className="jev-glass fixed left-0 top-0 z-30 flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-1.5 rounded-2xl px-2.5 py-1.5 shadow-[0_14px_36px_-12px_rgba(15,23,42,0.26)]"
        >
          <span className="px-1 font-mono text-[11px] font-semibold text-foreground">
            {selectedIds.length} selected
          </span>
          <span className="h-3.5 w-px bg-border" aria-hidden="true" />
          <NotationMorphBar
            activeNotation={selectionMorphState.notation}
            isMorphedGroup={Boolean(selectionMorphState.groupId)}
            evaluating={morphEvaluating}
            isHeuristic={morphIsHeuristic}
            onSelectNotation={(notation) => void handleMorphNotation(notation)}
          />
          <span className="h-3.5 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void startForkSelection()}
            title="Generate 3 architectural takes (F)"
            className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-[#D94E28]/12 px-2.5 py-1 text-[11.5px] font-semibold text-[#C2411D] transition-colors hover:bg-[#D94E28] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-[#FF8562] dark:hover:text-white sm:min-h-0 sm:px-2"
          >
            <GitFork className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Fork it</span>
            <kbd className="ml-0.5 hidden rounded border border-current/25 px-1 font-mono text-[9px] sm:inline">
              F
            </kbd>
          </button>
          <button
            type="button"
            onClick={handleWrapSelectionInFrame}
            className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2"
          >
            <Frame className="h-3.5 w-3.5" aria-hidden="true" />
            Frame
          </button>
          <button
            type="button"
            onClick={() => handleDuplicateIds(selectedIds)}
            className="min-h-[36px] rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2"
          >
            Copy
          </button>
          <button
            type="button"
            aria-label="Delete selected elements"
            onClick={() => handleDeleteIds(selectedIds)}
            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0"
            title="Delete selected"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* BOTTOM FLOATING INTELLIGENCE DOCK: Fork HUD OR PredictionHud stacked cleanly above TalkToDrawBar above ThoughtBar */}
      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-20 flex flex-col items-center gap-2 sm:bottom-4">
        {forkSession ? (
          <ForkHud
            takes={forkSession.takes}
            activeIndex={forkSession.activeIndex}
            source={forkSession.source}
            model={forkSession.model}
            isHeuristic={forkSession.isHeuristic}
            latencyMs={forkSession.latencyMs}
            evaluating={forkSession.evaluating}
            selectedCount={forkSession.subgraph.selectedShapes.length}
            onSelectIndex={(idx) =>
              setForkSession((prev) =>
                prev ? { ...prev, activeIndex: idx } : null
              )
            }
            onApply={applyForkTake}
            onCancel={cancelForkSession}
          />
        ) : (
          !thoughtPrompt.trim() && (
            <div className="flex w-full justify-center">
              <PredictionHud
                intent={intent}
                predictions={predictions}
                activeIndex={activePredIdx}
                telemetry={telemetry}
                onHoverIndex={setActivePredIdx}
                onApply={applyPrediction}
                onDismiss={dismissPredictions}
              />
            </div>
          )
        )}

        {talkToDrawActive && !forkSession && (
          <div className="flex w-full justify-center px-3">
            <TalkToDrawBar
              active={talkToDrawActive}
              latestStroke={latestStroke}
              lastTranscript={lastTalkTranscript}
              evaluating={talkEvaluating}
              isHeuristic={talkIsHeuristic}
              hasActiveTalkGhost={Boolean(
                predictions[activePredIdx]?.id.startsWith("ttd_") ||
                  predictions[activePredIdx]?.id.startsWith("talk_")
              )}
              onUtterance={(phrase, ts) => void handleTalkUtterance(phrase, ts)}
              onAcceptGhost={() => applyPrediction(activePredIdx)}
              onDismissGhost={dismissPredictions}
              onClose={() => {
                talkAbortRef.current?.abort();
                setTalkToDrawActive(false);
                announceStatus("Talk-to-Draw closed");
              }}
            />
          </div>
        )}

        <ThoughtBar
          inputRef={thoughtInputRef}
          value={thoughtPrompt}
          previewCount={promptPreview.elements.length}
          placementInfo={livePromptBundle?.badge ?? null}
          hasPredictions={Boolean(forkSession) || predictions.length > 0}
          onChange={(val) => {
            if (forkSession && val.trim()) {
              forkAbortRef.current?.abort();
              setForkSession(null);
            }
            setThoughtPrompt(val);
            setPlacementCycleOffset(0);
          }}
          onSubmit={handleSubmitThought}
          onClear={() => {
            setThoughtPrompt("");
            setPlacementCycleOffset(0);
            setLivePlacementDecision(null);
          }}
          onCyclePlacement={(reverse) =>
            setPlacementCycleOffset((n) => (reverse ? n - 1 : n + 1))
          }
          onEmptyTab={(reverse) => {
            if (forkSession) {
              setForkSession((prev) => {
                if (!prev || prev.takes.length === 0) return prev;
                const len = prev.takes.length;
                return {
                  ...prev,
                  activeIndex: reverse
                    ? (prev.activeIndex - 1 + len) % len
                    : (prev.activeIndex + 1) % len,
                };
              });
              return;
            }
            setActivePredIdx((idx) =>
              predictions.length === 0
                ? 0
                : reverse
                  ? (idx - 1 + predictions.length) % predictions.length
                  : (idx + 1) % predictions.length
            );
          }}
          onEmptyEnter={() => {
            if (forkSession) {
              applyForkTake(forkSession.activeIndex);
              return;
            }
            if (predictions.length > 0) applyPrediction(activePredIdx);
          }}
          onEmptyUndo={handleUndo}
          onEmptyRedo={handleRedo}
        />
      </div>

      {/* BOTTOM-RIGHT ZOOM & FIT PILL */}
      <div
        role="group"
        aria-label="Canvas zoom controls"
        className="jev-glass fixed bottom-4 right-4 z-20 hidden items-center gap-1 rounded-xl p-1 shadow-sm lg:flex"
      >
        <button
          type="button"
          onClick={() =>
            setViewport((v) => ({ ...v, zoom: Math.max(0.3, v.zoom * 0.88) }))
          }
          aria-label="Zoom out"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => fitToView()}
          aria-label={`Zoom ${Math.round(viewport.zoom * 100)} percent. Fit diagram to viewport`}
          title="Fit diagram to viewport"
          className="min-w-[48px] rounded-lg px-1.5 py-1 font-mono text-[11px] font-medium text-foreground/85 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() =>
            setViewport((v) => ({ ...v, zoom: Math.min(2.5, v.zoom * 1.14) }))
          }
          aria-label="Zoom in"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* PEER-TO-PEER WEBRTC COLLABORATION MODAL */}
      <ShareP2PDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        roomId={roomId}
        roomSecret={roomSecret}
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
