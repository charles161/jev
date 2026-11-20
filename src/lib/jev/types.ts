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

export type MorphNotation = "sketch" | "sequence" | "flowchart" | "state" | "er";

export type MorphElementRole =
  | "actor"
  | "lifeline"
  | "message"
  | "step"
  | "decision"
  | "state"
  | "transition"
  | "entity"
  | "relation"
  | "sketch_item";

export interface MorphActorSpec {
  id: string;
  label: string;
  kind?: "node" | "diamond" | "database" | "ellipse" | "text";
  tone?: ColorTone;
}

export interface MorphMessageSpec {
  id: string;
  from: string;
  to: string;
  label: string;
  order: number;
  async?: boolean;
  isReturn?: boolean;
}

export interface MorphStepBranchSpec {
  to: string;
  label?: string;
  fallback?: boolean;
}

export interface MorphStepSpec {
  id: string;
  label: string;
  kind: "start" | "process" | "decision" | "end";
  tone?: ColorTone;
  branches?: MorphStepBranchSpec[];
}

export interface MorphStateSpec {
  id: string;
  label: string;
  initial?: boolean;
  terminal?: boolean;
  tone?: ColorTone;
}

export interface MorphTransitionSpec {
  id: string;
  from: string;
  to: string;
  event: string;
  fallback?: boolean;
}

export interface MorphEntitySpec {
  id: string;
  name: string;
  attributes: string[];
  tone?: ColorTone;
}

export interface MorphRelationSpec {
  id: string;
  from: string;
  to: string;
  cardinality: string;
  label?: string;
}

export interface MorphSemanticSpec {
  summary: string;
  actors: MorphActorSpec[];
  messages: MorphMessageSpec[];
  steps: MorphStepSpec[];
  states: MorphStateSpec[];
  transitions: MorphTransitionSpec[];
  entities: MorphEntitySpec[];
  relations: MorphRelationSpec[];
}

export interface SketchSnapshotElement {
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
  fromId?: string;
  toId?: string;
  fromPoint?: Point;
  toPoint?: Point;
  arrowStyle?: "curved" | "straight";
  dashed?: boolean;
  bidirectional?: boolean;
  points?: Point[];
  semanticId?: string;
}

export interface MorphGroupRecord {
  groupId: string;
  anchorBounds: ElementBox;
  entrySketchId?: string;
  exitSketchId?: string;
  spec: MorphSemanticSpec;
  sketchSnapshot: SketchSnapshotElement[];
}

export interface ElementMorphMeta {
  groupId: string;
  notation: MorphNotation;
  semanticId?: string;
  role?: MorphElementRole;
  /** Stored on the anchor element of a morphed group for reversible round-trip across Undo, localStorage & P2P sync. */
  groupRecord?: MorphGroupRecord;
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
  /** Reversible Notation Morph group metadata */
  morphMeta?: ElementMorphMeta;
  /** Metadata */
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  updatedBy?: string;
  rev?: number;
}

export interface ElementTombstone {
  deletedAt: number;
  rev: number;
  deletedBy?: string;
}

export type TombstoneMap = Record<string, ElementTombstone>;

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
  kind?: ElementKind;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fromId?: string;
  toId?: string;
  fromPoint?: Point;
  toPoint?: Point;
  label?: string;
  sublabel?: string;
  tone?: ColorTone;
  dashed?: boolean;
  morphMeta?: ElementMorphMeta;
}

export interface PredictedAction {
  id: string;
  title: string;
  subtitle: string;
  category: "extend" | "connect" | "structure" | "layout";
  /** Optional pattern keys for adaptive suggestion feedback ranking */
  feedbackKeys?: string[];
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
  source: "typesafe-jev" | "llm-json" | "heuristic";
  model: string;
  isHeuristic?: boolean;
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
  titleRev?: number;
  titleUpdatedBy?: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  tombstoneHorizonRev?: number;
  tombstoneHorizonAt?: number;
  boardEpoch?: string;
  boardEpochCreatedAt?: number;
  baseTimestamp?: number;
  hasLocalEdits?: boolean;
}
