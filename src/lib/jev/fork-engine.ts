import { z } from "zod";
import { inferToneFromLabel } from "./colors";
import {
  computeBounds,
  getElementRect,
  isShapeElement,
  makeSeed,
  Rect,
  rectContainsCenter,
  uid,
} from "./geometry";
import {
  hasForbiddenObjectKeys,
  layoutSemanticGraphToElements,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  validateSemanticGraph,
} from "./semantic-graph";
import type { ColorTone, JevElement } from "./types";

export type ForkArchetype =
  | "queue_event_driven"
  | "cache_read_replica"
  | "gateway_edge_split"
  | "resilient_mesh";

export const forkArchetypeSchema = z.enum([
  "queue_event_driven",
  "cache_read_replica",
  "gateway_edge_split",
  "resilient_mesh",
]);

export interface ForkTakeSpec {
  archetype: ForkArchetype;
  title: string;
  rationale: string;
  tradeoffTag: string;
  graph: SemanticGraph;
}

export interface ForkTake extends ForkTakeSpec {
  id: string;
  elements: JevElement[];
  entryElementId: string;
  exitElementId: string;
  feedbackKeys: string[];
  /** Only set when returned by a live calibrated model; always undefined in heuristic mode. */
  probability?: number;
}

export interface SelectedSubgraph {
  selectedShapes: JevElement[];
  selectedFrames: JevElement[];
  internalArrows: JevElement[];
  incomingExternal: JevElement[];
  outgoingExternal: JevElement[];
  replacedIds: string[];
  bounds: Rect;
  entryNode: JevElement;
  exitNode: JevElement;
}

export interface ForkGenerationResult {
  subgraph: SelectedSubgraph;
  replacedIds: string[];
  takes: ForkTake[];
  source: "typesafe-jev" | "llm-json" | "heuristic";
  model: string;
  isHeuristic: boolean;
  confidence: number | null;
}

/**
 * Extracts the selected shapes, contained shapes if a frame was selected,
 * internal arrows, and external incoming/outgoing boundary arrows for seamless rewiring.
 */
export function extractSelectedSubgraph(
  selectedIds: string[],
  allElements: JevElement[]
): SelectedSubgraph | null {
  if (selectedIds.length === 0 || allElements.length === 0) return null;

  const explicitSet = new Set(selectedIds);
  const selectedFrames = allElements.filter(
    (e) => explicitSet.has(e.id) && e.kind === "frame"
  );

  const shapeIdSet = new Set<string>();
  for (const el of allElements) {
    if (!isShapeElement(el) || el.kind === "frame") continue;
    if (explicitSet.has(el.id)) {
      shapeIdSet.add(el.id);
      continue;
    }
    // Include shapes geometrically inside any selected frame
    for (const frame of selectedFrames) {
      if (rectContainsCenter(getElementRect(frame), getElementRect(el))) {
        shapeIdSet.add(el.id);
        break;
      }
    }
  }

  const selectedShapes = allElements
    .filter((e) => shapeIdSet.has(e.id))
    .sort((a, b) => a.x - b.x || a.y - b.y);

  if (selectedShapes.length === 0) return null;

  const internalArrows: JevElement[] = [];
  const incomingExternal: JevElement[] = [];
  const outgoingExternal: JevElement[] = [];

  for (const el of allElements) {
    if (el.kind !== "arrow") continue;
    const fromIn = Boolean(el.fromId && shapeIdSet.has(el.fromId));
    const toIn = Boolean(el.toId && shapeIdSet.has(el.toId));
    if (fromIn && toIn) {
      internalArrows.push(el);
    } else if (!fromIn && toIn && el.fromId) {
      incomingExternal.push(el);
    } else if (fromIn && !toIn && el.toId) {
      outgoingExternal.push(el);
    }
  }

  // Compute in/out degree inside the selected subgraph to identify entry & exit nodes
  const internalInDeg = new Map<string, number>();
  const internalOutDeg = new Map<string, number>();
  for (const s of selectedShapes) {
    internalInDeg.set(s.id, 0);
    internalOutDeg.set(s.id, 0);
  }
  for (const arr of internalArrows) {
    if (arr.fromId && internalOutDeg.has(arr.fromId)) {
      internalOutDeg.set(arr.fromId, (internalOutDeg.get(arr.fromId) ?? 0) + 1);
    }
    if (arr.toId && internalInDeg.has(arr.toId)) {
      internalInDeg.set(arr.toId, (internalInDeg.get(arr.toId) ?? 0) + 1);
    }
  }

  const entryNode =
    selectedShapes.find((s) => (internalInDeg.get(s.id) ?? 0) === 0) ??
    selectedShapes[0];
  const exitNode =
    [...selectedShapes]
      .reverse()
      .find((s) => (internalOutDeg.get(s.id) ?? 0) === 0) ??
    selectedShapes[selectedShapes.length - 1];

  const bounds = computeBounds([...selectedFrames, ...selectedShapes]) ?? {
    x: entryNode.x,
    y: entryNode.y,
    width: entryNode.width,
    height: entryNode.height,
  };

  const replacedIdSet = new Set<string>([
    ...selectedShapes.map((s) => s.id),
    ...selectedFrames.map((f) => f.id),
    ...internalArrows.map((a) => a.id),
    ...incomingExternal.map((a) => a.id),
    ...outgoingExternal.map((a) => a.id),
  ]);

  return {
    selectedShapes,
    selectedFrames,
    internalArrows,
    incomingExternal,
    outgoingExternal,
    replacedIds: Array.from(replacedIdSet),
    bounds,
    entryNode,
    exitNode,
  };
}

function deriveDomainPrefix(shapes: JevElement[]): string {
  for (const s of shapes) {
    const cleaned = (s.label || "").trim();
    if (!cleaned) continue;
    const words = cleaned.split(/\s+/).filter(Boolean);
    const meaningful = words.find(
      (w) =>
        !/^(api|service|server|db|database|postgres|mysql|redis|cache|queue|node|gateway|worker|app|client|user|core|main|system|store)$/i.test(
          w
        )
    );
    if (meaningful && meaningful.length >= 2) {
      return meaningful.replace(/[^a-zA-Z0-9-]/g, "");
    }
  }
  const first = (shapes[0]?.label || "Core").trim().split(/\s+/)[0] || "Core";
  return first.replace(/[^a-zA-Z0-9-]/g, "") || "Core";
}

function toSemanticKind(kind: JevElement["kind"]): SemanticNode["kind"] {
  if (
    kind === "node" ||
    kind === "diamond" ||
    kind === "database" ||
    kind === "ellipse" ||
    kind === "text"
  ) {
    return kind;
  }
  return "node";
}

function baseNodesAndEdges(subgraph: SelectedSubgraph): {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  idToSemId: Map<string, string>;
} {
  const idToSemId = new Map<string, string>();
  const nodes: SemanticNode[] = subgraph.selectedShapes.map((s, idx) => {
    const semId = `sel_${idx}`;
    idToSemId.set(s.id, semId);
    return {
      id: semId,
      label: s.label || `Step ${idx + 1}`,
      ...(s.sublabel ? { sublabel: s.sublabel } : {}),
      kind: toSemanticKind(s.kind),
      tone: s.tone,
    };
  });

  const edges: SemanticEdge[] = [];
  for (const arr of subgraph.internalArrows) {
    if (!arr.fromId || !arr.toId) continue;
    const from = idToSemId.get(arr.fromId);
    const to = idToSemId.get(arr.toId);
    if (!from || !to || from === to) continue;
    edges.push({
      from,
      to,
      ...(arr.label ? { label: arr.label } : {}),
      ...(arr.dashed ? { dashed: true } : {}),
      ...(arr.bidirectional ? { bidirectional: true } : {}),
    });
  }

  // If user selected disconnected nodes, chain them left-to-right so architectural transforms connect cleanly
  if (edges.length === 0 && nodes.length > 1) {
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, kind: "flow" });
    }
  }

  return { nodes, edges, idToSemId };
}

function buildQueueEventDrivenSpec(subgraph: SelectedSubgraph): ForkTakeSpec {
  const { nodes, edges, idToSemId } = baseNodesAndEdges(subgraph);
  const domain = deriveDomainPrefix(subgraph.selectedShapes);
  const entrySemId = idToSemId.get(subgraph.entryNode.id) ?? nodes[0].id;

  const queueId = "fork_queue";
  const workerId = "fork_worker";
  const dlqId = "fork_dlq";

  const outNodes: SemanticNode[] = nodes.map((n) => ({ ...n }));
  const outEdges: SemanticEdge[] = [];

  if (nodes.length === 1) {
    const sole = outNodes[0];
    outNodes.push(
      {
        id: queueId,
        label: `${domain} Event Queue`,
        sublabel: "Async buffer",
        kind: "node",
        tone: "ochre",
      },
      {
        id: workerId,
        label: `${domain} Worker`,
        sublabel: "Idempotent consumer",
        kind: "node",
        tone: "cobalt",
      },
      {
        id: dlqId,
        label: "Dead Letter Queue",
        sublabel: "Retry / inspect",
        kind: "node",
        tone: "terracotta",
      }
    );
    outEdges.push(
      { from: sole.id, to: queueId, label: "publish", dashed: true, kind: "async" },
      { from: queueId, to: workerId, label: "consume", kind: "async" },
      { from: workerId, to: dlqId, label: "failed", dashed: true, kind: "fallback" }
    );
  } else {
    // Decouple the first outgoing hop from entry -> queue -> worker -> downstream
    const primaryEdgeIdx = edges.findIndex((e) => e.from === entrySemId);
    const splitEdge = primaryEdgeIdx >= 0 ? edges[primaryEdgeIdx] : edges[0];

    outNodes.push(
      {
        id: queueId,
        label: `${domain} Queue`,
        sublabel: "Kafka / Async topic",
        kind: "node",
        tone: "ochre",
      },
      {
        id: workerId,
        label: `${domain} Worker`,
        sublabel: "Consumer pool",
        kind: "node",
        tone: "cobalt",
      },
      {
        id: dlqId,
        label: "Dead Letter Queue",
        sublabel: "Poison-pill retry",
        kind: "node",
        tone: "terracotta",
      }
    );

    edges.forEach((e, idx) => {
      if (splitEdge && idx === (primaryEdgeIdx >= 0 ? primaryEdgeIdx : 0)) {
        outEdges.push(
          { from: e.from, to: queueId, label: "publish", dashed: true, kind: "async" },
          { from: queueId, to: workerId, label: "consume", kind: "async" },
          { from: workerId, to: e.to, label: e.label || "apply", kind: "sync" },
          { from: workerId, to: dlqId, label: "retry fail", dashed: true, kind: "fallback" }
        );
      } else {
        outEdges.push({ ...e });
      }
    });
  }

  return {
    archetype: "queue_event_driven",
    title: "Queue / Event-Driven",
    rationale: `Decouples ${subgraph.entryNode.label} via ${domain} Queue, worker pool, and DLQ backpressure.`,
    tradeoffTag: "Eventual consistency",
    graph: {
      notation: "architecture",
      summary: `${domain} Event-Driven Fork`,
      nodes: outNodes,
      edges: outEdges,
      groups: [
        {
          id: "grp_async",
          label: `${domain} Async Backbone`,
          nodeIds: [queueId, workerId, dlqId],
          tone: "ochre",
        },
      ],
    },
  };
}

function buildCacheReadReplicaSpec(subgraph: SelectedSubgraph): ForkTakeSpec {
  const { nodes, edges, idToSemId } = baseNodesAndEdges(subgraph);
  const domain = deriveDomainPrefix(subgraph.selectedShapes);
  const dbShape =
    subgraph.selectedShapes.find((s) => s.kind === "database") ??
    subgraph.exitNode;
  const dbSemId = idToSemId.get(dbShape.id) ?? nodes[nodes.length - 1].id;

  const hitId = "fork_cache_hit";
  const cacheId = "fork_redis";
  const replicaId = "fork_replica";

  const outNodes: SemanticNode[] = nodes.map((n) => ({ ...n }));
  const outEdges: SemanticEdge[] = [];

  if (nodes.length === 1) {
    const sole = outNodes[0];
    outNodes.push(
      {
        id: hitId,
        label: "Cache Hit?",
        sublabel: "TTL check",
        kind: "diamond",
        tone: "plum",
      },
      {
        id: cacheId,
        label: `${domain} Redis Cache`,
        sublabel: "Sub-ms hot keys",
        kind: "database",
        tone: "teal",
      },
      {
        id: replicaId,
        label: `${domain} Read Replica`,
        sublabel: "Origin fallback",
        kind: "database",
        tone: "teal",
      }
    );
    outEdges.push(
      { from: sole.id, to: hitId, label: "read", kind: "flow" },
      { from: hitId, to: cacheId, label: "Hit", kind: "sync" },
      { from: hitId, to: replicaId, label: "Miss", dashed: true, kind: "fallback" }
    );
  } else {
    const targetEdgeIdx = edges.findIndex((e) => e.to === dbSemId);
    const chosenIdx = targetEdgeIdx >= 0 ? targetEdgeIdx : edges.length - 1;

    outNodes.push(
      {
        id: hitId,
        label: "Cache Hit?",
        sublabel: "Read-through",
        kind: "diamond",
        tone: "plum",
      },
      {
        id: cacheId,
        label: `${domain} Redis Cache`,
        sublabel: "Hot read tier",
        kind: "database",
        tone: "teal",
      },
      {
        id: replicaId,
        label: `${dbShape.label} Replica`,
        sublabel: "Read scaling",
        kind: "database",
        tone: "teal",
      }
    );

    edges.forEach((e, idx) => {
      if (idx === chosenIdx) {
        outEdges.push(
          { from: e.from, to: hitId, label: "read", kind: "flow" },
          { from: hitId, to: cacheId, label: "Hit", kind: "sync" },
          { from: hitId, to: replicaId, label: "Miss", dashed: true, kind: "fallback" },
          { from: e.from, to: e.to, label: "write", kind: "sync" },
          { from: e.to, to: replicaId, label: "replicate", dashed: true, kind: "async" }
        );
      } else {
        outEdges.push({ ...e });
      }
    });
  }

  return {
    archetype: "cache_read_replica",
    title: "Cache-First / Read Replica",
    rationale: `Serves hot ${domain} reads from Redis cache-aside and offloads misses onto a read replica.`,
    tradeoffTag: "Cache invalidation",
    graph: {
      notation: "architecture",
      summary: `${domain} Cache-First Fork`,
      nodes: outNodes,
      edges: outEdges,
      groups: [
        {
          id: "grp_read_tier",
          label: "Low-Latency Read Tier",
          nodeIds: [hitId, cacheId, replicaId],
          tone: "teal",
        },
      ],
    },
  };
}

function buildGatewayOrMeshSpec(subgraph: SelectedSubgraph): ForkTakeSpec {
  const { nodes, edges, idToSemId } = baseNodesAndEdges(subgraph);
  const domain = deriveDomainPrefix(subgraph.selectedShapes);
  const entrySemId = idToSemId.get(subgraph.entryNode.id) ?? nodes[0].id;
  const exitSemId =
    idToSemId.get(subgraph.exitNode.id) ?? nodes[nodes.length - 1].id;

  const alreadyHasGateway = subgraph.selectedShapes.some((s) =>
    /(gateway|edge|cdn|proxy|balancer)/i.test(s.label)
  );

  if (alreadyHasGateway) {
    // Offer Circuit-Breaker / Resilient Mesh split instead of duplicating an existing Gateway
    const breakerId = "fork_breaker";
    const fallbackId = "fork_fallback";
    const obsId = "fork_telemetry";

    const outNodes: SemanticNode[] = [
      ...nodes.map((n) => ({ ...n })),
      {
        id: breakerId,
        label: "Circuit Breaker?",
        sublabel: "Timeout + retry cap",
        kind: "diamond",
        tone: "plum",
      },
      {
        id: fallbackId,
        label: `${domain} Fallback`,
        sublabel: "Degraded response",
        kind: "node",
        tone: "terracotta",
      },
      {
        id: obsId,
        label: "Trace & Metrics",
        sublabel: "SLO alerts",
        kind: "node",
        tone: "slate",
      },
    ];

    const outEdges: SemanticEdge[] = [];
    if (edges.length > 0) {
      edges.forEach((e, idx) => {
        if (idx === 0) {
          outEdges.push(
            { from: e.from, to: breakerId, label: "guard", kind: "flow" },
            { from: breakerId, to: e.to, label: "Healthy", kind: "sync" },
            { from: breakerId, to: fallbackId, label: "Tripped", dashed: true, kind: "fallback" },
            { from: e.to, to: obsId, label: "spans", dashed: true, kind: "async" }
          );
        } else {
          outEdges.push({ ...e });
        }
      });
    } else {
      outEdges.push(
        { from: entrySemId, to: breakerId, label: "guard", kind: "flow" },
        { from: breakerId, to: fallbackId, label: "Tripped", dashed: true, kind: "fallback" },
        { from: entrySemId, to: obsId, label: "spans", dashed: true, kind: "async" }
      );
    }

    return {
      archetype: "resilient_mesh",
      title: "Circuit-Breaker / Resilient Mesh",
      rationale: `Guards ${subgraph.entryNode.label} with a circuit breaker, graceful fallback, and trace telemetry.`,
      tradeoffTag: "Ops complexity",
      graph: {
        notation: "architecture",
        summary: `${domain} Resilient Mesh Fork`,
        nodes: outNodes,
        edges: outEdges,
        groups: [
          {
            id: "grp_resilience",
            label: "Resilience Guardrails",
            nodeIds: [breakerId, fallbackId, obsId],
            tone: "plum",
          },
        ],
      },
    };
  }

  // Standard Gateway / Edge-Split take
  const gwId = "fork_gateway";
  const authId = "fork_guard";
  const readSvcId = "fork_read_svc";

  const outNodes: SemanticNode[] = [
    {
      id: gwId,
      label: `${domain} Edge Gateway`,
      sublabel: "Routing + TLS",
      kind: "node",
      tone: "cobalt",
      layer: 0,
    },
    {
      id: authId,
      label: "Auth & Rate Limit?",
      sublabel: "Edge policy",
      kind: "diamond",
      tone: "plum",
      layer: 1,
    },
    ...nodes.map((n) => ({ ...n })),
    {
      id: readSvcId,
      label: `${domain} Read Edge`,
      sublabel: "CQRS query path",
      kind: "node",
      tone: inferToneFromLabel("Edge Service"),
    },
  ];

  const outEdges: SemanticEdge[] = [
    { from: gwId, to: authId, label: "inspect", kind: "flow" },
    { from: authId, to: entrySemId, label: "write", kind: "sync" },
    { from: authId, to: readSvcId, label: "read", kind: "flow" },
    ...edges.map((e) => ({ ...e })),
  ];

  if (exitSemId !== entrySemId) {
    outEdges.push({
      from: readSvcId,
      to: exitSemId,
      label: "query",
      dashed: true,
      kind: "sync",
    });
  }

  return {
    archetype: "gateway_edge_split",
    title: "Gateway / Edge-Split",
    rationale: `Fronts ${subgraph.entryNode.label} with an Edge Gateway, auth/rate guard, and split read path.`,
    tradeoffTag: "Extra network hop",
    graph: {
      notation: "architecture",
      summary: `${domain} Gateway Edge-Split Fork`,
      nodes: outNodes,
      edges: outEdges,
      groups: [
        {
          id: "grp_edge",
          label: "Edge Ingress",
          nodeIds: [gwId, authId],
          tone: "cobalt",
        },
      ],
    },
  };
}

/**
 * Materializes a validated ForkTakeSpec into positioned JevElements anchored to the
 * selection bounds, with external incoming/outgoing arrows cleanly rewired.
 */
export function materializeForkTake(
  spec: ForkTakeSpec,
  subgraph: SelectedSubgraph,
  now = Date.now()
): ForkTake {
  const laidOut = layoutSemanticGraphToElements(spec.graph, {
    anchorBounds: subgraph.bounds,
    idPrefix: "fk",
    colGap: 236,
    rowGap: 112,
    now,
  });

  const shapeEls = laidOut.elements.filter(
    (e) => isShapeElement(e) && e.kind !== "frame"
  );
  const leftmost =
    [...shapeEls].sort((a, b) => a.x - b.x || a.y - b.y)[0] ?? shapeEls[0];
  const rightmost =
    [...shapeEls].sort((a, b) => b.x + b.width - (a.x + a.width) || a.y - b.y)[0] ??
    shapeEls[shapeEls.length - 1];

  const entryElementId = leftmost?.id ?? laidOut.elements[0]?.id ?? "";
  const exitElementId = rightmost?.id ?? entryElementId;

  const rewiredArrows: JevElement[] = [];
  for (const inc of subgraph.incomingExternal) {
    if (!inc.fromId || !entryElementId) continue;
    const id = uid("fka");
    rewiredArrows.push({
      id,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: inc.label,
      tone: inc.tone as ColorTone,
      seed: makeSeed(id),
      fromId: inc.fromId,
      toId: entryElementId,
      arrowStyle: inc.arrowStyle ?? "curved",
      ...(inc.dashed ? { dashed: true } : {}),
      ...(inc.bidirectional ? { bidirectional: true } : {}),
      createdAt: now,
      updatedAt: now,
      rev: 1,
    });
  }

  for (const out of subgraph.outgoingExternal) {
    if (!out.toId || !exitElementId) continue;
    const id = uid("fka");
    rewiredArrows.push({
      id,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: out.label,
      tone: out.tone as ColorTone,
      seed: makeSeed(id),
      fromId: exitElementId,
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
    ...spec,
    id: uid("fork"),
    elements: [...laidOut.elements, ...rewiredArrows],
    entryElementId,
    exitElementId,
    feedbackKeys: [`fork:${spec.archetype}`, "cat:fork"],
  };
}

/**
 * Generates 3 genuinely distinct local heuristic architectural takes for the selected subgraph.
 * Always honestly labeled `isHeuristic: true` with `confidence: null` and no fabricated probabilities.
 */
export function buildLocalForkTakes(
  selectedIds: string[],
  allElements: JevElement[],
  now = Date.now()
): ForkGenerationResult | null {
  const subgraph = extractSelectedSubgraph(selectedIds, allElements);
  if (!subgraph) return null;

  const specs: ForkTakeSpec[] = [
    buildQueueEventDrivenSpec(subgraph),
    buildCacheReadReplicaSpec(subgraph),
    buildGatewayOrMeshSpec(subgraph),
  ];

  const takes = specs.map((spec) => materializeForkTake(spec, subgraph, now));

  return {
    subgraph,
    replacedIds: subgraph.replacedIds,
    takes,
    source: "heuristic",
    model: "heuristic",
    isHeuristic: true,
    confidence: null,
  };
}

/**
 * Atomically produces the next board element array replacing `replacedIds` with the chosen Fork take.
 * Caller passes this into `updateElements` -> `applyLocalElementsChange` so replaced IDs receive
 * bumped tombstones and new elements receive bumped revisions for WebRTC sync + single-step Undo.
 */
export function applyForkTakeToBoard(
  currentElements: JevElement[],
  replacedIds: string[],
  take: ForkTake
): JevElement[] {
  const removeSet = new Set(replacedIds);
  const kept = currentElements.filter((el) => !removeSet.has(el.id));
  const framesToAdd = take.elements.filter((e) => e.kind === "frame");
  const othersToAdd = take.elements.filter((e) => e.kind !== "frame");
  return [...framesToAdd, ...kept, ...othersToAdd];
}

const rawForkTakeSpecSchema = z.object({
  archetype: forkArchetypeSchema.optional().default("queue_event_driven"),
  title: z.string().trim().min(2).max(80),
  rationale: z.string().trim().min(6).max(200),
  tradeoffTag: z.string().trim().min(2).max(48),
  graph: z.unknown(),
});

const rawForkTakesPayloadSchema = z.object({
  takes: z.array(rawForkTakeSpecSchema).length(3),
});

export function validateForkTakesPayload(
  raw: unknown
): { ok: true; takes: ForkTakeSpec[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || hasForbiddenObjectKeys(raw)) {
    return { ok: false, error: "Invalid or unsafe fork takes payload" };
  }
  const parsed = rawForkTakesPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid fork takes payload",
    };
  }

  const validatedTakes: ForkTakeSpec[] = [];
  for (const item of parsed.data.takes) {
    const graphCheck = validateSemanticGraph(item.graph);
    if (!graphCheck.ok) {
      return { ok: false, error: `Invalid take graph: ${graphCheck.error}` };
    }
    validatedTakes.push({
      archetype: item.archetype,
      title: item.title,
      rationale: item.rationale,
      tradeoffTag: item.tradeoffTag,
      graph: graphCheck.graph,
    });
  }

  return { ok: true, takes: validatedTakes };
}
