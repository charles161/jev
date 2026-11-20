export type ElementKind =
  | "node"
  | "diamond"
  | "database"
  | "ellipse"
  | "frame"
  | "text"
  | "arrow"
  | "freedraw";

export type ColorTone =
  | "ink"
  | "terracotta"
  | "cobalt"
  | "teal"
  | "ochre"
  | "plum"
  | "slate";

export type RenderStyle = "sketch" | "clean";
export type BoardTheme = "vellum" | "midnight";

export type ToolType =
  | "select"
  | "hand"
  | "node"
  | "diamond"
  | "database"
  | "ellipse"
  | "arrow"
  | "frame"
  | "freedraw"
  | "text";

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface JevElement {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  sublabel?: string;
  tone: ColorTone;
  seed: number;
  /** For arrows */
  fromId?: string;
  toId?: string;
  fromPoint?: Point;
  toPoint?: Point;
  arrowStyle?: "curved" | "straight";
  dashed?: boolean;
  bidirectional?: boolean;
  /** For freedraw */
  points?: Point[];
  /** Metadata */
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
}

export type SpatialIntentKind =
  | "splice_into_edge"
  | "open_pipeline_gap"
  | "align_pipeline"
  | "align_column"
  | "branch_out"
  | "connect_nearby"
  | "encapsulate_group"
  | "domain_continue"
  | "decision_branch"
  | "prompt_follow_up";

export interface SpatialIntent {
  kind: SpatialIntentKind;
  headline: string;
  detail: string;
  subjectId?: string;
  delta?: { dx: number; dy: number; distance: number };
  relatedIds: string[];
  timestamp: number;
}

export interface ElementPatch {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fromId?: string;
  toId?: string;
  label?: string;
  tone?: ColorTone;
}

export interface PredictedAction {
  id: string;
  title: string;
  subtitle: string;
  category: "extend" | "connect" | "structure" | "layout";
  /** Calibrated probability from TypeSafe Jev (or local prior fallback), 0..1 */
  probability?: number;
  /** New elements that will materialize on Enter (shown as translucent ghosts) */
  addElements: JevElement[];
  /** Existing elements that will be repositioned/rewired on Enter */
  patchElements?: ElementPatch[];
  /** Existing element IDs removed on Enter (e.g. old edge when splicing) */
  removeIds?: string[];
  /** Select these IDs after committing so chaining works seamlessly */
  focusId?: string;
}

export interface JevTelemetry {
  source: "typesafe-jev" | "local-fallback";
  model: string;
  latencyMs: number;
  inputTokens?: number;
  intentChoice?: string | null;
  intentConfidence?: number | null;
  shouldConnectProb?: number | null;
  evaluating?: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PeerCursor {
  peerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  selectedId?: string | null;
  transport: "webrtc" | "broadcast" | "simulated";
  lastSeen: number;
  rttMs?: number;
}

export interface BoardSnapshot {
  elements: JevElement[];
  boardTitle: string;
}
