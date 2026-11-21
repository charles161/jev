import { z } from "zod";
import { inferToneFromLabel } from "./colors";
import {
  computeBounds,
  getElementRect,
  isShapeElement,
  makeSeed,
  Rect,
  rectContainsCenter,
  rectsOverlap,
  uid,
} from "./geometry";
import { DEFAULT_KIND_SIZE, inferShapeKindFromLabel, isContainerKind } from "./notation-kinds";
import { ARROW_ENDS, ELEMENT_KINDS, type ColorTone, type JevElement, type Point, type ShapeKind } from "./types";

export const MAX_SEMANTIC_NODES = 64;
export const MAX_SEMANTIC_EDGES = 96;
export const MAX_SEMANTIC_GROUPS = 16;
export const MAX_SEMANTIC_LABELS = 64;
export const MAX_SEMANTIC_MESSAGES = 48;
export const MAX_SEMANTIC_STATES = 32;
export const MAX_SEMANTIC_ENTITIES = 32;
export const MAX_SEMANTIC_SUBLABEL = 480;

export const MAX_SERIALIZED_NODES = 32;
export const MAX_SERIALIZED_EDGES = 48;
export const MAX_SERIALIZED_GROUPS = 10;
export const MAX_SERIALIZED_DELTAS = 8;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(value: string): boolean {
  return !FORBIDDEN_KEYS.has(value);
}

export function hasForbiddenObjectKeys(obj: unknown, depth = 0): boolean {
  if (depth > 10 || !obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => hasForbiddenObjectKeys(item, depth + 1));
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenObjectKeys(rec[key], depth + 1)) return true;
  }
  return false;
}

const safeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .refine(isSafeKey, "Unsafe identifier");

export const semanticNotationSchema = z.enum([
  "sketch",
  "architecture",
  "flowchart",
  "sequence",
  "state",
  "er",
]);

export type SemanticNotation = z.infer<typeof semanticNotationSchema>;

/**
 * Kinds an AI (or the local heuristic) may emit as a semantic node. Containers (frame,
 * zone, fragment) come from `groups`; sequence/state pseudo-shapes come from Morph.
 */
export const SEMANTIC_NODE_KINDS = [
  "node",
  "diamond",
  "database",
  "ellipse",
  "text",
  "queue",
  "cache",
  "lb",
  "blob",
  "external",
  "actor",
  "entity",
  "class",
] as const satisfies readonly ShapeKind[];

export type SemanticNodeKind = (typeof SEMANTIC_NODE_KINDS)[number];

/** One-line meaning of each kind, shown to the LLM so it picks the right shape. */
export const SEMANTIC_KIND_HINTS: Record<SemanticNodeKind, string> = {
  node: "service / generic component",
  diamond: "decision or check",
  database: "database / table store (Postgres, DynamoDB)",
  ellipse: "start / end terminator",
  text: "free note",
  queue: "queue, stream or broker (Kafka, SQS, RabbitMQ)",
  cache: "cache (Redis, Memcached)",
  lb: "load balancer, CDN or API gateway (ALB, nginx, CloudFront)",
  blob: "object / blob store (S3, GCS)",
  external: "third-party system (Stripe, Twilio)",
  actor: "person or client (user, mobile app)",
  entity: "ER table; sublabel = one column per line, e.g. 'id uuid PK'",
  class: "UML class; sublabel = attributes, a '--' line, then operations",
};

const SEMANTIC_KIND_SET = new Set<string>(SEMANTIC_NODE_KINDS);

export function isSemanticNodeKind(kind: string): kind is SemanticNodeKind {
  return SEMANTIC_KIND_SET.has(kind);
}

const semanticNodeKindSchema = z.enum(SEMANTIC_NODE_KINDS);

const semanticToneSchema = z.enum([
  "ink",
  "terracotta",
  "cobalt",
  "teal",
  "ochre",
  "plum",
  "slate",
]);

export const semanticNodeSchema = z.object({
  id: safeIdSchema,
  label: z.string().trim().min(1).max(160),
  sublabel: z.string().trim().max(MAX_SEMANTIC_SUBLABEL).optional(),
  kind: semanticNodeKindSchema.default("node"),
  tone: semanticToneSchema.optional(),
  role: z.string().trim().max(48).optional(),
  layer: z.number().int().min(0).max(24).optional(),
  groupId: safeIdSchema.optional(),
});

export type SemanticNode = z.infer<typeof semanticNodeSchema>;

export const semanticEdgeSchema = z.object({
  id: safeIdSchema.optional(),
  from: safeIdSchema,
  to: safeIdSchema,
  label: z.string().trim().max(80).optional(),
  dashed: z.boolean().optional(),
  bidirectional: z.boolean().optional(),
  startEnd: z.enum(ARROW_ENDS).optional(),
  endEnd: z.enum(ARROW_ENDS).optional(),
  kind: z
    .enum(["flow", "async", "sync", "fallback", "relation", "transition"])
    .optional(),
});

export type SemanticEdge = z.infer<typeof semanticEdgeSchema>;

export const semanticLabelSchema = z.object({
  targetId: safeIdSchema,
  text: z.string().trim().min(1).max(140),
  position: z.enum(["center", "top", "bottom", "edge"]).optional(),
});

export type SemanticLabel = z.infer<typeof semanticLabelSchema>;

export const semanticMessageSchema = z.object({
  id: safeIdSchema.optional(),
  from: safeIdSchema,
  to: safeIdSchema,
  text: z.string().trim().min(1).max(140),
  order: z.number().int().min(0).max(200).optional(),
  async: z.boolean().optional(),
  returnMessage: z.boolean().optional(),
});

export type SemanticMessage = z.infer<typeof semanticMessageSchema>;

export const semanticStateSchema = z.object({
  id: safeIdSchema,
  label: z.string().trim().min(1).max(120),
  initial: z.boolean().optional(),
  terminal: z.boolean().optional(),
  transitions: z
    .array(
      z.object({
        to: safeIdSchema,
        trigger: z.string().trim().min(1).max(100),
        guard: z.string().trim().max(100).optional(),
      })
    )
    .max(16)
    .optional(),
});

export type SemanticState = z.infer<typeof semanticStateSchema>;

export const semanticEntitySchema = z.object({
  id: safeIdSchema,
  name: z.string().trim().min(1).max(120),
  fields: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        type: z.string().trim().max(48).optional(),
        primaryKey: z.boolean().optional(),
        foreignKey: z.boolean().optional(),
      })
    )
    .max(24)
    .optional(),
});

export type SemanticEntity = z.infer<typeof semanticEntitySchema>;

export const semanticGroupSchema = z.object({
  id: safeIdSchema,
  label: z.string().trim().min(1).max(120),
  nodeIds: z.array(safeIdSchema).min(1).max(MAX_SEMANTIC_NODES),
  tone: semanticToneSchema.optional(),
});

export type SemanticGroup = z.infer<typeof semanticGroupSchema>;

export const semanticGraphSchema = z.object({
  notation: semanticNotationSchema.default("architecture"),
  summary: z.string().trim().min(1).max(160),
  nodes: z.array(semanticNodeSchema).min(1).max(MAX_SEMANTIC_NODES),
  edges: z.array(semanticEdgeSchema).max(MAX_SEMANTIC_EDGES).default([]),
  labels: z.array(semanticLabelSchema).max(MAX_SEMANTIC_LABELS).optional(),
  messages: z.array(semanticMessageSchema).max(MAX_SEMANTIC_MESSAGES).optional(),
  states: z.array(semanticStateSchema).max(MAX_SEMANTIC_STATES).optional(),
  entities: z.array(semanticEntitySchema).max(MAX_SEMANTIC_ENTITIES).optional(),
  groups: z.array(semanticGroupSchema).max(MAX_SEMANTIC_GROUPS).optional(),
});

export type SemanticGraph = z.infer<typeof semanticGraphSchema>;

export type ValidateSemanticGraphResult =
  | { ok: true; graph: SemanticGraph }
  | { ok: false; error: string };

/**
 * Validates and normalizes an untrusted semantic graph object:
 * - Rejects prototype-polluting keys
 * - Enforces strict Zod schema & collection bounds
 * - Deduplicates node IDs and filters dangling/self-loop edges & empty groups
 */
export function validateSemanticGraph(
  raw: unknown,
  opts?: { externalAnchorIds?: Set<string> }
): ValidateSemanticGraphResult {
  if (!raw || typeof raw !== "object" || hasForbiddenObjectKeys(raw)) {
    return { ok: false, error: "Invalid or unsafe semantic graph payload" };
  }

  const parsed = semanticGraphSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Semantic graph schema mismatch",
    };
  }

  const data = parsed.data;
  const seenNodeIds = new Set<string>();
  const uniqueNodes: SemanticNode[] = [];
  for (const node of data.nodes) {
    if (seenNodeIds.has(node.id)) continue;
    seenNodeIds.add(node.id);
    uniqueNodes.push(node);
  }
  if (uniqueNodes.length === 0) {
    return { ok: false, error: "Semantic graph must include at least one node" };
  }

  const validEndpoint = (id: string) =>
    seenNodeIds.has(id) || Boolean(opts?.externalAnchorIds?.has(id));

  const seenEdgeKey = new Set<string>();
  const cleanEdges: SemanticEdge[] = [];
  for (const edge of data.edges) {
    if (edge.from === edge.to) continue;
    if (!validEndpoint(edge.from) || !validEndpoint(edge.to)) continue;
    const ek = `${edge.from}->${edge.to}:${edge.label ?? ""}`;
    if (seenEdgeKey.has(ek)) continue;
    seenEdgeKey.add(ek);
    cleanEdges.push(edge);
  }

  const cleanGroups: SemanticGroup[] = [];
  if (data.groups) {
    for (const grp of data.groups) {
      const validMembers = Array.from(
        new Set(grp.nodeIds.filter((id) => seenNodeIds.has(id)))
      );
      if (validMembers.length > 0) {
        cleanGroups.push({
          ...grp,
          nodeIds: validMembers,
        });
      }
    }
  }

  const cleanLabels = data.labels?.filter((l) => seenNodeIds.has(l.targetId));

  return {
    ok: true,
    graph: {
      notation: data.notation,
      summary: data.summary,
      nodes: uniqueNodes,
      edges: cleanEdges,
      ...(cleanLabels && cleanLabels.length > 0 ? { labels: cleanLabels } : {}),
      ...(data.messages && data.messages.length > 0 ? { messages: data.messages } : {}),
      ...(data.states && data.states.length > 0 ? { states: data.states } : {}),
      ...(data.entities && data.entities.length > 0 ? { entities: data.entities } : {}),
      ...(cleanGroups.length > 0 ? { groups: cleanGroups } : {}),
    },
  };
}

/**
 * Safely parses raw LLM output (either pure JSON or fenced ```json ... ```) into
 * a validated SemanticGraph.
 */
export function parseSemanticGraphJson(
  text: string,
  opts?: { externalAnchorIds?: Set<string> }
): ValidateSemanticGraphResult {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 64_000) {
    return { ok: false, error: "Empty or oversized graph JSON text" };
  }

  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return { ok: false, error: "No JSON object found" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return { ok: false, error: "Malformed JSON" };
  }

  return validateSemanticGraph(decoded, opts);
}

/* ============================================================================
 * COMPACT STRUCTURED BOARD GRAPH + RECENT EDIT DELTAS SERIALIZER
 * ============================================================================ */

export const boardEditDeltaSchema = z.object({
  op: z.enum(["add", "move", "update", "delete", "fork", "prompt"]),
  elementIds: z.array(safeIdSchema).max(16).default([]),
  labels: z.array(z.string().max(80)).max(8).optional(),
  dx: z.number().finite().min(-50_000).max(50_000).optional(),
  dy: z.number().finite().min(-50_000).max(50_000).optional(),
  summary: z.string().trim().min(1).max(160),
  timestamp: z.number().finite().min(0).optional(),
});

export type BoardEditDelta = z.infer<typeof boardEditDeltaSchema>;

export const serializedBoardGraphSchema = z
  .object({
    version: z.literal(1),
    notation: semanticNotationSchema.default("architecture"),
    boardTitle: z.string().max(120).optional(),
    stats: z.object({
      totalNodes: z.number().int().min(0).max(5000),
      totalEdges: z.number().int().min(0).max(5000),
      totalGroups: z.number().int().min(0).max(1000),
      truncated: z.boolean(),
    }),
    nodes: z
      .array(
        z.object({
          id: safeIdSchema,
          label: z.string().max(160),
          sublabel: z.string().max(160).optional(),
          kind: z.enum(ELEMENT_KINDS),
          tone: semanticToneSchema,
          x: z.number().finite(),
          y: z.number().finite(),
          groupId: safeIdSchema.optional(),
        })
      )
      .max(MAX_SERIALIZED_NODES),
    edges: z
      .array(
        z.object({
          id: safeIdSchema,
          from: safeIdSchema,
          to: safeIdSchema,
          label: z.string().max(80).optional(),
          dashed: z.boolean().optional(),
          bidirectional: z.boolean().optional(),
          startEnd: z.enum(ARROW_ENDS).optional(),
          endEnd: z.enum(ARROW_ENDS).optional(),
        })
      )
      .max(MAX_SERIALIZED_EDGES),
    groups: z
      .array(
        z.object({
          id: safeIdSchema,
          label: z.string().max(120),
          nodeIds: z.array(safeIdSchema).max(MAX_SERIALIZED_NODES),
        })
      )
      .max(MAX_SERIALIZED_GROUPS),
    selectedIds: z.array(safeIdSchema).max(48).default([]),
    recentDeltas: z
      .array(
        z.object({
          op: z.enum(["add", "move", "update", "delete", "fork", "prompt"]),
          summary: z.string().max(160),
          elementIds: z.array(safeIdSchema).max(16),
          dx: z.number().finite().optional(),
          dy: z.number().finite().optional(),
        })
      )
      .max(MAX_SERIALIZED_DELTAS)
      .default([]),
    canonicalHash: z.string().min(4).max(64),
  })
  .strict();

export type SerializedBoardGraph = z.infer<typeof serializedBoardGraphSchema>;

function fnv1aHex(input: string): string {
  // 64-bit split FNV-1a (two independent 32-bit lanes) for compact browser+Node hashing
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${p1}${p2}`;
}

function normStr(s: string | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Computes a deterministic canonical hash for a serialized board graph + deltas + optional intent key.
 * Insensitive to selection order, delta timestamps, and incidental whitespace/casing.
 */
export function computeBoardGraphHash(
  graph: Omit<SerializedBoardGraph, "canonicalHash"> | SerializedBoardGraph,
  intentKey?: string
): string {
  const canonical = {
    v: graph.version,
    notation: graph.notation,
    title: normStr(graph.boardTitle),
    nodes: [...graph.nodes]
      .map((n) => ({
        id: n.id,
        label: normStr(n.label),
        sublabel: normStr(n.sublabel),
        kind: n.kind,
        tone: n.tone,
        x: Math.round(n.x / 8) * 8,
        y: Math.round(n.y / 8) * 8,
        groupId: n.groupId ?? "",
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...graph.edges]
      .map((e) => ({
        from: e.from,
        to: e.to,
        label: normStr(e.label),
        dashed: Boolean(e.dashed),
        bidi: Boolean(e.bidirectional),
        ...(e.startEnd ? { startEnd: e.startEnd } : {}),
        ...(e.endEnd ? { endEnd: e.endEnd } : {}),
      }))
      .sort((a, b) => {
        const ka = `${a.from}->${a.to}:${a.label}`;
        const kb = `${b.from}->${b.to}:${b.label}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
    groups: [...graph.groups]
      .map((g) => ({
        id: g.id,
        label: normStr(g.label),
        nodeIds: [...g.nodeIds].sort(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    selectedIds: [...graph.selectedIds].sort(),
    deltas: graph.recentDeltas.map((d) => ({
      op: d.op,
      summary: normStr(d.summary),
      ids: [...d.elementIds].sort(),
      dx: d.dx !== undefined ? Math.round(d.dx) : undefined,
      dy: d.dy !== undefined ? Math.round(d.dy) : undefined,
    })),
    intent: normStr(intentKey),
  };
  return fnv1aHex(JSON.stringify(canonical));
}

export function serializeBoardToGraph(
  elements: JevElement[],
  opts?: {
    selectedIds?: string[];
    subjectId?: string;
    recentDeltas?: BoardEditDelta[];
    boardTitle?: string;
    notation?: SemanticNotation;
  }
): SerializedBoardGraph {
  const shapes = elements.filter((e) => isShapeElement(e) && !isContainerKind(e.kind));
  const frames = elements.filter((e) => isContainerKind(e.kind));
  const arrows = elements.filter((e) => e.kind === "arrow");

  const prioritySet = new Set<string>(opts?.selectedIds ?? []);
  if (opts?.subjectId) prioritySet.add(opts.subjectId);

  // Also prioritize 1-hop neighbors of selected/subject nodes so truncation never cuts local context
  const neighborSet = new Set<string>();
  for (const arr of arrows) {
    if (arr.fromId && arr.toId) {
      if (prioritySet.has(arr.fromId)) neighborSet.add(arr.toId);
      if (prioritySet.has(arr.toId)) neighborSet.add(arr.fromId);
    }
  }

  const orderedShapes = [...shapes].sort((a, b) => {
    const pa = prioritySet.has(a.id) ? 0 : neighborSet.has(a.id) ? 1 : 2;
    const pb = prioritySet.has(b.id) ? 0 : neighborSet.has(b.id) ? 1 : 2;
    if (pa !== pb) return pa - pb;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const keptShapes = orderedShapes.slice(0, MAX_SERIALIZED_NODES);
  const keptNodeIds = new Set(keptShapes.map((s) => s.id));

  // Map each shape to the smallest containing frame
  const shapeToFrame = new Map<string, string>();
  const frameMembers = new Map<string, string[]>();
  const keptFrames = frames.slice(0, MAX_SERIALIZED_GROUPS);
  for (const frame of keptFrames) {
    frameMembers.set(frame.id, []);
  }
  for (const shape of keptShapes) {
    let bestFrame: JevElement | null = null;
    let bestArea = Infinity;
    for (const frame of keptFrames) {
      if (rectContainsCenter(getElementRect(frame), getElementRect(shape))) {
        const area = frame.width * frame.height;
        if (area < bestArea) {
          bestArea = area;
          bestFrame = frame;
        }
      }
    }
    if (bestFrame) {
      shapeToFrame.set(shape.id, bestFrame.id);
      frameMembers.get(bestFrame.id)?.push(shape.id);
    }
  }

  const keptEdges: SerializedBoardGraph["edges"] = [];
  for (const arr of arrows) {
    if (keptEdges.length >= MAX_SERIALIZED_EDGES) break;
    if (!arr.fromId || !arr.toId) continue;
    if (!keptNodeIds.has(arr.fromId) || !keptNodeIds.has(arr.toId)) continue;
    keptEdges.push({
      id: arr.id,
      from: arr.fromId,
      to: arr.toId,
      ...(arr.label ? { label: arr.label.slice(0, 80) } : {}),
      ...(arr.dashed ? { dashed: true } : {}),
      ...(arr.bidirectional ? { bidirectional: true } : {}),
      ...(arr.startEnd ? { startEnd: arr.startEnd } : {}),
      ...(arr.endEnd ? { endEnd: arr.endEnd } : {}),
    });
  }

  const keptGroups: SerializedBoardGraph["groups"] = keptFrames
    .map((f) => ({
      id: f.id,
      label: (f.label || "Zone").slice(0, 120),
      nodeIds: frameMembers.get(f.id) ?? [],
    }))
    .filter((g) => g.nodeIds.length > 0 || prioritySet.has(g.id));

  const recentDeltas = (opts?.recentDeltas ?? [])
    .slice(-MAX_SERIALIZED_DELTAS)
    .map((d) => ({
      op: d.op,
      summary: d.summary.slice(0, 160),
      elementIds: d.elementIds.slice(0, 16),
      ...(d.dx !== undefined ? { dx: Math.round(d.dx) } : {}),
      ...(d.dy !== undefined ? { dy: Math.round(d.dy) } : {}),
    }));

  const selectedIds = Array.from(new Set(opts?.selectedIds ?? [])).slice(0, 48);

  const partial: Omit<SerializedBoardGraph, "canonicalHash"> = {
    version: 1,
    notation: opts?.notation ?? "architecture",
    ...(opts?.boardTitle ? { boardTitle: opts.boardTitle.slice(0, 120) } : {}),
    stats: {
      totalNodes: shapes.length,
      totalEdges: arrows.length,
      totalGroups: frames.length,
      truncated:
        shapes.length > MAX_SERIALIZED_NODES ||
        arrows.length > MAX_SERIALIZED_EDGES ||
        frames.length > MAX_SERIALIZED_GROUPS,
    },
    nodes: keptShapes.map((s) => ({
      id: s.id,
      label: (s.label || s.kind).slice(0, 160),
      ...(s.sublabel ? { sublabel: s.sublabel.slice(0, 160) } : {}),
      kind: s.kind,
      tone: s.tone,
      x: Math.round(s.x),
      y: Math.round(s.y),
      ...(shapeToFrame.has(s.id) ? { groupId: shapeToFrame.get(s.id) } : {}),
    })),
    edges: keptEdges,
    groups: keptGroups,
    selectedIds,
    recentDeltas,
  };

  return {
    ...partial,
    canonicalHash: computeBoardGraphHash(partial),
  };
}

/* ============================================================================
 * DETERMINISTIC LAYOUT + VALIDATOR ENGINE
 * ============================================================================ */

export interface LayoutSemanticGraphOptions {
  anchorCenter?: Point;
  anchorBounds?: Rect;
  existingElements?: JevElement[];
  idPrefix?: string;
  colGap?: number;
  rowGap?: number;
  now?: number;
}

export interface LayoutSemanticGraphResult {
  elements: JevElement[];
  nodeIdMap: Map<string, string>;
  summary: string;
  focusId?: string;
}

const ROW_KINDS = new Set<SemanticNodeKind>(["entity", "class"]);
const LEGACY_KINDS = new Set<SemanticNodeKind>(["node", "diamond", "database", "ellipse", "text"]);

function measureRowBox(node: SemanticNode): { width: number; height: number } {
  const base = DEFAULT_KIND_SIZE[node.kind];
  const rows = (node.sublabel ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
  const longest = Math.max(node.label.length * 9, ...rows.map((r) => r.length * 7.2));
  const width = Math.min(320, Math.max(base.width, longest + 32));
  const height = Math.max(base.height, 44 + rows.length * 20 + 12);
  return { width: Math.round(width), height: Math.round(height) };
}

export function measureSemanticNode(node: SemanticNode): { width: number; height: number } {
  if (ROW_KINDS.has(node.kind)) return measureRowBox(node);
  if (node.kind === "actor") return { ...DEFAULT_KIND_SIZE.actor };
  if (!LEGACY_KINDS.has(node.kind)) {
    const base = DEFAULT_KIND_SIZE[node.kind];
    const w = Math.min(base.width + 80, Math.max(base.width, node.label.length * 8.5 + 48));
    return { width: Math.round(w), height: base.height };
  }
  if (node.kind === "diamond") {
    const w = Math.min(200, Math.max(148, node.label.length * 8.5 + 56));
    return { width: Math.round(w), height: 96 };
  }
  if (node.kind === "database") {
    const w = Math.min(216, Math.max(156, node.label.length * 8.5 + 48));
    return { width: Math.round(w), height: 86 };
  }
  if (node.kind === "ellipse") {
    const w = Math.min(204, Math.max(152, node.label.length * 8.5 + 48));
    return { width: Math.round(w), height: 74 };
  }
  if (node.kind === "text") {
    const w = Math.min(240, Math.max(120, node.label.length * 8.5 + 32));
    return { width: Math.round(w), height: 42 };
  }
  const w = Math.min(224, Math.max(162, node.label.length * 8.8 + 46));
  return { width: Math.round(w), height: 72 };
}

/**
 * Assigns cycle-safe topological layers for a semantic graph, honoring explicit `node.layer` hints.
 */
function assignLayers(graph: SemanticGraph): Map<string, number> {
  const layerMap = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of graph.nodes) {
    outgoing.set(n.id, []);
    inDegree.set(n.id, 0);
    if (typeof n.layer === "number") {
      layerMap.set(n.id, n.layer);
    }
  }

  for (const e of graph.edges) {
    if (!outgoing.has(e.from) || !inDegree.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // If every node already provided an explicit layer hint, respect them directly
  if (layerMap.size === graph.nodes.length) {
    return layerMap;
  }

  // Kahn's topological sort with deterministic queue ordering + cycle breaking
  const remainingIn = new Map(inDegree);
  const visited = new Set<string>();
  const topoOrder: string[] = [];

  const queue: string[] = [];
  for (const n of graph.nodes) {
    if ((remainingIn.get(n.id) ?? 0) === 0) {
      queue.push(n.id);
    }
  }

  while (topoOrder.length < graph.nodes.length) {
    if (queue.length === 0) {
      // Cycle break: pick first unvisited node with smallest remaining in-degree
      let bestId: string | null = null;
      let bestDeg = Infinity;
      for (const n of graph.nodes) {
        if (visited.has(n.id)) continue;
        const d = remainingIn.get(n.id) ?? 0;
        if (d < bestDeg) {
          bestDeg = d;
          bestId = n.id;
        }
      }
      if (!bestId) break;
      queue.push(bestId);
    }

    const curr = queue.shift()!;
    if (visited.has(curr)) continue;
    visited.add(curr);
    topoOrder.push(curr);

    const currLayer = layerMap.get(curr) ?? 0;
    layerMap.set(curr, currLayer);

    for (const next of outgoing.get(curr) ?? []) {
      if (visited.has(next)) continue; // Ignore back-edges in cycles
      const existingNext = layerMap.get(next);
      const proposed = currLayer + 1;
      if (existingNext === undefined || proposed > existingNext) {
        layerMap.set(next, proposed);
      }
      const nextDeg = (remainingIn.get(next) ?? 1) - 1;
      remainingIn.set(next, nextDeg);
      if (nextDeg <= 0) {
        queue.push(next);
      }
    }
  }

  for (const n of graph.nodes) {
    if (!layerMap.has(n.id)) {
      layerMap.set(n.id, 0);
    }
  }

  return layerMap;
}

/**
 * Resolves any residual pairwise overlap between non-frame shape elements deterministically.
 */
function resolveShapeOverlaps(shapes: JevElement[], minGap = 24): void {
  const maxPasses = 16;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i];
        const b = shapes[j];
        if (rectsOverlap(getElementRect(a), getElementRect(b), minGap)) {
          // Push the lower (or later) node cleanly below the upper node
          const targetY = Math.round(a.y + a.height + minGap + 8);
          if (b.y < targetY) {
            b.y = targetY;
            moved = true;
          } else {
            b.x = Math.round(a.x + a.width + minGap + 8);
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}

export function layoutSemanticGraphToElements(
  graph: SemanticGraph,
  opts: LayoutSemanticGraphOptions = {}
): LayoutSemanticGraphResult {
  const validated = validateSemanticGraph(graph);
  const safeGraph = validated.ok ? validated.graph : graph;

  const now = opts.now ?? Date.now();
  const idPrefix = opts.idPrefix ?? "el";
  const colGap = opts.colGap ?? 252;
  const rowGap = opts.rowGap ?? 124;

  const layerMap = assignLayers(safeGraph);
  const layers = new Map<number, SemanticNode[]>();
  for (const n of safeGraph.nodes) {
    const l = layerMap.get(n.id) ?? 0;
    const arr = layers.get(l) ?? [];
    arr.push(n);
    layers.set(l, arr);
  }
  const sortedLayerNums = Array.from(layers.keys()).sort((a, b) => a - b);

  // Build parent map for simple barycenter vertical sorting within layers
  const incomingParents = new Map<string, string[]>();
  for (const e of safeGraph.edges) {
    const arr = incomingParents.get(e.to) ?? [];
    arr.push(e.from);
    incomingParents.set(e.to, arr);
  }

  // Track group membership for gentle vertical clustering
  const nodeGroupIdx = new Map<string, number>();
  (safeGraph.groups ?? []).forEach((g, idx) => {
    for (const nid of g.nodeIds) {
      if (!nodeGroupIdx.has(nid)) nodeGroupIdx.set(nid, idx);
    }
  });

  const nodeIdMap = new Map<string, string>();
  const createdNodes: JevElement[] = [];
  const yCenterBySemanticId = new Map<string, number>();
  const labelMap = new Map<string, string>();
  for (const lbl of safeGraph.labels ?? []) {
    if (!labelMap.has(lbl.targetId)) {
      labelMap.set(lbl.targetId, lbl.text);
    }
  }

  let currentX = 0;
  for (let colIdx = 0; colIdx < sortedLayerNums.length; colIdx++) {
    const layerNum = sortedLayerNums[colIdx];
    const colNodes = [...(layers.get(layerNum) ?? [])];

    if (colIdx > 0) {
      colNodes.sort((a, b) => {
        const parentsA = incomingParents.get(a.id) ?? [];
        const parentsB = incomingParents.get(b.id) ?? [];
        const avgY = (ids: string[]) => {
          const ys = ids
            .map((pid) => yCenterBySemanticId.get(pid))
            .filter((v): v is number => v !== undefined);
          if (ys.length === 0) return 0;
          return ys.reduce((s, v) => s + v, 0) / ys.length;
        };
        const ya = avgY(parentsA);
        const yb = avgY(parentsB);
        if (Math.abs(ya - yb) > 4) return ya - yb;
        const ga = nodeGroupIdx.get(a.id) ?? 999;
        const gb = nodeGroupIdx.get(b.id) ?? 999;
        return ga - gb;
      });
    }

    const sizes = colNodes.map((n) => measureSemanticNode(n));
    const maxColW = Math.max(162, ...sizes.map((s) => s.width));
    const totalColH = (colNodes.length - 1) * rowGap;

    colNodes.forEach((node, rowIdx) => {
      const sz = sizes[rowIdx];
      const realId = uid(idPrefix);
      const x = Math.round(currentX + (maxColW - sz.width) / 2);
      const y = Math.round(rowIdx * rowGap - totalColH / 2 - sz.height / 2);
      const sublabel = node.sublabel ?? labelMap.get(node.id);

      const el: JevElement = {
        id: realId,
        kind: node.kind,
        x,
        y,
        width: sz.width,
        height: sz.height,
        label: node.label,
        ...(sublabel ? { sublabel } : {}),
        tone: node.tone ?? inferToneFromLabel(node.label),
        seed: makeSeed(realId),
        createdAt: now,
        updatedAt: now,
        rev: 1,
      };
      nodeIdMap.set(node.id, realId);
      yCenterBySemanticId.set(node.id, y + sz.height / 2);
      createdNodes.push(el);
    });

    currentX += Math.max(colGap, maxColW + 84);
  }

  // Guarantee zero pairwise shape overlaps
  resolveShapeOverlaps(createdNodes, 24);

  // Build frames around groups (rendered behind nodes)
  const createdById = new Map(createdNodes.map((n) => [n.id, n]));
  const createdFrames: JevElement[] = [];
  for (const grp of safeGraph.groups ?? []) {
    const members = grp.nodeIds
      .map((semId) => {
        const realId = nodeIdMap.get(semId);
        return realId ? createdById.get(realId) : undefined;
      })
      .filter((e): e is JevElement => Boolean(e));
    const b = computeBounds(members);
    if (!b) continue;
    const frameId = uid("frm");
    createdFrames.push({
      id: frameId,
      kind: "frame",
      x: Math.round(b.x - 32),
      y: Math.round(b.y - 44),
      width: Math.round(b.width + 64),
      height: Math.round(b.height + 72),
      label: grp.label,
      tone: grp.tone ?? "slate",
      seed: makeSeed(frameId),
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  // Anchor generated diagram cleanly to target bounds / center / below existing
  const genBounds = computeBounds([...createdFrames, ...createdNodes]);
  if (genBounds) {
    let targetCenterX: number;
    let targetCenterY: number;

    if (opts.anchorBounds) {
      targetCenterX = opts.anchorBounds.x + opts.anchorBounds.width / 2;
      targetCenterY = opts.anchorBounds.y + opts.anchorBounds.height / 2;
    } else if (opts.anchorCenter) {
      targetCenterX = opts.anchorCenter.x;
      targetCenterY = opts.anchorCenter.y;
    } else {
      const existingBounds = opts.existingElements
        ? computeBounds(opts.existingElements)
        : null;
      targetCenterX = existingBounds
        ? existingBounds.x + existingBounds.width / 2
        : 420;
      targetCenterY = existingBounds
        ? existingBounds.y + existingBounds.height + 160
        : 280;
    }

    const genCenterX = genBounds.x + genBounds.width / 2;
    const genCenterY = genBounds.y + genBounds.height / 2;
    const dx = Math.round(targetCenterX - genCenterX);
    const dy = Math.round(targetCenterY - genCenterY);

    for (const n of createdNodes) {
      n.x += dx;
      n.y += dy;
    }
    for (const f of createdFrames) {
      f.x += dx;
      f.y += dy;
    }
  }

  // Build arrows
  const createdArrows: JevElement[] = [];
  for (const edge of safeGraph.edges) {
    const fromReal = nodeIdMap.get(edge.from);
    const toReal = nodeIdMap.get(edge.to);
    if (!fromReal || !toReal || fromReal === toReal) continue;
    const arrId = uid("arr");
    const isDashed =
      edge.dashed ?? (edge.kind === "async" || edge.kind === "fallback");
    const tone: ColorTone =
      edge.kind === "fallback" ||
      (isDashed &&
        edge.label &&
        /^(no|fail|error|miss|fallback|retry|dlq)$/i.test(edge.label))
        ? "terracotta"
        : edge.kind === "async"
          ? "ochre"
          : "ink";

    createdArrows.push({
      id: arrId,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: edge.label ?? "",
      tone,
      seed: makeSeed(arrId),
      fromId: fromReal,
      toId: toReal,
      arrowStyle: "curved",
      ...(isDashed ? { dashed: true } : {}),
      ...(edge.bidirectional ? { bidirectional: true } : {}),
      ...(edge.startEnd ? { startEnd: edge.startEnd } : {}),
      ...(edge.endEnd ? { endEnd: edge.endEnd } : {}),
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  const all = [...createdFrames, ...createdNodes, ...createdArrows];
  const focusId = createdNodes[createdNodes.length - 1]?.id;
  return {
    elements: all,
    nodeIdMap,
    summary: safeGraph.summary,
    focusId,
  };
}

export interface LayoutValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validates that laid-out Jev elements have finite non-negative bounds, zero shape-shape
 * overlap, and valid arrow endpoint references.
 */
export function validateLayoutElements(
  elements: JevElement[],
  opts?: { externalElementIds?: Set<string> }
): LayoutValidationResult {
  const errors: string[] = [];
  const idSet = new Set<string>();
  const shapes: JevElement[] = [];

  for (const el of elements) {
    if (!el.id || FORBIDDEN_KEYS.has(el.id)) {
      errors.push(`Invalid element ID: ${String(el.id)}`);
      continue;
    }
    if (idSet.has(el.id)) {
      errors.push(`Duplicate element ID: ${el.id}`);
    }
    idSet.add(el.id);

    if (
      !Number.isFinite(el.x) ||
      !Number.isFinite(el.y) ||
      !Number.isFinite(el.width) ||
      !Number.isFinite(el.height)
    ) {
      errors.push(`Non-finite geometry on ${el.id}`);
    }
    if (el.kind !== "arrow" && (el.width <= 0 || el.height <= 0)) {
      errors.push(`Non-positive dimensions on ${el.id}`);
    }
    if (isShapeElement(el) && el.kind !== "frame") {
      shapes.push(el);
    }
  }

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (rectsOverlap(getElementRect(shapes[i]), getElementRect(shapes[j]), 2)) {
        errors.push(`Overlap between ${shapes[i].id} and ${shapes[j].id}`);
      }
    }
  }

  for (const el of elements) {
    if (el.kind !== "arrow") continue;
    const validId = (id: string) =>
      idSet.has(id) || Boolean(opts?.externalElementIds?.has(id));
    if (el.fromId && !validId(el.fromId)) {
      errors.push(`Arrow ${el.id} has dangling fromId ${el.fromId}`);
    }
    if (el.toId && !validId(el.toId)) {
      errors.push(`Arrow ${el.id} has dangling toId ${el.toId}`);
    }
    if (el.fromId && el.toId && el.fromId === el.toId) {
      errors.push(`Arrow ${el.id} is a self-loop`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ============================================================================
 * UPGRADED RICH LOCAL SEMANTIC GRAPH BUILDER (HONEST HEURISTIC FALLBACK)
 * ============================================================================ */

export type SemanticPatternHint =
  | "webrtc_p2p"
  | "auth_flow"
  | "microservices"
  | "ai_rag"
  | "ci_cd"
  | "onboarding_funnel"
  | "comparison"
  | "event_driven"
  | "cache_read_replica"
  | "payments_ledger"
  | "custom_flow";

export interface LocalSemanticGraphResult {
  graph: SemanticGraph;
  isHeuristic: true;
  confidence: null;
  archetype: SemanticPatternHint;
}

const DECISION_RE = /\?|\b(check|checks|valid|validate|decide|decision|condition|gate|authorized|approved|if)\b/;
const GENERIC_STORE_RE = /\b(store|storage|vector)\b/;
const TERMINATOR_RE = /^(start|end|peer\s?[a-z0-9]?)$/;

/** Label → semantic kind: decision first, then the HLD rules, then generic stores and terminators. */
export function inferSemanticKind(label: string): SemanticNodeKind {
  const l = label.toLowerCase().trim();
  if (DECISION_RE.test(l)) return "diamond";
  const hld = inferShapeKindFromLabel(l);
  if (hld && isSemanticNodeKind(hld)) return hld;
  if (GENERIC_STORE_RE.test(l)) return "database";
  if (TERMINATOR_RE.test(l)) return "ellipse";
  return "node";
}

const DATA_TIER_KINDS = new Set<SemanticNodeKind>(["database", "cache", "blob"]);

function cleanSemanticLabel(raw: string): string {
  const trimmed = raw
    .replace(/^[\[\(\{\s]+|[\]\)\}\s]+$/g, "")
    .replace(/^(a|an|the)\s+/i, "")
    .trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (word === word.toUpperCase() && word.length >= 2) return word;
      const specials: Record<string, string> = {
        webrtc: "WebRTC",
        crdt: "CRDT",
        oauth: "OAuth",
        postgresql: "PostgreSQL",
        postgres: "Postgres",
        graphql: "GraphQL",
        "next.js": "Next.js",
        "node.js": "Node.js",
        github: "GitHub",
        youtube: "YouTube",
        ios: "iOS",
        macos: "macOS",
        kafka: "Kafka",
        redis: "Redis",
        dlq: "DLQ",
        gcs: "GCS",
        sqs: "SQS",
        sns: "SNS",
        rabbitmq: "RabbitMQ",
        cloudfront: "CloudFront",
        memcached: "Memcached",
      };
      const lower = word.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(specials, lower)) {
        return specials[lower];
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function slugKey(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return s && !FORBIDDEN_KEYS.has(s) ? s : `n_${makeSeed(label).toString(36)}`;
}

function parseArrowNotationToSemanticGraph(input: string): SemanticGraph | null {
  if (!/(->|=>|→|<->|↔|--.+-->)/.test(input)) return null;

  const nodeMap = new Map<string, SemanticNode>();
  const edges: SemanticEdge[] = [];
  const lines = input
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);

  let titlePrefix = "";

  for (const rawLine of lines) {
    let line = rawLine;
    const colonIdx = line.indexOf(":");
    const arrowIdx = line.search(/(->|=>|→|<->|↔|--)/);
    if (colonIdx > 0 && colonIdx < arrowIdx) {
      titlePrefix = line.slice(0, colonIdx).trim();
      line = line.slice(colonIdx + 1).trim();
    }

    const tokens = line.split(/\s*(<->|↔|--(?:(?!-->).)+-->|->|=>|→)\s*/);
    let prevKeys: string[] = [];
    let layer = 0;
    let pendingEdgeLabel: string | undefined;
    let pendingBidi = false;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].trim();
      if (!tok) continue;
      if (/^(<->|↔)$/.test(tok)) {
        pendingBidi = true;
        pendingEdgeLabel = undefined;
        continue;
      }
      if (/^--(.+)-->$/.test(tok)) {
        const m = tok.match(/^--(.+)-->$/);
        pendingEdgeLabel = m ? m[1].trim() : undefined;
        pendingBidi = false;
        continue;
      }
      if (tok === "->" || tok === "=>" || tok === "→") {
        pendingBidi = false;
        pendingEdgeLabel = undefined;
        continue;
      }

      let segment = tok;
      const parenMatch = segment.match(/^\(([^)]+)\)\s+(.+)$/);
      if (parenMatch) {
        pendingEdgeLabel = parenMatch[1].trim();
        segment = parenMatch[2].trim();
      }

      const isBracketed = segment.startsWith("[") && segment.endsWith("]");
      const inner = isBracketed ? segment.slice(1, -1) : segment;
      const branchParts = inner
        .split(/\s*,\s*|\s*\|\s*/)
        .map((s) => s.trim())
        .filter(Boolean);

      const currentKeys: string[] = [];
      for (const branch of branchParts) {
        let edgeLbl = pendingEdgeLabel;
        let nodeText = branch;
        const branchLabelMatch = branch.match(/^([A-Za-z0-9\s]{1,16}):\s*(.+)$/);
        if (branchLabelMatch) {
          edgeLbl = branchLabelMatch[1].trim();
          nodeText = branchLabelMatch[2].trim();
        }
        const label = cleanSemanticLabel(nodeText);
        if (!label) continue;
        const id = slugKey(label);
        if (!nodeMap.has(id)) {
          nodeMap.set(id, {
            id,
            label,
            kind: inferSemanticKind(label),
            tone: inferToneFromLabel(label),
            layer,
          });
        } else {
          const ex = nodeMap.get(id)!;
          ex.layer = Math.max(ex.layer ?? 0, layer);
        }
        currentKeys.push(id);

        for (const pk of prevKeys) {
          if (pk === id) continue;
          if (!edges.some((e) => e.from === pk && e.to === id)) {
            const isFail = Boolean(
              edgeLbl && /^(no|fail|error|miss|fallback|async|retry)$/i.test(edgeLbl)
            );
            edges.push({
              from: pk,
              to: id,
              ...(edgeLbl ? { label: edgeLbl } : {}),
              ...(isFail ? { dashed: true, kind: "fallback" as const } : { kind: "flow" as const }),
              ...(pendingBidi ? { bidirectional: true } : {}),
            });
          }
        }
      }

      if (currentKeys.length > 0) {
        prevKeys = currentKeys;
        layer += 1;
      }
      pendingEdgeLabel = undefined;
      pendingBidi = false;
    }
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length === 0) return null;

  return {
    notation: "architecture",
    summary: titlePrefix || `${nodes[0].label} → ${nodes[nodes.length - 1].label}`,
    nodes,
    edges,
    ...(titlePrefix && nodes.length >= 2
      ? {
          groups: [
            {
              id: "grp_title",
              label: cleanSemanticLabel(titlePrefix),
              nodeIds: nodes.map((n) => n.id),
            },
          ],
        }
      : {}),
  };
}

/**
 * Upgraded rich local semantic graph builder used whenever no upstream LLM key is set
 * or as a validated fallback. Always honestly reports `isHeuristic: true, confidence: null`.
 */
export function buildLocalSemanticGraphFromPrompt(
  prompt: string,
  patternHint?: SemanticPatternHint | null
): LocalSemanticGraphResult {
  const trimmed = prompt.trim();
  const arrowGraph = parseArrowNotationToSemanticGraph(trimmed);
  if (arrowGraph) {
    return {
      graph: arrowGraph,
      isHeuristic: true,
      confidence: null,
      archetype: "custom_flow",
    };
  }

  const lower = trimmed.toLowerCase();

  // Comparison: "X vs Y"
  const vsMatch = trimmed.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i);
  if (vsMatch || patternHint === "comparison") {
    const leftTitle = cleanSemanticLabel(vsMatch ? vsMatch[1] : trimmed.split(/\s+/)[0] || "Option A");
    const rightTitle = cleanSemanticLabel(vsMatch ? vsMatch[2] : "Alternative");
    const graph: SemanticGraph = {
      notation: "architecture",
      summary: `${leftTitle} vs ${rightTitle}`,
      nodes: [
        { id: "opt_a", label: leftTitle, sublabel: "Option A", kind: inferSemanticKind(leftTitle), tone: "cobalt", layer: 0 },
        { id: "left_pros", label: "Strengths", sublabel: `Why ${leftTitle}`, kind: "node", tone: "teal", layer: 1 },
        { id: "left_cons", label: "Trade-offs", sublabel: "Constraints", kind: "node", tone: "terracotta", layer: 1 },
        { id: "opt_b", label: rightTitle, sublabel: "Option B", kind: inferSemanticKind(rightTitle), tone: "terracotta", layer: 0 },
        { id: "right_pros", label: "Strengths ", sublabel: `Why ${rightTitle}`, kind: "node", tone: "teal", layer: 1 },
        { id: "right_cons", label: "Trade-offs ", sublabel: "Constraints", kind: "node", tone: "ochre", layer: 1 },
      ],
      edges: [
        { from: "opt_a", to: "left_pros", label: "pros" },
        { from: "opt_a", to: "left_cons", label: "cons", dashed: true },
        { from: "opt_b", to: "right_pros", label: "pros" },
        { from: "opt_b", to: "right_cons", label: "cons", dashed: true },
      ],
      groups: [
        { id: "grp_a", label: leftTitle, nodeIds: ["opt_a", "left_pros", "left_cons"] },
        { id: "grp_b", label: rightTitle, nodeIds: ["opt_b", "right_pros", "right_cons"] },
      ],
    };
    return { graph, isHeuristic: true, confidence: null, archetype: "comparison" };
  }

  // Single-word component -> crisp single node for rapid Enter chaining
  if (!patternHint && !/[,;]/.test(trimmed) && trimmed.split(/\s+/).length === 1) {
    const label = cleanSemanticLabel(trimmed) || "Component";
    return {
      graph: {
        notation: "architecture",
        summary: label,
        nodes: [
          {
            id: slugKey(label),
            label,
            kind: inferSemanticKind(label),
            tone: inferToneFromLabel(label),
            layer: 0,
          },
        ],
        edges: [],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "custom_flow",
    };
  }

  // Event-driven / Kafka / Queue / DLQ pipeline
  if (
    patternHint === "event_driven" ||
    /(event[- ]driven|kafka|rabbitmq|dead[- ]letter|dlq|message queue|pub\/?sub|worker pool)/.test(lower)
  ) {
    const domainPrefix = lower.includes("order")
      ? "Order"
      : lower.includes("payment") || lower.includes("billing")
        ? "Billing"
        : lower.includes("email") || lower.includes("notif")
          ? "Notification"
          : "Domain";
    const graph: SemanticGraph = {
      notation: "architecture",
      summary: `${domainPrefix} Event-Driven Pipeline`,
      nodes: [
        { id: "producer", label: `${domainPrefix} API`, sublabel: "Ingest & validate", kind: "node", tone: "cobalt", layer: 0 },
        { id: "broker", label: lower.includes("kafka") ? "Kafka Topic" : "Event Queue", sublabel: "Durable stream", kind: "queue", tone: "ochre", layer: 1 },
        { id: "worker", label: `${domainPrefix} Worker`, sublabel: "Idempotent consumer", kind: "node", tone: "cobalt", layer: 2 },
        { id: "dlq", label: "Dead Letter Queue", sublabel: "Retry & inspect", kind: "queue", tone: "terracotta", layer: 2 },
        { id: "store", label: lower.includes("postgres") ? "Postgres DB" : "State Store", sublabel: "Commit projection", kind: "database", tone: "teal", layer: 3 },
      ],
      edges: [
        { from: "producer", to: "broker", label: "publish", dashed: true, kind: "async" },
        { from: "broker", to: "worker", label: "consume", kind: "async" },
        { from: "worker", to: "dlq", label: "failed", dashed: true, kind: "fallback" },
        { from: "worker", to: "store", label: "persist", kind: "sync" },
      ],
      groups: [
        { id: "grp_async", label: "Async Event Backbone", nodeIds: ["broker", "worker", "dlq"] },
      ],
    };
    return { graph, isHeuristic: true, confidence: null, archetype: "event_driven" };
  }

  // High-throughput cache + read replica architecture
  if (
    patternHint === "cache_read_replica" ||
    (/(redis|cache)/.test(lower) && /(replica|read|postgres|mysql|db|throughput)/.test(lower))
  ) {
    const graph: SemanticGraph = {
      notation: "architecture",
      summary: "Cache-First & Read Replica Flow",
      nodes: [
        { id: "client", label: "Client App", sublabel: "Read / Write", kind: "actor", tone: "terracotta", layer: 0 },
        { id: "api", label: "Read/Write API", sublabel: "Route queries", kind: "node", tone: "cobalt", layer: 1 },
        { id: "hit", label: "Cache Hit?", sublabel: "Redis TTL", kind: "diamond", tone: "plum", layer: 2 },
        { id: "redis", label: "Redis Cache", sublabel: "Sub-ms hot keys", kind: "cache", tone: "teal", layer: 3 },
        { id: "replica", label: "Postgres Read Replica", sublabel: "Low-latency reads", kind: "database", tone: "teal", layer: 3 },
        { id: "primary", label: "Postgres Primary", sublabel: "Durable writes", kind: "database", tone: "teal", layer: 2 },
      ],
      edges: [
        { from: "client", to: "api", label: "HTTPS" },
        { from: "api", to: "hit", label: "read" },
        { from: "hit", to: "redis", label: "Yes", kind: "sync" },
        { from: "hit", to: "replica", label: "Miss", dashed: true, kind: "fallback" },
        { from: "api", to: "primary", label: "write", kind: "sync" },
        { from: "primary", to: "replica", label: "replicate", dashed: true, kind: "async" },
      ],
      groups: [
        { id: "grp_data", label: "Tiered Storage", nodeIds: ["redis", "replica", "primary"] },
      ],
    };
    return { graph, isHeuristic: true, confidence: null, archetype: "cache_read_replica" };
  }

  // Payments / Checkout / Ledger
  if (
    patternHint === "payments_ledger" ||
    /(payment|stripe|ledger|billing|checkout).*(webhook|db|ledger|idempoten|fraud|service)/.test(lower)
  ) {
    const graph: SemanticGraph = {
      notation: "architecture",
      summary: "Payments & Ledger Architecture",
      nodes: [
        { id: "customer", label: "Customer", sublabel: "Checkout UI", kind: "actor", tone: "terracotta", layer: 0 },
        { id: "api", label: "Checkout API", sublabel: "Idempotency key", kind: "node", tone: "cobalt", layer: 1 },
        { id: "fraud", label: "Risk Check?", sublabel: "Fraud rules", kind: "diamond", tone: "plum", layer: 2 },
        { id: "psp", label: "Payment Gateway", sublabel: "Stripe / PSP", kind: "external", tone: "cobalt", layer: 3 },
        { id: "ledger", label: "Ledger DB", sublabel: "Double-entry SQL", kind: "database", tone: "teal", layer: 4 },
        { id: "webhook", label: "Webhook Queue", sublabel: "Async receipts", kind: "queue", tone: "ochre", layer: 4 },
      ],
      edges: [
        { from: "customer", to: "api", label: "pay" },
        { from: "api", to: "fraud", label: "score" },
        { from: "fraud", to: "psp", label: "Approved" },
        { from: "psp", to: "ledger", label: "settle" },
        { from: "psp", to: "webhook", label: "events", dashed: true, kind: "async" },
      ],
      groups: [{ id: "grp_pay", label: "Payment Core", nodeIds: ["api", "fraud", "psp"] }],
    };
    return { graph, isHeuristic: true, confidence: null, archetype: "payments_ledger" };
  }

  // WebRTC P2P
  if (
    patternHint === "webrtc_p2p" ||
    (/(webrtc|p2p|peer[- ]to[- ]peer|whiteboard|collab)/.test(lower) &&
      lower.split(/\s+/).length >= 2)
  ) {
    return {
      graph: {
        notation: "architecture",
        summary: "WebRTC P2P Architecture",
        nodes: [
          { id: "peer_a", label: "Peer A Browser", sublabel: "Skot Canvas", kind: "ellipse", tone: "terracotta", layer: 0 },
          { id: "peer_b", label: "Peer B Browser", sublabel: "Skot Canvas", kind: "ellipse", tone: "terracotta", layer: 0 },
          { id: "signal", label: "Signaling Server", sublabel: "SDP Offer / Answer", kind: "node", tone: "cobalt", layer: 1 },
          { id: "stun", label: "STUN / ICE", sublabel: "NAT Traversal", kind: "node", tone: "cobalt", layer: 1 },
          { id: "channel", label: "RTCDataChannel", sublabel: "Direct P2P Mesh", kind: "node", tone: "cobalt", layer: 2 },
          { id: "crdt", label: "CRDT Sync State", sublabel: "Conflict-free ops", kind: "database", tone: "teal", layer: 3 },
        ],
        edges: [
          { from: "peer_a", to: "signal", label: "offer", dashed: true },
          { from: "peer_b", to: "signal", label: "answer", dashed: true },
          { from: "signal", to: "stun", label: "ICE" },
          { from: "peer_a", to: "channel", label: "direct", bidirectional: true },
          { from: "peer_b", to: "channel", label: "direct", bidirectional: true },
          { from: "channel", to: "crdt", label: "deltas" },
        ],
        groups: [{ id: "grp_hand", label: "Zero-Cost Handshake", nodeIds: ["signal", "stun"] }],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "webrtc_p2p",
    };
  }

  // Auth flow
  if (
    patternHint === "auth_flow" ||
    (/(auth|oauth|login|sso|signup)/.test(lower) && !/(microservice|rag|ai)/.test(lower))
  ) {
    return {
      graph: {
        notation: "architecture",
        summary: "Authentication Flow",
        nodes: [
          { id: "user", label: "User", sublabel: "Browser / App", kind: "actor", tone: "terracotta", layer: 0 },
          { id: "login", label: "Login / OAuth", sublabel: "Identity Provider", kind: "node", tone: "plum", layer: 1 },
          { id: "check", label: "Valid Creds?", sublabel: "Verify + MFA", kind: "diamond", tone: "plum", layer: 2 },
          { id: "jwt", label: "JWT + Session", sublabel: "Signed Cookie", kind: "node", tone: "plum", layer: 3 },
          { id: "err", label: "Retry / Error", sublabel: "401 Unauthorized", kind: "node", tone: "terracotta", layer: 3 },
          { id: "db", label: "User Store", sublabel: "Postgres + Redis", kind: "database", tone: "teal", layer: 4 },
        ],
        edges: [
          { from: "user", to: "login", label: "credentials" },
          { from: "login", to: "check", label: "verify" },
          { from: "check", to: "jwt", label: "Yes" },
          { from: "check", to: "err", label: "No", dashed: true, kind: "fallback" },
          { from: "jwt", to: "db", label: "persist" },
        ],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "auth_flow",
    };
  }

  // AI RAG / Agent
  if (
    patternHint === "ai_rag" ||
    /(rag|llm|ai agent|agentic|chatbot|embedding)/.test(lower)
  ) {
    return {
      graph: {
        notation: "architecture",
        summary: "AI Agent / RAG Pipeline",
        nodes: [
          { id: "user", label: "User Prompt", sublabel: "Natural Language", kind: "ellipse", tone: "terracotta", layer: 0 },
          { id: "router", label: "Intent Router", sublabel: "Classify & Plan", kind: "diamond", tone: "plum", layer: 1 },
          { id: "embed", label: "Vector DB", sublabel: "Semantic Retrieval", kind: "database", tone: "teal", layer: 2 },
          { id: "tools", label: "Tool Executor", sublabel: "APIs & Actions", kind: "node", tone: "cobalt", layer: 2 },
          { id: "llm", label: "Reasoning Model", sublabel: "Context + Tools", kind: "node", tone: "cobalt", layer: 3 },
          { id: "stream", label: "Streaming UI", sublabel: "Live Tokens", kind: "node", tone: "terracotta", layer: 4 },
        ],
        edges: [
          { from: "user", to: "router", label: "query" },
          { from: "router", to: "embed", label: "retrieve" },
          { from: "router", to: "tools", label: "invoke" },
          { from: "embed", to: "llm", label: "chunks" },
          { from: "tools", to: "llm", label: "results" },
          { from: "llm", to: "stream", label: "SSE" },
        ],
        groups: [{ id: "grp_agent", label: "Agent Runtime", nodeIds: ["router", "embed", "tools", "llm"] }],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "ai_rag",
    };
  }

  // Microservices
  if (
    patternHint === "microservices" ||
    /(microservice|e-?commerce|saas|backend|system architecture|distributed)/.test(lower)
  ) {
    return {
      graph: {
        notation: "architecture",
        summary: "Microservices Architecture",
        nodes: [
          { id: "client", label: "Web & Mobile", sublabel: "Clients", kind: "actor", tone: "terracotta", layer: 0 },
          { id: "gw", label: "API Gateway", sublabel: "Auth + Rate Limit", kind: "lb", tone: "cobalt", layer: 1 },
          { id: "auth", label: "Auth Service", sublabel: "Sessions / RBAC", kind: "node", tone: "plum", layer: 2 },
          { id: "core", label: "Core Service", sublabel: "Domain API", kind: "node", tone: "cobalt", layer: 2 },
          { id: "billing", label: "Billing Service", sublabel: "Stripe Webhooks", kind: "node", tone: "cobalt", layer: 2 },
          { id: "cache", label: "Redis Cache", sublabel: "Hot State", kind: "cache", tone: "teal", layer: 3 },
          { id: "queue", label: "Event Bus", sublabel: "Kafka / Async", kind: "queue", tone: "ochre", layer: 3 },
          { id: "db", label: "Postgres DB", sublabel: "Primary Store", kind: "database", tone: "teal", layer: 3 },
        ],
        edges: [
          { from: "client", to: "gw", label: "HTTPS" },
          { from: "gw", to: "auth" },
          { from: "gw", to: "core" },
          { from: "gw", to: "billing" },
          { from: "auth", to: "cache", label: "TTL" },
          { from: "core", to: "db", label: "SQL" },
          { from: "billing", to: "queue", label: "events", dashed: true, kind: "async" },
        ],
        groups: [{ id: "grp_mesh", label: "Service Mesh", nodeIds: ["auth", "core", "billing"] }],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "microservices",
    };
  }

  // CI/CD
  if (
    patternHint === "ci_cd" ||
    /(ci\s*\/?\s*cd|deploy|release pipeline|devops)/.test(lower)
  ) {
    return {
      graph: {
        notation: "flowchart",
        summary: "CI/CD Release Pipeline",
        nodes: [
          { id: "git", label: "Git Push", sublabel: "PR / Branch", kind: "ellipse", tone: "ink", layer: 0 },
          { id: "build", label: "Build & Lint", sublabel: "Typecheck", kind: "node", tone: "cobalt", layer: 1 },
          { id: "test", label: "Tests Pass?", sublabel: "Unit + E2E", kind: "diamond", tone: "plum", layer: 2 },
          { id: "stage", label: "Preview Deploy", sublabel: "Staging URL", kind: "node", tone: "cobalt", layer: 3 },
          { id: "prod", label: "Production", sublabel: "Canary Rollout", kind: "node", tone: "teal", layer: 4 },
        ],
        edges: [
          { from: "git", to: "build", label: "trigger" },
          { from: "build", to: "test", label: "artifacts" },
          { from: "test", to: "stage", label: "Yes" },
          { from: "stage", to: "prod", label: "promote" },
        ],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "ci_cd",
    };
  }

  // Onboarding funnel
  if (
    patternHint === "onboarding_funnel" ||
    /(funnel|onboarding|checkout|journey)/.test(lower)
  ) {
    return {
      graph: {
        notation: "flowchart",
        summary: "User Onboarding Funnel",
        nodes: [
          { id: "s1", label: "Landing Page", sublabel: "100% visitors", kind: "ellipse", tone: "terracotta", layer: 0 },
          { id: "s2", label: "Sign Up", sublabel: "Email / OAuth", kind: "node", tone: "cobalt", layer: 1 },
          { id: "s3", label: "Activated?", sublabel: "First Aha Moment", kind: "diamond", tone: "plum", layer: 2 },
          { id: "s4", label: "Active Workspace", sublabel: "Retained User", kind: "node", tone: "teal", layer: 3 },
          { id: "s5", label: "Nudge Email", sublabel: "Re-engage", kind: "node", tone: "ochre", layer: 3 },
        ],
        edges: [
          { from: "s1", to: "s2", label: "start" },
          { from: "s2", to: "s3", label: "verify" },
          { from: "s3", to: "s4", label: "Yes" },
          { from: "s3", to: "s5", label: "Drop-off", dashed: true, kind: "fallback" },
        ],
      },
      isHeuristic: true,
      confidence: null,
      archetype: "onboarding_funnel",
    };
  }

  // Hub-and-spoke ("X with A, B, and C")
  const withMatch = trimmed.match(/^(.+?)\s+(?:with|using|via|including)\s+(.+)$/i);
  if (withMatch) {
    const hubLabel = cleanSemanticLabel(withMatch[1]);
    const items = withMatch[2]
      .split(/,\s*and\s+|,\s*|\s+and\s+|\s*\+\s*/i)
      .map((s) => cleanSemanticLabel(s))
      .filter((s) => s.length > 0 && s.length < 48);

    if (hubLabel && items.length >= 2) {
      const hubId = slugKey(hubLabel);
      const nodes: SemanticNode[] = [
        {
          id: hubId,
          label: hubLabel,
          kind: inferSemanticKind(hubLabel),
          tone: inferToneFromLabel(hubLabel),
          layer: 0,
        },
      ];
      const edges: SemanticEdge[] = [];
      items.forEach((item, idx) => {
        const kind = inferSemanticKind(item);
        const layer = DATA_TIER_KINDS.has(kind) ? 2 : 1;
        const id = `${slugKey(item)}_${idx}`;
        nodes.push({
          id,
          label: item,
          kind,
          tone: inferToneFromLabel(item),
          layer,
        });
        if (layer === 1) {
          edges.push({ from: hubId, to: id });
        }
      });

      const layer1 = nodes.filter((n) => n.layer === 1);
      const layer2 = nodes.filter((n) => n.layer === 2);
      if (layer1.length > 0 && layer2.length > 0) {
        for (const l2 of layer2) {
          edges.push({ from: layer1[layer1.length - 1].id, to: l2.id });
        }
      } else if (layer1.length === 0) {
        for (const l2 of layer2) {
          edges.push({ from: hubId, to: l2.id });
        }
      }
      return {
        graph: {
          notation: "architecture",
          summary: hubLabel,
          nodes,
          edges,
        },
        isHeuristic: true,
        confidence: null,
        archetype: "custom_flow",
      };
    }
  }

  // Sequential split ("then", "to", "into", commas)
  const parts = trimmed
    .split(
      /\s*(?:,\s*then\s+|,\s*|\s+then\s+|\s+into\s+|\s+feeds\s+|\s+calls\s+|\s+connects to\s+|\s+to\s+)\s*/i
    )
    .map((s) => cleanSemanticLabel(s))
    .filter((s) => s.length > 0 && s.length < 56);

  if (parts.length >= 2) {
    const nodes: SemanticNode[] = parts.map((p, idx) => ({
      id: `${slugKey(p)}_${idx}`,
      label: p,
      kind: inferSemanticKind(p),
      tone: inferToneFromLabel(p),
      layer: idx,
    }));
    const edges: SemanticEdge[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
    }
    return {
      graph: {
        notation: "architecture",
        summary: `${nodes[0].label} → ${nodes[nodes.length - 1].label}`,
        nodes,
        edges,
      },
      isHeuristic: true,
      confidence: null,
      archetype: "custom_flow",
    };
  }

  // Single concept fallback
  const singleLabel = cleanSemanticLabel(trimmed) || "Component";
  return {
    graph: {
      notation: "architecture",
      summary: singleLabel,
      nodes: [
        {
          id: slugKey(singleLabel),
          label: singleLabel,
          kind: inferSemanticKind(singleLabel),
          tone: inferToneFromLabel(singleLabel),
          layer: 0,
        },
      ],
      edges: [],
    },
    isHeuristic: true,
    confidence: null,
    archetype: "custom_flow",
  };
}
