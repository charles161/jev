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
import {
  exportBoardToSvg,
  sanitizeExportFilename,
} from "@/lib/jev/svg-export";
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
import { parseStoredBoardSnapshot } from "@/lib/jev/sync-validation";
import {
  formatRoomHash,
  generateRoomCredentials,
  parseRoomHash,
  RoomCredentials,
} from "@/lib/jev/room-auth";
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
  localCount: number;
  kind: "full_replace" | "bulk_delete";
  savedSnapshotsCount: number;
}

export function JevWorkspace() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const startInlineEditRef = useRef<((id: string) => void) | null>(null);
  const thoughtInputRef = useRef<HTMLInputElement | null>(null);
  const collabRef = useRef<JevP2PCollab | null>(null);
  const lastCursorSentRef = useRef<number>(0);

  const [roomId, setRoomId] = useState("");
  const [roomSecret, setRoomSecret] = useState("");
  const [boardTitle, setBoardTitle] = useState("System Sketch");
  const [elements, setElements] = useState<JevElement[]>(() =>
    createStarterElements()
  );
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
  const [recoveryToast, setRecoveryToast] = useState<RecoveryToastState | null>(
    null
  );

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
          source: "typesafe-jev" | "heuristic";
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
            : pool.map((action) => ({ ...action, probability: undefined }))
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
    const collab: JevP2PCollab = new JevP2PCollab(
      rid,
      rsecret,
      myName,
      {
        onPeersChange: (list) => setRemotePeers(list),
        onRemoteState: (remoteEls, remoteTitle, meta) => {
          const now = Date.now();
          const localSync = {
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
          const merged = mergeRemoteBoardState(
            localSync,
            {
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
            collab.peerId,
            {
              authoritativePeerId: meta?.authoritativePeerId,
              now,
              tombstoneTtlMs: TOMBSTONE_TTL_MS,
            }
          );

          if (merged.needsFullResync) {
            if (meta?.authoritativePeerId === collab.peerId) {
              collab.sendFullResync(meta?.verifiedSenderPeerId ?? meta?.senderPeerId);
            } else {
              collab.requestFullResync(meta?.authoritativePeerId ?? undefined);
            }
            return;
          }

          if (!merged.changed && !merged.adoptedAuthoritative) {
            return;
          }

          if (merged.destructiveChange) {
            const recoveryEntry: BoardRecoveryEntry = {
              id: uid("rec"),
              savedAt: now,
              reason:
                merged.destructiveChange.kind === "full_replace"
                  ? "authoritative_replace"
                  : "authoritative_bulk_delete",
              removedCount: merged.destructiveChange.removedCount,
              previousElementCount: merged.destructiveChange.localCount,
              snapshot: {
                elements: localSync.elements,
                boardTitle: localSync.boardTitle,
                titleRev: localSync.titleRev,
                titleUpdatedBy: localSync.titleUpdatedBy || undefined,
                tombstones: localSync.tombstones,
                tombstoneHorizonRev: localSync.tombstoneHorizonRev,
                tombstoneHorizonAt: localSync.tombstoneHorizonAt,
                boardEpoch: localSync.boardEpoch,
                boardEpochCreatedAt: localSync.boardEpochCreatedAt,
                baseTimestamp: localSync.baseTimestamp,
                hasLocalEdits: localSync.hasLocalEdits,
              },
            };
            const savedList = pushRecoverySnapshot(
              typeof window !== "undefined" ? window.localStorage : null,
              rid,
              recoveryEntry
            );
            setRecoveryToast({
              entry: recoveryEntry,
              removedCount: merged.destructiveChange.removedCount,
              localCount: merged.destructiveChange.localCount,
              kind: merged.destructiveChange.kind,
              savedSnapshotsCount: Math.max(1, savedList.length),
            });
          }

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

          setElements(merged.state.elements);
          setBoardTitle(merged.state.boardTitle);
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

    return () => {
      window.clearTimeout(initTimer);
      decideAbortRef.current?.abort();
      throttler.cancel();
      broadcastThrottlerRef.current = null;
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
              source: "typesafe-jev" | "heuristic";
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

      const combined = updateElements((prev) => {
        const framesToAdd = positioned.filter((e) => e.kind === "frame");
        const rest = positioned.filter((e) => e.kind !== "frame");
        return [...framesToAdd, ...prev, ...rest];
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
      viewportCenterWorld,
      viewportWorld,
      viewport.zoom,
      selectedIds,
      livePlacementDecision,
      livePromptBundle,
      placementCycleOffset,
    ]
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

    setElements(stamped.elements);
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

    setElements(stamped.elements);
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

  const handleRestorePreviousBoard = useCallback(() => {
    const storage =
      typeof window !== "undefined" ? window.localStorage : null;
    const popped = popRecoverySnapshot(storage, roomId);
    const entry = popped.entry ?? recoveryToast?.entry ?? null;
    if (!entry) {
      setRecoveryToast(null);
      return;
    }

    const peerId = collabRef.current?.peerId ?? "local";
    const now = Date.now();
    const prev = elementsRef.current;
    const stamped = applyLocalElementsChange(
      prev,
      entry.snapshot.elements,
      tombstonesRef.current,
      peerId,
      now,
      tombstoneHorizonRevRef.current,
      {
        ttlMs: TOMBSTONE_TTL_MS,
        prevHorizonAt: tombstoneHorizonAtRef.current,
      }
    );

    const restoredTitle =
      entry.snapshot.boardTitle !== undefined
        ? entry.snapshot.boardTitle
        : boardTitleRef.current;
    if (restoredTitle !== boardTitleRef.current) {
      titleRevRef.current =
        Math.max(titleRevRef.current, entry.snapshot.titleRev ?? 0) + 1;
      titleUpdatedByRef.current = peerId;
    }

    const history = getHistory();
    history.commitLocal(stamped.elements, { recordUndo: true });
    elementsRef.current = stamped.elements;
    boardTitleRef.current = restoredTitle;
    tombstonesRef.current = stamped.tombstones;
    tombstoneHorizonRevRef.current = stamped.tombstoneHorizonRev;
    tombstoneHorizonAtRef.current = stamped.tombstoneHorizonAt;
    baseTimestampRef.current = now;
    hasLocalEditsRef.current = true;
    canPersistRef.current = true;

    setElements(stamped.elements);
    setBoardTitle(restoredTitle);
    setSelectedIds([]);
    setInspectorOpen(false);
    setHistoryCounts({ undo: history.undoCount, redo: history.redoCount });
    setRecoveryToast(null);

    broadcastThrottlerRef.current?.flushNow({
      elements: stamped.elements,
      boardTitle: restoredTitle,
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
  }, [getHistory, recoveryToast, roomId]);

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
    updateElements,
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
    setSelectedIds(ids);
    setInspectorOpen(ids.length === 1);
  }, []);

  const resetToStarter = () => {
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
    updateElements(() => []);
    setSelectedIds([]);
    setInspectorOpen(false);
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
              const nextTitle = e.target.value;
              const peerId = collabRef.current?.peerId ?? "local";
              boardTitleRef.current = nextTitle;
              titleRevRef.current += 1;
              titleUpdatedByRef.current = peerId;
              hasLocalEditsRef.current = true;
              canPersistRef.current = true;
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
            className="hidden w-32 bg-transparent text-xs font-semibold text-foreground/90 outline-none focus:text-foreground sm:block"
          />

          <div className="hidden items-center gap-0.5 border-l border-border pl-1.5 lg:flex">
            <button
              type="button"
              onClick={handleUndo}
              disabled={historyCounts.undo === 0}
              title="Undo (⌘Z)"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-35"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={historyCounts.redo === 0}
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

      {/* RECOVERY UNDO TOAST FOR AUTHORITATIVE FULL REPLACE / BULK DELETE */}
      {recoveryToast && (
        <div
          role="status"
          aria-live="polite"
          className="jev-glass fixed left-1/2 top-[72px] z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2.5 rounded-2xl border border-[#D94E28]/30 px-3.5 py-2 shadow-[0_14px_36px_-12px_rgba(15,23,42,0.28)]"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#D94E28]/15 text-[#D94E28]">
            <RotateCcw className="h-3.5 w-3.5" />
          </span>
          <span className="text-xs font-medium text-foreground">
            {recoveryToast.kind === "full_replace"
              ? `Host replaced the board (${recoveryToast.removedCount} ${recoveryToast.removedCount === 1 ? "element" : "elements"} removed).`
              : `Host removed ${recoveryToast.removedCount} of ${recoveryToast.localCount} elements.`}
          </span>
          <button
            type="button"
            onClick={handleRestorePreviousBoard}
            className="shrink-0 rounded-xl bg-[#D94E28] px-2.5 py-1 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[#C0411E]"
          >
            Restore previous board
          </button>
          <button
            type="button"
            onClick={() => setRecoveryToast(null)}
            aria-label="Dismiss recovery notice"
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* COMPACT, UNOBTRUSIVE FLOATING PILL (colors via ←/→, shape icons, in-place rename) */}
      <SelectionInspector
        element={inspectorOpen && !thoughtPrompt.trim() ? selectedElement : null}
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
        onStartInlineEdit={(id) => startInlineEditRef.current?.(id)}
        onDuplicate={(id) => handleDuplicateIds([id])}
        onDelete={(id) => handleDeleteIds([id])}
      />

      {/* MULTI-SELECTION FLOATING ACTION BAR */}
      {multiSelectBarPos && !canvasInteracting && !thoughtPrompt.trim() && (
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
          hasPredictions={predictions.length > 0}
          onChange={(val) => {
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
          onEmptyTab={(reverse) =>
            setActivePredIdx((idx) =>
              predictions.length === 0
                ? 0
                : reverse
                  ? (idx - 1 + predictions.length) % predictions.length
                  : (idx + 1) % predictions.length
            )
          }
          onEmptyEnter={() => {
            if (predictions.length > 0) applyPrediction(activePredIdx);
          }}
          onEmptyUndo={handleUndo}
          onEmptyRedo={handleRedo}
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
