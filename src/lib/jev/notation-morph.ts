import { z } from "zod";
import { inferToneFromLabel } from "./colors";
import { extractSelectedSubgraph } from "./fork-engine";
import {
  computeBounds,
  getElementRect,
  isShapeElement,
  makeSeed,
  Rect,
  rectsOverlap,
  uid,
} from "./geometry";
import { hasForbiddenObjectKeys } from "./semantic-graph";
import {
  MAX_MORPH_SNAPSHOT_ELEMENTS,
  MAX_MORPH_SNAPSHOT_POINTS,
} from "./sync-validation";
import type {
  ColorTone,
  ElementMorphMeta,
  JevElement,
  MorphActorSpec,
  MorphEntitySpec,
  MorphGroupRecord,
  MorphMessageSpec,
  MorphNotation,
  MorphRelationSpec,
  MorphSemanticSpec,
  MorphStateSpec,
  MorphStepSpec,
  MorphTransitionSpec,
  Point,
  SketchSnapshotElement,
} from "./types";

export type { MorphNotation, MorphSemanticSpec, MorphGroupRecord };

export const ALL_MORPH_NOTATIONS: readonly MorphNotation[] = [
  "sketch",
  "sequence",
  "flowchart",
  "state",
  "er",
] as const;

export const MORPH_NOTATION_LABELS: Record<MorphNotation, string> = {
  sketch: "Sketch",
  sequence: "Sequence",
  flowchart: "Flowchart",
  state: "State",
  er: "ER",
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(value: string): boolean {
  return !FORBIDDEN_KEYS.has(value);
}

const safeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .refine(isSafeKey, "Unsafe identifier");

const colorToneSchema = z.enum([
  "ink",
  "terracotta",
  "cobalt",
  "teal",
  "ochre",
  "plum",
  "slate",
]);

export const morphNotationSchema = z.enum([
  "sketch",
  "sequence",
  "flowchart",
  "state",
  "er",
]);

export const morphSemanticSpecSchema = z.object({
  summary: z.string().trim().min(1).max(160),
  actors: z
    .array(
      z.object({
        id: safeIdSchema,
        label: z.string().trim().min(1).max(160),
        kind: z
          .enum(["node", "diamond", "database", "ellipse", "text"])
          .optional(),
        tone: colorToneSchema.optional(),
      })
    )
    .max(32),
  messages: z
    .array(
      z.object({
        id: safeIdSchema,
        from: safeIdSchema,
        to: safeIdSchema,
        label: z.string().trim().min(1).max(140),
        order: z.number().int().min(0).max(200),
        async: z.boolean().optional(),
        isReturn: z.boolean().optional(),
      })
    )
    .max(48),
  steps: z
    .array(
      z.object({
        id: safeIdSchema,
        label: z.string().trim().min(1).max(160),
        kind: z.enum(["start", "process", "decision", "end"]),
        tone: colorToneSchema.optional(),
        branches: z
          .array(
            z.object({
              to: safeIdSchema,
              label: z.string().trim().max(80).optional(),
              fallback: z.boolean().optional(),
            })
          )
          .max(8)
          .optional(),
      })
    )
    .max(40),
  states: z
    .array(
      z.object({
        id: safeIdSchema,
        label: z.string().trim().min(1).max(140),
        initial: z.boolean().optional(),
        terminal: z.boolean().optional(),
        tone: colorToneSchema.optional(),
      })
    )
    .max(32),
  transitions: z
    .array(
      z.object({
        id: safeIdSchema,
        from: safeIdSchema,
        to: safeIdSchema,
        event: z.string().trim().min(1).max(100),
        fallback: z.boolean().optional(),
      })
    )
    .max(48),
  entities: z
    .array(
      z.object({
        id: safeIdSchema,
        name: z.string().trim().min(1).max(120),
        attributes: z.array(z.string().trim().min(1).max(120)).max(16),
        tone: colorToneSchema.optional(),
      })
    )
    .max(24),
  relations: z
    .array(
      z.object({
        id: safeIdSchema,
        from: safeIdSchema,
        to: safeIdSchema,
        cardinality: z.string().trim().min(1).max(24),
        label: z.string().trim().max(80).optional(),
      })
    )
    .max(48),
});

export function validateMorphSemanticSpec(
  raw: unknown
): { ok: true; spec: MorphSemanticSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || hasForbiddenObjectKeys(raw)) {
    return { ok: false, error: "Invalid or unsafe morph semantic spec" };
  }
  const parsed = morphSemanticSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? "Morph semantic spec schema mismatch",
    };
  }
  return { ok: true, spec: parsed.data };
}

export interface SelectionMorphState {
  notation: MorphNotation;
  groupId: string | null;
  groupElements: JevElement[];
  groupRecord: MorphGroupRecord | null;
}

export interface MorphOperationResult {
  groupId: string;
  notation: MorphNotation;
  spec: MorphSemanticSpec;
  replacedIds: string[];
  addedElements: JevElement[];
  nextSelectedIds: string[];
  entryElementId: string;
  exitElementId: string;
  isHeuristic: boolean;
}

/**
 * Inspects the current selection to detect if it belongs to an existing reversible
 * Notation Morph group, returning its active notation, full member list, and shared record.
 */
export function detectSelectionMorphState(
  selectedIds: string[],
  allElements: JevElement[]
): SelectionMorphState {
  if (selectedIds.length === 0 || allElements.length === 0) {
    return {
      notation: "sketch",
      groupId: null,
      groupElements: [],
      groupRecord: null,
    };
  }

  const selSet = new Set(selectedIds);
  let foundGroupId: string | null = null;
  let foundNotation: MorphNotation = "sketch";

  for (const el of allElements) {
    if (!selSet.has(el.id)) continue;
    if (el.morphMeta?.groupId) {
      foundGroupId = el.morphMeta.groupId;
      foundNotation = el.morphMeta.notation;
      break;
    }
  }

  if (!foundGroupId) {
    return {
      notation: "sketch",
      groupId: null,
      groupElements: [],
      groupRecord: null,
    };
  }

  const groupElements = allElements.filter(
    (e) => e.morphMeta?.groupId === foundGroupId
  );
  const recordHolder = groupElements.find((e) => e.morphMeta?.groupRecord);
  const groupRecord = recordHolder?.morphMeta?.groupRecord ?? null;

  return {
    notation: foundNotation,
    groupId: foundGroupId,
    groupElements,
    groupRecord,
  };
}

function downsamplePoints(points: Point[] | undefined): Point[] | undefined {
  if (!points || points.length === 0) return undefined;
  if (points.length <= MAX_MORPH_SNAPSHOT_POINTS) {
    return points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
  }
  const stride = (points.length - 1) / (MAX_MORPH_SNAPSHOT_POINTS - 1);
  const out: Point[] = [];
  for (let i = 0; i < MAX_MORPH_SNAPSHOT_POINTS; i++) {
    const pt = points[Math.min(points.length - 1, Math.round(i * stride))];
    out.push({ x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 });
  }
  return out;
}

function toEntityName(label: string): string {
  const cleaned = label
    .replace(/\?/g, "")
    .replace(/\b(service|api|server|gateway|db|database|store|cache|queue|check|engine|worker|layer|system)\b/gi, "")
    .trim();
  const base = cleaned || label.replace(/\?/g, "").trim() || "Record";
  return base
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function inferEntityAttributes(
  rawLabel: string,
  entityName: string,
  foreignEntityName?: string
): string[] {
  const l = `${rawLabel} ${entityName}`.toLowerCase();
  const attrs: string[] = ["PK id: uuid"];

  if (foreignEntityName) {
    const fkStem = foreignEntityName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (fkStem && fkStem !== "record") {
      attrs.push(`FK ${fkStem}_id: uuid`);
    }
  }

  if (/(user|account|customer|client|browser|auth|member)/.test(l)) {
    attrs.push("email: text", "role: text", "created_at: ts");
  } else if (/(order|checkout|cart|invoice|payment|billing|ledger)/.test(l)) {
    attrs.push("status: enum", "amount_cents: int", "created_at: ts");
  } else if (/(stock|inventory|item|product|catalog)/.test(l)) {
    attrs.push("sku: text", "qty_available: int", "updated_at: ts");
  } else if (/(cache|redis|session|token|jwt)/.test(l)) {
    attrs.push("cache_key: text", "ttl_seconds: int", "expires_at: ts");
  } else if (/(event|queue|kafka|message|job|worker|webhook)/.test(l)) {
    attrs.push("topic: text", "payload: jsonb", "processed_at: ts");
  } else {
    attrs.push("status: text", "payload: jsonb", "updated_at: ts");
  }

  return attrs.slice(0, 5);
}

function inferEdgeVerb(fromLabel: string, toLabel: string, rawLabel?: string): string {
  if (rawLabel && rawLabel.trim().length > 0) return rawLabel.trim();
  const toL = toLabel.toLowerCase();
  if (/(db|database|postgres|mysql|mongo|store|ledger|replica)/.test(toL)) {
    return "persist";
  }
  if (/(cache|redis)/.test(toL)) return "lookup";
  if (/(queue|kafka|event|bus|topic|worker)/.test(toL)) return "publish";
  if (/(\?|check|valid|stock|auth|verify|guard|gate)/.test(toL)) return "validate";
  return `call ${toLabel.split(/\s+/)[0] || "next"}`.slice(0, 28);
}

function inferCardinality(fromLabel: string, toLabel: string, edgeLabel?: string): string {
  const combined = `${fromLabel} ${toLabel} ${edgeLabel ?? ""}`.toLowerCase();
  if (/(tag|role|group|permission|many|link|join|mesh)/.test(combined)) {
    return "N:M";
  }
  if (/(profile|session|token|config|setting|check|auth)/.test(combined)) {
    return "1:1";
  }
  return "1:N";
}

function isDecisionShape(el: JevElement): boolean {
  return (
    el.kind === "diamond" ||
    /(\?|\bcheck\b|\bvalid|\bin stock|\bapproved|\bauthorized|\bhit\b|\bif\b)/i.test(
      el.label
    )
  );
}

function isStartLikeShape(el: JevElement): boolean {
  return (
    el.kind === "ellipse" &&
    /^(start|begin|user|client|browser|customer|visitor)$/i.test(el.label.trim())
  );
}

function topoOrderShapes(
  shapes: JevElement[],
  internalArrows: JevElement[]
): JevElement[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const inDeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const s of shapes) {
    inDeg.set(s.id, 0);
    out.set(s.id, []);
  }
  for (const a of internalArrows) {
    if (a.fromId && a.toId && byId.has(a.fromId) && byId.has(a.toId) && a.fromId !== a.toId) {
      out.get(a.fromId)!.push(a.toId);
      inDeg.set(a.toId, (inDeg.get(a.toId) ?? 0) + 1);
    }
  }

  const ordered: JevElement[] = [];
  const visited = new Set<string>();
  const sortGeo = (a: JevElement, b: JevElement) => a.x - b.x || a.y - b.y;
  const queue = shapes
    .filter((s) => (inDeg.get(s.id) ?? 0) === 0)
    .sort(sortGeo);

  while (ordered.length < shapes.length) {
    if (queue.length === 0) {
      const remaining = shapes.filter((s) => !visited.has(s.id)).sort(sortGeo);
      if (remaining.length === 0) break;
      queue.push(remaining[0]);
    }
    const curr = queue.shift()!;
    if (visited.has(curr.id)) continue;
    visited.add(curr.id);
    ordered.push(curr);

    const nextIds = out.get(curr.id) ?? [];
    for (const nid of nextIds) {
      if (visited.has(nid)) continue;
      const d = (inDeg.get(nid) ?? 1) - 1;
      inDeg.set(nid, d);
      if (d <= 0) {
        const nextEl = byId.get(nid);
        if (nextEl) {
          queue.push(nextEl);
          queue.sort(sortGeo);
        }
      }
    }
  }
  return ordered;
}

function extractSelectionWithSemanticIds(
  selectedIds: string[],
  allElements: JevElement[]
): {
  orderedShapes: JevElement[];
  selectedFrames: JevElement[];
  internalArrows: JevElement[];
  incomingExternal: JevElement[];
  outgoingExternal: JevElement[];
  replacedIds: string[];
  bounds: Rect;
  idToSemId: Map<string, string>;
  entryNode: JevElement;
  exitNode: JevElement;
} | null {
  const subgraph = extractSelectedSubgraph(selectedIds, allElements);
  if (!subgraph) return null;

  const orderedShapes = topoOrderShapes(
    subgraph.selectedShapes,
    subgraph.internalArrows
  );
  const idToSemId = new Map<string, string>();
  orderedShapes.forEach((shape, idx) => {
    idToSemId.set(shape.id, shape.morphMeta?.semanticId ?? `sem_${idx}`);
  });

  return {
    orderedShapes,
    selectedFrames: subgraph.selectedFrames,
    internalArrows: subgraph.internalArrows,
    incomingExternal: subgraph.incomingExternal,
    outgoingExternal: subgraph.outgoingExternal,
    replacedIds: subgraph.replacedIds,
    bounds: subgraph.bounds,
    idToSemId,
    entryNode: orderedShapes[0] ?? subgraph.entryNode,
    exitNode: orderedShapes[orderedShapes.length - 1] ?? subgraph.exitNode,
  };
}

/**
 * Deterministically extracts a complete, shared MorphSemanticSpec covering
 * Sequence (actors/messages), Flowchart (steps/decisions), State (states/transitions),
 * and ER (entities/relations) from any 1+ selected canvas elements.
 */
export function extractMorphSemanticSpec(
  selectedIds: string[],
  allElements: JevElement[]
): MorphSemanticSpec | null {
  const extracted = extractSelectionWithSemanticIds(selectedIds, allElements);
  if (!extracted) return null;

  const { orderedShapes, internalArrows, idToSemId } = extracted;
  const bySemId = new Map<string, JevElement>();
  for (const s of orderedShapes) {
    bySemId.set(idToSemId.get(s.id)!, s);
  }

  // Normalized internal edges (chain disconnected selections in topological order)
  const normEdges: Array<{
    from: string;
    to: string;
    label: string;
    dashed?: boolean;
  }> = [];

  for (const arr of internalArrows) {
    if (!arr.fromId || !arr.toId) continue;
    const from = idToSemId.get(arr.fromId);
    const to = idToSemId.get(arr.toId);
    if (!from || !to || from === to) continue;
    const fromEl = bySemId.get(from)!;
    const toEl = bySemId.get(to)!;
    normEdges.push({
      from,
      to,
      label: inferEdgeVerb(fromEl.label, toEl.label, arr.label),
      dashed: arr.dashed,
    });
  }

  if (normEdges.length === 0 && orderedShapes.length > 1) {
    for (let i = 0; i < orderedShapes.length - 1; i++) {
      const fromEl = orderedShapes[i];
      const toEl = orderedShapes[i + 1];
      normEdges.push({
        from: idToSemId.get(fromEl.id)!,
        to: idToSemId.get(toEl.id)!,
        label: inferEdgeVerb(fromEl.label, toEl.label),
      });
    }
  }

  const summary =
    orderedShapes.length === 1
      ? orderedShapes[0].label || "Diagram"
      : `${orderedShapes[0].label} → ${orderedShapes[orderedShapes.length - 1].label}`;

  // 1) SEQUENCE: actors & messages
  const actors: MorphActorSpec[] = [];
  const messages: MorphMessageSpec[] = [];

  if (orderedShapes.length === 1) {
    const sole = orderedShapes[0];
    const soleSemId = idToSemId.get(sole.id)!;
    actors.push(
      { id: "seq_client", label: "Client", kind: "ellipse", tone: "terracotta" },
      {
        id: soleSemId,
        label: sole.label || "Service",
        kind: sole.kind === "frame" || sole.kind === "arrow" || sole.kind === "freedraw" ? "node" : sole.kind,
        tone: sole.tone,
      }
    );
    messages.push(
      {
        id: "msg_1",
        from: "seq_client",
        to: soleSemId,
        label: `request ${sole.label || "service"}`.slice(0, 48),
        order: 1,
      },
      {
        id: "msg_2",
        from: soleSemId,
        to: "seq_client",
        label: "200 OK",
        order: 2,
        isReturn: true,
      }
    );
  } else {
    for (const s of orderedShapes) {
      const semId = idToSemId.get(s.id)!;
      actors.push({
        id: semId,
        label: s.label || "Actor",
        kind:
          s.kind === "frame" || s.kind === "arrow" || s.kind === "freedraw"
            ? "node"
            : s.kind,
        tone: s.tone,
      });
    }
    normEdges.forEach((edge, idx) => {
      messages.push({
        id: `msg_${idx + 1}`,
        from: edge.from,
        to: edge.to,
        label: edge.label,
        order: idx + 1,
        async: edge.dashed,
      });
    });
    // Add natural return ack from final actor back to first actor for unmistakable sequence feel
    const firstActor = actors[0];
    const lastActor = actors[actors.length - 1];
    if (firstActor && lastActor && firstActor.id !== lastActor.id) {
      messages.push({
        id: `msg_${messages.length + 1}`,
        from: lastActor.id,
        to: firstActor.id,
        label: "ack / result",
        order: messages.length + 1,
        isReturn: true,
      });
    }
  }

  // 2) FLOWCHART: start pill, process boxes, decision diamonds (Yes/No), end pill
  const steps: MorphStepSpec[] = [];
  const startId = "flow_start";
  const endId = "flow_end";
  const firstIsStart =
    orderedShapes.length > 0 && isStartLikeShape(orderedShapes[0]);

  if (!firstIsStart) {
    steps.push({
      id: startId,
      label: "Start",
      kind: "start",
      tone: "teal",
      branches: orderedShapes[0]
        ? [{ to: idToSemId.get(orderedShapes[0].id)! }]
        : [{ to: endId }],
    });
  }

  const outgoingBySem = new Map<string, typeof normEdges>();
  for (const e of normEdges) {
    const arr = outgoingBySem.get(e.from) ?? [];
    arr.push(e);
    outgoingBySem.set(e.from, arr);
  }

  let hasDecisionStep = false;
  orderedShapes.forEach((shape, idx) => {
    const semId = idToSemId.get(shape.id)!;
    const outEdges = outgoingBySem.get(semId) ?? [];
    const decision = isDecisionShape(shape) || outEdges.length >= 2;
    if (decision) hasDecisionStep = true;

    const nextDefaultId =
      idx + 1 < orderedShapes.length
        ? idToSemId.get(orderedShapes[idx + 1].id)!
        : endId;

    const branches: NonNullable<MorphStepSpec["branches"]> = [];
    if (outEdges.length > 0) {
      outEdges.forEach((oe, bIdx) => {
        const isFallback =
          Boolean(oe.dashed) ||
          /^(no|fail|error|retry|reject|miss|fallback)$/i.test(oe.label);
        branches.push({
          to: oe.to,
          label: decision
            ? oe.label || (bIdx === 0 ? "Yes" : "No")
            : oe.label,
          fallback: isFallback,
        });
      });
    } else {
      branches.push({
        to: nextDefaultId,
        ...(decision ? { label: "Yes" } : {}),
      });
    }

    if (decision && !branches.some((b) => b.fallback || /^no$/i.test(b.label ?? ""))) {
      const retryId = `flow_retry_${idx}`;
      steps.push({
        id: semId,
        label: shape.label.endsWith("?") ? shape.label : `${shape.label}?`,
        kind: "decision",
        tone: "plum",
        branches: [
          ...branches.map((b, i) => ({
            ...b,
            label: b.label || (i === 0 ? "Yes" : "Next"),
          })),
          { to: retryId, label: "No", fallback: true },
        ],
      });
      steps.push({
        id: retryId,
        label: "Handle Error",
        kind: "process",
        tone: "terracotta",
        branches: [{ to: endId, label: "abort", fallback: true }],
      });
      return;
    }

    steps.push({
      id: semId,
      label: shape.label || `Step ${idx + 1}`,
      kind: idx === 0 && firstIsStart ? "start" : decision ? "decision" : "process",
      tone: decision ? "plum" : shape.tone,
      branches,
    });
  });

  // If no decision existed in a multi-step flow, keep it crisp; if single node, add a validation diamond
  if (!hasDecisionStep && orderedShapes.length === 1) {
    const soleSemId = idToSemId.get(orderedShapes[0].id)!;
    const soleStep = steps.find((s) => s.id === soleSemId);
    if (soleStep) {
      soleStep.branches = [{ to: "flow_valid" }];
      steps.push(
        {
          id: "flow_valid",
          label: "Success?",
          kind: "decision",
          tone: "plum",
          branches: [
            { to: endId, label: "Yes" },
            { to: "flow_retry", label: "No", fallback: true },
          ],
        },
        {
          id: "flow_retry",
          label: "Retry / Fallback",
          kind: "process",
          tone: "terracotta",
          branches: [{ to: endId, label: "done", fallback: true }],
        }
      );
    }
  }

  steps.push({
    id: endId,
    label: "Done",
    kind: "end",
    tone: "slate",
  });

  // 3) STATE MACHINE: states & event transitions
  const states: MorphStateSpec[] = [];
  const transitions: MorphTransitionSpec[] = [];

  if (orderedShapes.length === 1) {
    const sole = orderedShapes[0];
    const soleSemId = idToSemId.get(sole.id)!;
    states.push(
      { id: soleSemId, label: sole.label || "Idle", initial: true, tone: sole.tone },
      { id: "st_processing", label: "Processing", tone: "cobalt" },
      { id: "st_completed", label: "Completed", terminal: true, tone: "teal" }
    );
    transitions.push(
      { id: "tr_1", from: soleSemId, to: "st_processing", event: "start" },
      { id: "tr_2", from: "st_processing", to: "st_completed", event: "succeed" },
      { id: "tr_3", from: "st_processing", to: soleSemId, event: "retry", fallback: true }
    );
  } else {
    orderedShapes.forEach((shape, idx) => {
      const semId = idToSemId.get(shape.id)!;
      states.push({
        id: semId,
        label: shape.label.replace(/\?$/, "") || `State ${idx + 1}`,
        initial: idx === 0,
        terminal: idx === orderedShapes.length - 1,
        tone: shape.tone,
      });
    });

    normEdges.forEach((edge, idx) => {
      const isFallback =
        Boolean(edge.dashed) ||
        /^(no|fail|error|retry|miss|fallback)$/i.test(edge.label);
      transitions.push({
        id: `tr_${idx + 1}`,
        from: edge.from,
        to: edge.to,
        event: edge.label || `on_step_${idx + 1}`,
        ...(isFallback ? { fallback: true } : {}),
      });
    });
  }

  // 4) ER DIAGRAM: entities with PK/FK attributes & cardinality-labeled relations
  const entities: MorphEntitySpec[] = [];
  const relations: MorphRelationSpec[] = [];

  const entitySourceShapes = orderedShapes.filter((s) => !isDecisionShape(s));
  const effectiveEntityShapes =
    entitySourceShapes.length > 0 ? entitySourceShapes : orderedShapes;

  const parentEntityNameBySemId = new Map<string, string>();
  const entitySemIdSet = new Set(
    effectiveEntityShapes.map((s) => idToSemId.get(s.id)!)
  );

  // Map entity names first
  const entityNameBySemId = new Map<string, string>();
  for (const s of effectiveEntityShapes) {
    const semId = idToSemId.get(s.id)!;
    entityNameBySemId.set(semId, toEntityName(s.label));
  }

  // Collapse edges through skipped decision diamonds so ER entities stay connected
  const collapsedRelations: Array<{ from: string; to: string; label?: string }> = [];
  for (const edge of normEdges) {
    if (entitySemIdSet.has(edge.from) && entitySemIdSet.has(edge.to)) {
      collapsedRelations.push({ from: edge.from, to: edge.to, label: edge.label });
    } else if (entitySemIdSet.has(edge.from) && !entitySemIdSet.has(edge.to)) {
      // Follow 1 hop through decision node
      const nextHops = normEdges.filter((n) => n.from === edge.to);
      for (const nh of nextHops) {
        if (entitySemIdSet.has(nh.to) && nh.to !== edge.from) {
          collapsedRelations.push({
            from: edge.from,
            to: nh.to,
            label: edge.label || nh.label,
          });
        }
      }
    }
  }

  if (collapsedRelations.length === 0 && effectiveEntityShapes.length > 1) {
    for (let i = 0; i < effectiveEntityShapes.length - 1; i++) {
      collapsedRelations.push({
        from: idToSemId.get(effectiveEntityShapes[i].id)!,
        to: idToSemId.get(effectiveEntityShapes[i + 1].id)!,
        label: "links",
      });
    }
  }

  for (const rel of collapsedRelations) {
    if (!parentEntityNameBySemId.has(rel.to)) {
      const parentName = entityNameBySemId.get(rel.from);
      if (parentName) parentEntityNameBySemId.set(rel.to, parentName);
    }
  }

  for (const s of effectiveEntityShapes) {
    const semId = idToSemId.get(s.id)!;
    const name = entityNameBySemId.get(semId) ?? toEntityName(s.label);
    entities.push({
      id: semId,
      name,
      attributes: inferEntityAttributes(
        s.label,
        name,
        parentEntityNameBySemId.get(semId)
      ),
      tone: s.tone === "slate" ? "cobalt" : s.tone,
    });
  }

  if (entities.length === 1) {
    const primary = entities[0];
    const childId = "er_child_event";
    const childName = `${primary.name.split(/\s+/)[0] || "Domain"} Record`;
    entities.push({
      id: childId,
      name: childName,
      attributes: inferEntityAttributes(childName, childName, primary.name),
      tone: "teal",
    });
    relations.push({
      id: "rel_1",
      from: primary.id,
      to: childId,
      cardinality: "1:N",
      label: "owns",
    });
  } else {
    const seenRel = new Set<string>();
    collapsedRelations.forEach((r, idx) => {
      const key = `${r.from}->${r.to}`;
      if (seenRel.has(key) || r.from === r.to) return;
      seenRel.add(key);
      const fromName = entityNameBySemId.get(r.from) ?? "";
      const toName = entityNameBySemId.get(r.to) ?? "";
      relations.push({
        id: `rel_${idx + 1}`,
        from: r.from,
        to: r.to,
        cardinality: inferCardinality(fromName, toName, r.label),
        ...(r.label ? { label: r.label } : {}),
      });
    });
  }

  return {
    summary,
    actors,
    messages,
    steps,
    states,
    transitions,
    entities,
    relations,
  };
}

function getExpectedLabelForNotation(
  record: MorphGroupRecord,
  notation: MorphNotation,
  semId: string
): string | null {
  if (notation === "sequence") {
    return record.spec.actors.find((a) => a.id === semId)?.label ?? null;
  }
  if (notation === "flowchart") {
    return record.spec.steps.find((s) => s.id === semId)?.label ?? null;
  }
  if (notation === "state") {
    return record.spec.states.find((s) => s.id === semId)?.label ?? null;
  }
  if (notation === "er") {
    return record.spec.entities.find((e) => e.id === semId)?.name ?? null;
  }
  return record.sketchSnapshot.find((s) => s.semanticId === semId)?.label ?? null;
}

function syncEditedLabelsIntoGroupRecord(
  groupElements: JevElement[],
  record: MorphGroupRecord
): MorphGroupRecord {
  const editedBySemId = new Map<string, string>();
  for (const el of groupElements) {
    const semId = el.morphMeta?.semanticId;
    const notation = el.morphMeta?.notation;
    if (!semId || !notation || !isShapeElement(el)) continue;
    const trimmed = el.label.trim();
    if (!trimmed) continue;
    const expected = getExpectedLabelForNotation(record, notation, semId);
    if (expected !== null && trimmed === expected.trim()) {
      continue;
    }
    editedBySemId.set(semId, trimmed);
  }
  if (editedBySemId.size === 0) return record;

  const updatedSpec: MorphSemanticSpec = {
    ...record.spec,
    actors: record.spec.actors.map((a) =>
      editedBySemId.has(a.id) ? { ...a, label: editedBySemId.get(a.id)! } : a
    ),
    steps: record.spec.steps.map((s) =>
      editedBySemId.has(s.id) ? { ...s, label: editedBySemId.get(s.id)! } : s
    ),
    states: record.spec.states.map((s) =>
      editedBySemId.has(s.id) ? { ...s, label: editedBySemId.get(s.id)! } : s
    ),
    entities: record.spec.entities.map((e) =>
      editedBySemId.has(e.id) ? { ...e, name: editedBySemId.get(e.id)! } : e
    ),
  };

  const updatedSnapshot = record.sketchSnapshot.map((item) => {
    if (item.semanticId && editedBySemId.has(item.semanticId)) {
      return { ...item, label: editedBySemId.get(item.semanticId)! };
    }
    return item;
  });

  return {
    ...record,
    spec: updatedSpec,
    sketchSnapshot: updatedSnapshot,
  };
}

function resolveShapeOverlaps(shapes: JevElement[], minGap = 20): void {
  for (let pass = 0; pass < 14; pass++) {
    let moved = false;
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i];
        const b = shapes[j];
        if (rectsOverlap(getElementRect(a), getElementRect(b), minGap)) {
          const targetY = Math.round(a.y + a.height + minGap + 8);
          if (b.y < targetY) {
            b.y = targetY;
          } else {
            b.x = Math.round(a.x + a.width + minGap + 8);
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

function shiftElementsToAnchorCenter(
  elements: JevElement[],
  anchorBounds: Rect
): void {
  const shapes = elements.filter((e) => isShapeElement(e));
  const curBounds = computeBounds(shapes.length > 0 ? shapes : elements);
  if (!curBounds) return;
  const targetCx = anchorBounds.x + anchorBounds.width / 2;
  const targetCy = anchorBounds.y + anchorBounds.height / 2;
  const curCx = curBounds.x + curBounds.width / 2;
  const curCy = curBounds.y + curBounds.height / 2;
  const dx = Math.round(targetCx - curCx);
  const dy = Math.round(targetCy - curCy);

  for (const el of elements) {
    if (el.kind === "arrow") {
      if (el.fromPoint) {
        el.fromPoint = { x: el.fromPoint.x + dx, y: el.fromPoint.y + dy };
      }
      if (el.toPoint) {
        el.toPoint = { x: el.toPoint.x + dx, y: el.toPoint.y + dy };
      }
      if (!el.fromId && !el.toId) {
        el.x += dx;
        el.y += dy;
      }
    } else if (el.kind === "freedraw" && el.points) {
      el.x += dx;
      el.y += dy;
      el.points = el.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      el.x += dx;
      el.y += dy;
    }
  }
}

function layoutSequenceNotation(
  spec: MorphSemanticSpec,
  groupId: string,
  anchorBounds: Rect,
  now: number
): { elements: JevElement[]; entryId: string; exitId: string; selectableIds: string[] } {
  const actors =
    spec.actors.length > 0
      ? spec.actors
      : [{ id: "act_0", label: "Service", kind: "node" as const, tone: "cobalt" as ColorTone }];

  const actorW = 156;
  const actorH = 54;
  const colSpacing = 224;

  const actorEls: JevElement[] = [];
  const actorCenterX = new Map<string, number>();

  actors.forEach((actor, idx) => {
    const id = uid("mseq");
    const x = idx * colSpacing;
    const y = 0;
    const el: JevElement = {
      id,
      kind: "node",
      x,
      y,
      width: actorW,
      height: actorH,
      label: actor.label,
      tone: actor.tone ?? inferToneFromLabel(actor.label),
      seed: makeSeed(id),
      morphMeta: {
        groupId,
        notation: "sequence",
        semanticId: actor.id,
        role: "actor",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    actorEls.push(el);
    actorCenterX.set(actor.id, x + actorW / 2);
  });

  const orderedMsgs = [...spec.messages]
    .filter((m) => actorCenterX.has(m.from) && actorCenterX.has(m.to) && m.from !== m.to)
    .sort((a, b) => a.order - b.order);

  const msgStartY = actorH + 46;
  const msgStepY = 54;
  const lifelineBottomY = msgStartY + Math.max(1, orderedMsgs.length) * msgStepY + 20;

  const lifelineEls: JevElement[] = actors.map((actor) => {
    const cx = actorCenterX.get(actor.id)!;
    const id = uid("mlife");
    return {
      id,
      kind: "arrow",
      x: cx,
      y: actorH + 4,
      width: 0,
      height: lifelineBottomY - (actorH + 4),
      fromPoint: { x: cx, y: actorH + 4 },
      toPoint: { x: cx, y: lifelineBottomY },
      label: "",
      tone: "slate",
      seed: makeSeed(id),
      arrowStyle: "straight",
      dashed: true,
      morphMeta: {
        groupId,
        notation: "sequence",
        semanticId: actor.id,
        role: "lifeline",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
  });

  const messageEls: JevElement[] = orderedMsgs.map((msg, idx) => {
    const fromX = actorCenterX.get(msg.from)!;
    const toX = actorCenterX.get(msg.to)!;
    const y = msgStartY + idx * msgStepY;
    const id = uid("mmsg");
    const isDashed = Boolean(msg.async || msg.isReturn);
    return {
      id,
      kind: "arrow",
      x: fromX,
      y,
      width: toX - fromX,
      height: 0,
      fromPoint: { x: fromX, y },
      toPoint: { x: toX, y },
      label: `${idx + 1}. ${msg.label}`,
      tone: msg.isReturn ? "slate" : msg.async ? "ochre" : "cobalt",
      seed: makeSeed(id),
      arrowStyle: "straight",
      ...(isDashed ? { dashed: true } : {}),
      morphMeta: {
        groupId,
        notation: "sequence",
        semanticId: msg.id,
        role: "message",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
  });

  const all = [...lifelineEls, ...actorEls, ...messageEls];
  shiftElementsToAnchorCenter(all, anchorBounds);

  return {
    elements: all,
    entryId: actorEls[0].id,
    exitId: actorEls[actorEls.length - 1].id,
    selectableIds: actorEls.map((e) => e.id),
  };
}

function layoutFlowchartNotation(
  spec: MorphSemanticSpec,
  groupId: string,
  anchorBounds: Rect,
  now: number
): { elements: JevElement[]; entryId: string; exitId: string; selectableIds: string[] } {
  const steps =
    spec.steps.length > 0
      ? spec.steps
      : [
          { id: "fs", label: "Start", kind: "start" as const, branches: [{ to: "fe" }] },
          { id: "fe", label: "Done", kind: "end" as const },
        ];

  // Identify fallback branch targets so they lay out cleanly to the right column
  const fallbackTargets = new Set<string>();
  for (const s of steps) {
    for (const b of s.branches ?? []) {
      if (b.fallback && b.to !== "flow_end") {
        fallbackTargets.add(b.to);
      }
    }
  }

  const shapeEls: JevElement[] = [];
  const stepIdToElId = new Map<string, string>();
  const rowYByStepId = new Map<string, number>();

  let mainRow = 0;
  for (const step of steps) {
    if (fallbackTargets.has(step.id)) continue;
    const id = uid("mflw");
    const kind =
      step.kind === "start" || step.kind === "end"
        ? "ellipse"
        : step.kind === "decision"
          ? "diamond"
          : "node";
    const width =
      kind === "ellipse"
        ? Math.max(126, Math.min(188, step.label.length * 8.5 + 48))
        : kind === "diamond"
          ? Math.max(154, Math.min(204, step.label.length * 8.4 + 54))
          : Math.max(166, Math.min(220, step.label.length * 8.5 + 48));
    const height = kind === "diamond" ? 96 : kind === "ellipse" ? 56 : 68;
    const x = Math.round(-width / 2);
    const y = mainRow * 128;

    const el: JevElement = {
      id,
      kind,
      x,
      y,
      width: Math.round(width),
      height,
      label: step.label,
      tone:
        step.tone ??
        (step.kind === "start"
          ? "teal"
          : step.kind === "end"
            ? "slate"
            : step.kind === "decision"
              ? "plum"
              : inferToneFromLabel(step.label)),
      seed: makeSeed(id),
      morphMeta: {
        groupId,
        notation: "flowchart",
        semanticId: step.id,
        role: step.kind === "decision" ? "decision" : "step",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    shapeEls.push(el);
    stepIdToElId.set(step.id, id);
    rowYByStepId.set(step.id, y);
    mainRow += 1;
  }

  // Place fallback side-branch steps neatly to the right of their parent decision
  let fallbackIndex = 0;
  for (const step of steps) {
    if (!fallbackTargets.has(step.id)) continue;
    const parentStep = steps.find((s) =>
      (s.branches ?? []).some((b) => b.to === step.id)
    );
    const parentY = parentStep ? (rowYByStepId.get(parentStep.id) ?? fallbackIndex * 128) : fallbackIndex * 128;
    const id = uid("mflw");
    const width = Math.max(156, Math.min(210, step.label.length * 8.5 + 44));
    const height = 66;
    const el: JevElement = {
      id,
      kind: "node",
      x: 184,
      y: parentY + 14,
      width: Math.round(width),
      height,
      label: step.label,
      tone: step.tone ?? "terracotta",
      seed: makeSeed(id),
      morphMeta: {
        groupId,
        notation: "flowchart",
        semanticId: step.id,
        role: "step",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    shapeEls.push(el);
    stepIdToElId.set(step.id, id);
    fallbackIndex += 1;
  }

  resolveShapeOverlaps(shapeEls, 22);

  const arrowEls: JevElement[] = [];
  const seenEdge = new Set<string>();
  for (const step of steps) {
    const fromReal = stepIdToElId.get(step.id);
    if (!fromReal) continue;
    for (const branch of step.branches ?? []) {
      const toReal = stepIdToElId.get(branch.to);
      if (!toReal || fromReal === toReal) continue;
      const key = `${fromReal}->${toReal}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const arrId = uid("mfa");
      arrowEls.push({
        id: arrId,
        kind: "arrow",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId: fromReal,
        toId: toReal,
        label: branch.label ?? "",
        tone: branch.fallback ? "terracotta" : "ink",
        seed: makeSeed(arrId),
        arrowStyle: "curved",
        ...(branch.fallback ? { dashed: true } : {}),
        morphMeta: {
          groupId,
          notation: "flowchart",
          role: "transition",
        },
        createdAt: now,
        updatedAt: now,
        rev: 1,
      });
    }
  }

  const all = [...shapeEls, ...arrowEls];
  shiftElementsToAnchorCenter(all, anchorBounds);

  return {
    elements: all,
    entryId: shapeEls[0].id,
    exitId: shapeEls[shapeEls.length - 1].id,
    selectableIds: shapeEls.map((e) => e.id),
  };
}

function layoutStateNotation(
  spec: MorphSemanticSpec,
  groupId: string,
  anchorBounds: Rect,
  now: number
): { elements: JevElement[]; entryId: string; exitId: string; selectableIds: string[] } {
  const states =
    spec.states.length > 0
      ? spec.states
      : [{ id: "st_0", label: "Active", initial: true, terminal: true }];

  const shapeEls: JevElement[] = [];
  const stateIdToElId = new Map<string, string>();

  // Initial state indicator
  const initDotId = uid("mst_init");
  const initDot: JevElement = {
    id: initDotId,
    kind: "ellipse",
    x: 0,
    y: 16,
    width: 44,
    height: 44,
    label: "●",
    tone: "ink",
    seed: makeSeed(initDotId),
    morphMeta: {
      groupId,
      notation: "state",
      role: "step",
    },
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  shapeEls.push(initDot);

  const perRow = Math.min(4, Math.max(2, states.length));
  const colGap = 248;
  const rowGap = 152;

  states.forEach((st, idx) => {
    const id = uid("mst");
    const col = idx % perRow;
    const row = Math.floor(idx / perRow);
    const width = Math.max(158, Math.min(212, st.label.length * 8.6 + 48));
    const height = 74;
    const x = 112 + col * colGap;
    const y = row * rowGap;
    const el: JevElement = {
      id,
      kind: "node",
      x,
      y,
      width: Math.round(width),
      height,
      label: st.label,
      sublabel: st.initial
        ? "Initial State"
        : st.terminal
          ? "Terminal State"
          : "State",
      tone:
        st.tone ??
        (st.initial ? "cobalt" : st.terminal ? "teal" : inferToneFromLabel(st.label)),
      seed: makeSeed(id),
      morphMeta: {
        groupId,
        notation: "state",
        semanticId: st.id,
        role: "state",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    shapeEls.push(el);
    stateIdToElId.set(st.id, id);
  });

  // Terminal marker positioned right of the terminal state
  const terminalState =
    states.find((s) => s.terminal) ?? states[states.length - 1];
  const terminalRealEl = shapeEls.find(
    (e) => e.id === stateIdToElId.get(terminalState.id)
  );
  const termDotId = uid("mst_end");
  const termDot: JevElement = {
    id: termDotId,
    kind: "ellipse",
    x: terminalRealEl ? terminalRealEl.x + terminalRealEl.width + 64 : 112 + states.length * colGap,
    y: terminalRealEl ? terminalRealEl.y + 15 : 16,
    width: 44,
    height: 44,
    label: "◉",
    tone: "slate",
    seed: makeSeed(termDotId),
    morphMeta: {
      groupId,
      notation: "state",
      role: "step",
    },
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  shapeEls.push(termDot);

  resolveShapeOverlaps(shapeEls, 24);

  const arrowEls: JevElement[] = [];
  const initialState = states.find((s) => s.initial) ?? states[0];
  const initialRealId = stateIdToElId.get(initialState.id);
  if (initialRealId) {
    const arrId = uid("mtr");
    arrowEls.push({
      id: arrId,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fromId: initDotId,
      toId: initialRealId,
      label: "init",
      tone: "ink",
      seed: makeSeed(arrId),
      arrowStyle: "straight",
      morphMeta: {
        groupId,
        notation: "state",
        role: "transition",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  for (const tr of spec.transitions) {
    const fromReal = stateIdToElId.get(tr.from);
    const toReal = stateIdToElId.get(tr.to);
    if (!fromReal || !toReal || fromReal === toReal) continue;
    const arrId = uid("mtr");
    arrowEls.push({
      id: arrId,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fromId: fromReal,
      toId: toReal,
      label: tr.event,
      tone: tr.fallback ? "terracotta" : "plum",
      seed: makeSeed(arrId),
      arrowStyle: "curved",
      ...(tr.fallback ? { dashed: true } : {}),
      morphMeta: {
        groupId,
        notation: "state",
        semanticId: tr.id,
        role: "transition",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  const terminalRealId = stateIdToElId.get(terminalState.id);
  if (terminalRealId) {
    const arrId = uid("mtr");
    arrowEls.push({
      id: arrId,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fromId: terminalRealId,
      toId: termDotId,
      label: "end",
      tone: "slate",
      seed: makeSeed(arrId),
      arrowStyle: "straight",
      morphMeta: {
        groupId,
        notation: "state",
        role: "transition",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  const all = [...shapeEls, ...arrowEls];
  shiftElementsToAnchorCenter(all, anchorBounds);

  return {
    elements: all,
    entryId: initialRealId ?? initDotId,
    exitId: terminalRealId ?? termDotId,
    selectableIds: shapeEls.map((e) => e.id),
  };
}

function layoutErNotation(
  spec: MorphSemanticSpec,
  groupId: string,
  anchorBounds: Rect,
  now: number
): { elements: JevElement[]; entryId: string; exitId: string; selectableIds: string[] } {
  const entities =
    spec.entities.length > 0
      ? spec.entities
      : [{ id: "ent_0", name: "Entity", attributes: ["PK id: uuid", "created_at: ts"] }];

  const perRow = Math.min(3, Math.max(2, entities.length));
  const colGap = 286;
  const rowGap = 204;

  const entityEls: JevElement[] = [];
  const entityIdToElId = new Map<string, string>();

  entities.forEach((ent, idx) => {
    const id = uid("mer");
    const col = idx % perRow;
    const row = Math.floor(idx / perRow);
    const attrs =
      ent.attributes.length > 0 ? ent.attributes : ["PK id: uuid", "created_at: ts"];
    const maxLineLen = Math.max(
      ent.name.length + 2,
      ...attrs.map((a) => a.length)
    );
    const width = Math.max(204, Math.min(264, Math.round(maxLineLen * 7.6 + 38)));
    const height = Math.max(114, 48 + attrs.length * 20);
    const el: JevElement = {
      id,
      kind: "node",
      x: col * colGap,
      y: row * rowGap,
      width,
      height,
      label: ent.name,
      sublabel: attrs.join("\n"),
      tone: ent.tone ?? inferToneFromLabel(ent.name),
      seed: makeSeed(id),
      morphMeta: {
        groupId,
        notation: "er",
        semanticId: ent.id,
        role: "entity",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    entityEls.push(el);
    entityIdToElId.set(ent.id, id);
  });

  resolveShapeOverlaps(entityEls, 28);

  const relEls: JevElement[] = [];
  for (const rel of spec.relations) {
    const fromReal = entityIdToElId.get(rel.from);
    const toReal = entityIdToElId.get(rel.to);
    if (!fromReal || !toReal || fromReal === toReal) continue;
    const arrId = uid("mrel");
    const card = /(1:N|1:1|N:M|N:1)/.test(rel.cardinality)
      ? rel.cardinality
      : "1:N";
    relEls.push({
      id: arrId,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fromId: fromReal,
      toId: toReal,
      label: rel.label ? `${card} · ${rel.label}` : card,
      tone: "teal",
      seed: makeSeed(arrId),
      arrowStyle: "straight",
      morphMeta: {
        groupId,
        notation: "er",
        semanticId: rel.id,
        role: "relation",
      },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  const all = [...entityEls, ...relEls];
  shiftElementsToAnchorCenter(all, anchorBounds);

  return {
    elements: all,
    entryId: entityEls[0].id,
    exitId: entityEls[entityEls.length - 1].id,
    selectableIds: entityEls.map((e) => e.id),
  };
}

function restoreSketchFromGroupRecord(
  record: MorphGroupRecord,
  now: number
): { elements: JevElement[]; entryId: string; exitId: string; selectableIds: string[] } {
  const restored: JevElement[] = record.sketchSnapshot.map((snap) => ({
    id: snap.id,
    kind: snap.kind,
    x: snap.x,
    y: snap.y,
    width: snap.width,
    height: snap.height,
    label: snap.label,
    ...(snap.sublabel !== undefined ? { sublabel: snap.sublabel } : {}),
    tone: snap.tone,
    seed: snap.seed,
    ...(snap.fromId ? { fromId: snap.fromId } : {}),
    ...(snap.toId ? { toId: snap.toId } : {}),
    ...(snap.fromPoint ? { fromPoint: { ...snap.fromPoint } } : {}),
    ...(snap.toPoint ? { toPoint: { ...snap.toPoint } } : {}),
    ...(snap.arrowStyle ? { arrowStyle: snap.arrowStyle } : {}),
    ...(snap.dashed ? { dashed: true } : {}),
    ...(snap.bidirectional ? { bidirectional: true } : {}),
    ...(snap.points ? { points: snap.points.map((p) => ({ ...p })) } : {}),
    morphMeta: {
      groupId: record.groupId,
      notation: "sketch",
      ...(snap.semanticId ? { semanticId: snap.semanticId } : {}),
      role: "sketch_item",
    },
    createdAt: now,
    updatedAt: now,
    rev: 1,
  }));

  const shapeEls = restored.filter((e) => isShapeElement(e) && e.kind !== "frame");
  const entryId =
    (record.entrySketchId &&
      restored.some((e) => e.id === record.entrySketchId) &&
      record.entrySketchId) ||
    shapeEls[0]?.id ||
    restored[0]?.id ||
    "";
  const exitId =
    (record.exitSketchId &&
      restored.some((e) => e.id === record.exitSketchId) &&
      record.exitSketchId) ||
    shapeEls[shapeEls.length - 1]?.id ||
    entryId;

  return {
    elements: restored,
    entryId,
    exitId,
    selectableIds:
      shapeEls.length > 0 ? shapeEls.map((e) => e.id) : restored.map((e) => e.id),
  };
}

/**
 * Morphs the selected elements (or their existing morph group) in place to `targetNotation`,
 * preserving a full reversible `MorphGroupRecord` (including original `sketchSnapshot`)
 * on the anchor element and cleanly rewiring external boundary arrows.
 */
export function morphSelectionToNotation(
  selectedIds: string[],
  allElements: JevElement[],
  targetNotation: MorphNotation,
  opts?: {
    specOverride?: MorphSemanticSpec;
    now?: number;
    isHeuristic?: boolean;
  }
): MorphOperationResult | null {
  if (selectedIds.length === 0 || allElements.length === 0) return null;
  const now = opts?.now ?? Date.now();

  const existing = detectSelectionMorphState(selectedIds, allElements);

  let groupRecord: MorphGroupRecord;
  let replacedIds: string[];
  let incomingExternal: JevElement[];
  let outgoingExternal: JevElement[];

  if (existing.groupId && existing.groupRecord) {
    // Sync any label edits made by the user in the current notation back into the shared spec & sketch snapshot
    groupRecord = syncEditedLabelsIntoGroupRecord(
      existing.groupElements,
      existing.groupRecord
    );
    if (opts?.specOverride) {
      groupRecord = {
        ...groupRecord,
        spec: opts.specOverride,
      };
    }

    const memberIdSet = new Set(existing.groupElements.map((e) => e.id));
    incomingExternal = [];
    outgoingExternal = [];
    for (const el of allElements) {
      if (el.kind !== "arrow" || memberIdSet.has(el.id)) continue;
      const fromIn = Boolean(el.fromId && memberIdSet.has(el.fromId));
      const toIn = Boolean(el.toId && memberIdSet.has(el.toId));
      if (!fromIn && toIn && el.fromId) {
        incomingExternal.push(el);
      } else if (fromIn && !toIn && el.toId) {
        outgoingExternal.push(el);
      }
    }

    replacedIds = Array.from(
      new Set([
        ...existing.groupElements.map((e) => e.id),
        ...incomingExternal.map((a) => a.id),
        ...outgoingExternal.map((a) => a.id),
      ])
    );
  } else {
    // First morph of an unmorphed sketch selection: snapshot original elements & extract shared semantic spec
    const extracted = extractSelectionWithSemanticIds(selectedIds, allElements);
    if (!extracted) return null;

    const baseSpec =
      opts?.specOverride ?? extractMorphSemanticSpec(selectedIds, allElements);
    if (!baseSpec) return null;

    const groupId = uid("mg");
    const snapshotSource: JevElement[] = [
      ...extracted.selectedFrames,
      ...extracted.orderedShapes,
      ...extracted.internalArrows,
    ].slice(0, MAX_MORPH_SNAPSHOT_ELEMENTS);

    const sketchSnapshot: SketchSnapshotElement[] = snapshotSource.map((el) => ({
      id: el.id,
      kind: el.kind,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      label: el.label,
      ...(el.sublabel !== undefined ? { sublabel: el.sublabel } : {}),
      tone: el.tone,
      seed: el.seed,
      ...(el.fromId ? { fromId: el.fromId } : {}),
      ...(el.toId ? { toId: el.toId } : {}),
      ...(el.fromPoint ? { fromPoint: { ...el.fromPoint } } : {}),
      ...(el.toPoint ? { toPoint: { ...el.toPoint } } : {}),
      ...(el.arrowStyle ? { arrowStyle: el.arrowStyle } : {}),
      ...(el.dashed ? { dashed: true } : {}),
      ...(el.bidirectional ? { bidirectional: true } : {}),
      ...(el.points ? { points: downsamplePoints(el.points) } : {}),
      ...(extracted.idToSemId.has(el.id)
        ? { semanticId: extracted.idToSemId.get(el.id) }
        : {}),
    }));

    groupRecord = {
      groupId,
      anchorBounds: { ...extracted.bounds },
      entrySketchId: extracted.entryNode.id,
      exitSketchId: extracted.exitNode.id,
      spec: baseSpec,
      sketchSnapshot,
    };

    replacedIds = extracted.replacedIds;
    incomingExternal = extracted.incomingExternal;
    outgoingExternal = extracted.outgoingExternal;
  }

  let layoutOut: {
    elements: JevElement[];
    entryId: string;
    exitId: string;
    selectableIds: string[];
  };

  switch (targetNotation) {
    case "sequence":
      layoutOut = layoutSequenceNotation(
        groupRecord.spec,
        groupRecord.groupId,
        groupRecord.anchorBounds,
        now
      );
      break;
    case "flowchart":
      layoutOut = layoutFlowchartNotation(
        groupRecord.spec,
        groupRecord.groupId,
        groupRecord.anchorBounds,
        now
      );
      break;
    case "state":
      layoutOut = layoutStateNotation(
        groupRecord.spec,
        groupRecord.groupId,
        groupRecord.anchorBounds,
        now
      );
      break;
    case "er":
      layoutOut = layoutErNotation(
        groupRecord.spec,
        groupRecord.groupId,
        groupRecord.anchorBounds,
        now
      );
      break;
    case "sketch":
    default:
      layoutOut = restoreSketchFromGroupRecord(groupRecord, now);
      break;
  }

  // Attach the shared reversible MorphGroupRecord cleanly to the primary anchor shape element
  const anchorIdx = layoutOut.elements.findIndex(
    (e) => isShapeElement(e) && e.kind !== "frame"
  );
  const attachIdx = anchorIdx >= 0 ? anchorIdx : 0;
  const withRecord: JevElement[] = layoutOut.elements.map((el, idx) => {
    const baseMeta: ElementMorphMeta = el.morphMeta ?? {
      groupId: groupRecord.groupId,
      notation: targetNotation,
    };
    if (idx === attachIdx) {
      return {
        ...el,
        morphMeta: {
          ...baseMeta,
          groupRecord,
        },
      };
    }
    return {
      ...el,
      morphMeta: baseMeta,
    };
  });

  // Rewire external boundary arrows to the morphed group's entry/exit nodes
  const rewiredExternal: JevElement[] = [];
  for (const inc of incomingExternal) {
    if (!inc.fromId || !layoutOut.entryId) continue;
    const id = uid("mext");
    rewiredExternal.push({
      id,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: inc.label,
      tone: inc.tone,
      seed: makeSeed(id),
      fromId: inc.fromId,
      toId: layoutOut.entryId,
      arrowStyle: inc.arrowStyle ?? "curved",
      ...(inc.dashed ? { dashed: true } : {}),
      ...(inc.bidirectional ? { bidirectional: true } : {}),
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  for (const out of outgoingExternal) {
    if (!out.toId || !layoutOut.exitId) continue;
    const id = uid("mext");
    rewiredExternal.push({
      id,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: out.label,
      tone: out.tone,
      seed: makeSeed(id),
      fromId: layoutOut.exitId,
      toId: out.toId,
      arrowStyle: out.arrowStyle ?? "curved",
      ...(out.dashed ? { dashed: true } : {}),
      ...(out.bidirectional ? { bidirectional: true } : {}),
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  return {
    groupId: groupRecord.groupId,
    notation: targetNotation,
    spec: groupRecord.spec,
    replacedIds,
    addedElements: [...withRecord, ...rewiredExternal],
    nextSelectedIds: layoutOut.selectableIds,
    entryElementId: layoutOut.entryId,
    exitElementId: layoutOut.exitId,
    isHeuristic: opts?.isHeuristic ?? !opts?.specOverride,
  };
}

/**
 * Atomically produces the next board elements array swapping a morphed group in place.
 * Pass into `updateElements` so replaced IDs receive tombstones and new elements receive bumped revs.
 */
export function applyMorphToBoard(
  currentElements: JevElement[],
  morph: MorphOperationResult
): JevElement[] {
  const removeSet = new Set(morph.replacedIds);
  const kept = currentElements.filter((el) => !removeSet.has(el.id));
  const framesToAdd = morph.addedElements.filter((e) => e.kind === "frame");
  const othersToAdd = morph.addedElements.filter((e) => e.kind !== "frame");
  return [...framesToAdd, ...kept, ...othersToAdd];
}
