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
import {
  hasForbiddenObjectKeys,
  isSemanticNodeKind,
  layoutSemanticGraphToElements,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  validateSemanticGraph,
} from "./semantic-graph";
import {
  FORK_PATTERN_IDS,
  forkCostLinesSchema,
  type ForkConstraint,
  type ForkTradeoffs,
} from "./fork-constraint";
import { isContainerKind } from "./notation-kinds";
import type { ColorTone, JevElement } from "./types";

const CLASSIC_FORK_ARCHETYPES = [
  "queue_event_driven",
  "cache_read_replica",
  "gateway_edge_split",
  "resilient_mesh",
] as const;

export const forkArchetypeSchema = z.enum([...CLASSIC_FORK_ARCHETYPES, ...FORK_PATTERN_IDS]);

export type ForkArchetype = z.infer<typeof forkArchetypeSchema>;

export interface ForkTakeSpec {
  archetype: ForkArchetype;
  title: string;
  rationale: string;
  tradeoffTag: string;
  graph: SemanticGraph;
  /** Set for takes generated against a stated constraint: what the take buys and what it costs. */
  tradeoffs?: ForkTradeoffs;
  /** Draw the graph's groups as zones (regions / availability zones) instead of frames. */
  groupsAsZones?: boolean;
}

export interface ForkTake extends ForkTakeSpec {
  id: string;
  /** Materialized elements anchored at the selection bounds with external arrows rewired (used on Enter accept). */
  elements: JevElement[];
  /** Non-overlapping ghost preview elements placed beside (or below) the selection for before -> after comparison. */
  previewElements: JevElement[];
  previewPlacement: "right" | "below";
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
  constraint?: ForkConstraint;
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

const PRONOUN_AND_STOPWORDS = new Set([
  "you",
  "your",
  "yours",
  "we",
  "our",
  "ours",
  "us",
  "me",
  "my",
  "mine",
  "they",
  "their",
  "them",
  "he",
  "she",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "from",
  "via",
  "vs",
  "into",
  "as",
  "is",
  "are",
  "be",
  "peers",
  "peer",
  "user",
  "users",
  "client",
  "clients",
  "customer",
  "customers",
  "browser",
  "mobile",
  "visitor",
  "visitors",
  "people",
  "team",
  "actor",
  "human",
  "end",
  "frontend",
  "ui",
]);

const GENERIC_INFRA_WORDS = new Set([
  "api",
  "service",
  "services",
  "server",
  "servers",
  "db",
  "database",
  "postgres",
  "postgresql",
  "mysql",
  "mongo",
  "mongodb",
  "sqlite",
  "redis",
  "cache",
  "queue",
  "node",
  "nodes",
  "worker",
  "workers",
  "app",
  "core",
  "main",
  "system",
  "store",
  "storage",
  "layer",
  "tier",
  "step",
  "new",
  "box",
  "canvas",
  "mesh",
  "engine",
  "hub",
  "module",
  "component",
  "backend",
  "cluster",
  "instance",
  "primary",
  "replica",
]);

const SECONDARY_ARCH_SUBJECTS = new Set([
  "gateway",
  "edge",
  "proxy",
  "broker",
  "ledger",
  "search",
  "index",
  "webhook",
  "session",
  "stream",
  "sync",
]);

function shapeSubjectPriority(shape: JevElement): number {
  switch (shape.kind) {
    case "node":
      return 4;
    case "database":
      return 3;
    case "diamond":
      return 2;
    case "ellipse":
      return 0;
    default:
      return 1;
  }
}

function tokenizeLabel(label: string): string[] {
  return (label || "")
    .replace(/[&/+→>-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w));
}

/**
 * Extracts a clean domain subject (e.g. "Orders", "Checkout", "Auth", "Sync", "Gateway")
 * from the selected shapes while stripping pronouns, stopwords, and generic actor names.
 * Returns `null` when only pronouns/generic labels exist so callers use crisp role defaults.
 */
export function deriveDomainSubject(shapes: JevElement[]): string | null {
  const prioritized = [...shapes].sort(
    (a, b) => shapeSubjectPriority(b) - shapeSubjectPriority(a)
  );

  // Pass 1: Concrete domain noun (e.g. Orders, Checkout, Auth, Payments, Sync, WebRTC)
  for (const s of prioritized) {
    const tokens = tokenizeLabel(s.label);
    const domainToken = tokens.find((tok) => {
      const lower = tok.toLowerCase();
      return (
        !PRONOUN_AND_STOPWORDS.has(lower) &&
        !GENERIC_INFRA_WORDS.has(lower) &&
        !SECONDARY_ARCH_SUBJECTS.has(lower)
      );
    });
    if (domainToken) return domainToken;
  }

  // Pass 2: Architectural domain keyword (e.g. Gateway, Sync, Ledger, Webhook, Search)
  for (const s of prioritized) {
    const tokens = tokenizeLabel(s.label);
    const archToken = tokens.find((tok) =>
      SECONDARY_ARCH_SUBJECTS.has(tok.toLowerCase())
    );
    if (archToken) return archToken;
  }

  return null;
}

function joinDomainRole(
  domain: string | null,
  role: string,
  fallbackRole: string
): string {
  if (!domain) return fallbackRole;
  const dLower = domain.toLowerCase();
  if (role.toLowerCase().includes(dLower)) return fallbackRole;
  return `${domain} ${role}`;
}

function describeSelectionFocus(subgraph: SelectedSubgraph, domain: string | null): string {
  const prioritized = [...subgraph.selectedShapes].sort(
    (a, b) => shapeSubjectPriority(b) - shapeSubjectPriority(a)
  );
  const meaningfulNode = prioritized.find((s) => {
    const tokens = tokenizeLabel(s.label);
    return tokens.some((t) => !PRONOUN_AND_STOPWORDS.has(t.toLowerCase()));
  });
  if (meaningfulNode?.label.trim()) return meaningfulNode.label.trim();
  return domain ?? "this flow";
}

function toSemanticKind(kind: JevElement["kind"]): SemanticNode["kind"] {
  return isSemanticNodeKind(kind) ? kind : "node";
}

export function baseNodesAndEdges(subgraph: SelectedSubgraph): {
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
  const domain = deriveDomainSubject(subgraph.selectedShapes);
  const focusLabel = describeSelectionFocus(subgraph, domain);
  const entrySemId = idToSemId.get(subgraph.entryNode.id) ?? nodes[0].id;

  const queueId = "fork_queue";
  const workerId = "fork_worker";
  const dlqId = "fork_dlq";

  const outNodes: SemanticNode[] = nodes.map((n) => ({ ...n }));
  const outEdges: SemanticEdge[] = [];
  const queueLabel = joinDomainRole(domain, "Queue", "Ingest Queue");
  const workerLabel = joinDomainRole(domain, "Worker", "Async Worker");

  if (nodes.length === 1) {
    const sole = outNodes[0];
    outNodes.push(
      {
        id: queueId,
        label: joinDomainRole(domain, "Event Queue", "Ingest Queue"),
        sublabel: "Async buffer",
        kind: "node",
        tone: "ochre",
      },
      {
        id: workerId,
        label: workerLabel,
        sublabel: "Idempotent consumer",
        kind: "node",
        tone: "cobalt",
      },
      {
        id: dlqId,
        label: "Dead-Letter Queue",
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
        label: queueLabel,
        sublabel: "Kafka / Async topic",
        kind: "node",
        tone: "ochre",
      },
      {
        id: workerId,
        label: workerLabel,
        sublabel: "Consumer pool",
        kind: "node",
        tone: "cobalt",
      },
      {
        id: dlqId,
        label: "Dead-Letter Queue",
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
    rationale: `Decouples ${focusLabel} via ${queueLabel}, ${workerLabel}, and DLQ backpressure.`,
    tradeoffTag: "Eventual consistency",
    graph: {
      notation: "architecture",
      summary: domain ? `${domain} Event-Driven Fork` : "Event-Driven Fork",
      nodes: outNodes,
      edges: outEdges,
      groups: [
        {
          id: "grp_async",
          label: domain ? `${domain} Async Backbone` : "Async Backbone",
          nodeIds: [queueId, workerId, dlqId],
          tone: "ochre",
        },
      ],
    },
  };
}

function buildCacheReadReplicaSpec(subgraph: SelectedSubgraph): ForkTakeSpec {
  const { nodes, edges, idToSemId } = baseNodesAndEdges(subgraph);
  const domain = deriveDomainSubject(subgraph.selectedShapes);
  const dbShape =
    subgraph.selectedShapes.find((s) => s.kind === "database") ??
    subgraph.exitNode;
  const dbSemId = idToSemId.get(dbShape.id) ?? nodes[nodes.length - 1].id;

  const hitId = "fork_cache_hit";
  const cacheId = "fork_redis";
  const replicaId = "fork_replica";

  const outNodes: SemanticNode[] = nodes.map((n) => ({ ...n }));
  const outEdges: SemanticEdge[] = [];
  const cacheLabel = joinDomainRole(domain, "Read Cache", "Read Cache");
  const dbLabelHasSubject = tokenizeLabel(dbShape.label).some(
    (t) => !PRONOUN_AND_STOPWORDS.has(t.toLowerCase())
  );
  const replicaLabel =
    dbShape.kind === "database" && dbLabelHasSubject
      ? `${dbShape.label} Replica`
      : joinDomainRole(domain, "Read Replica", "Read Replica");

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
        label: cacheLabel,
        sublabel: "Sub-ms hot keys",
        kind: "database",
        tone: "teal",
      },
      {
        id: replicaId,
        label: replicaLabel,
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
        label: cacheLabel,
        sublabel: "Hot read tier",
        kind: "database",
        tone: "teal",
      },
      {
        id: replicaId,
        label: replicaLabel,
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
    rationale: domain
      ? `Serves hot ${domain} reads from Redis cache-aside and offloads misses onto a read replica.`
      : "Serves hot reads from a Redis cache-aside tier and offloads misses onto a read replica.",
    tradeoffTag: "Cache invalidation",
    graph: {
      notation: "architecture",
      summary: domain ? `${domain} Cache-First Fork` : "Cache-First Fork",
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
  const domain = deriveDomainSubject(subgraph.selectedShapes);
  const focusLabel = describeSelectionFocus(subgraph, domain);
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
        label: joinDomainRole(domain, "Fallback", "Graceful Fallback"),
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
      rationale: `Guards ${focusLabel} with a circuit breaker, graceful fallback, and trace telemetry.`,
      tradeoffTag: "Ops complexity",
      graph: {
        notation: "architecture",
        summary: domain ? `${domain} Resilient Mesh Fork` : "Resilient Mesh Fork",
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
      label: joinDomainRole(domain, "Edge Gateway", "Edge Gateway"),
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
      label: joinDomainRole(domain, "Read Edge", "Read Edge"),
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
    rationale: `Fronts ${focusLabel} with an Edge Gateway, auth/rate guard, and split read path.`,
    tradeoffTag: "Extra network hop",
    graph: {
      notation: "architecture",
      summary: domain ? `${domain} Gateway Edge-Split Fork` : "Gateway Edge-Split Fork",
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

const FORK_PREVIEW_GAP_PX = 120;

function shiftElementsForForkPreview(
  elements: JevElement[],
  selectionBounds: Rect
): { previewElements: JevElement[]; placement: "right" | "below" } {
  const genBounds = computeBounds(elements);
  if (!genBounds) {
    return { previewElements: elements, placement: "right" };
  }

  const aspectRatio = selectionBounds.width / Math.max(1, selectionBounds.height);
  const placeBelow = selectionBounds.width >= 820 && aspectRatio >= 3.5;

  let dx: number;
  let dy: number;
  if (placeBelow) {
    const selCenterX = selectionBounds.x + selectionBounds.width / 2;
    const genCenterX = genBounds.x + genBounds.width / 2;
    dx = Math.round(selCenterX - genCenterX);
    dy = Math.round(
      selectionBounds.y + selectionBounds.height + FORK_PREVIEW_GAP_PX - genBounds.y
    );
  } else {
    const selCenterY = selectionBounds.y + selectionBounds.height / 2;
    const genCenterY = genBounds.y + genBounds.height / 2;
    dx = Math.round(
      selectionBounds.x + selectionBounds.width + FORK_PREVIEW_GAP_PX - genBounds.x
    );
    dy = Math.round(selCenterY - genCenterY);
  }

  const previewElements = elements.map((el) => {
    if (el.kind === "arrow") {
      return {
        ...el,
        ...(el.fromPoint
          ? { fromPoint: { x: el.fromPoint.x + dx, y: el.fromPoint.y + dy } }
          : {}),
        ...(el.toPoint
          ? { toPoint: { x: el.toPoint.x + dx, y: el.toPoint.y + dy } }
          : {}),
      };
    }
    if (el.kind === "freedraw" && el.points) {
      return {
        ...el,
        x: el.x + dx,
        y: el.y + dy,
        points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    }
    return {
      ...el,
      x: el.x + dx,
      y: el.y + dy,
    };
  });

  return {
    previewElements,
    placement: placeBelow ? "below" : "right",
  };
}

/**
 * Materializes a validated ForkTakeSpec into positioned JevElements anchored to the
 * selection bounds (for Enter accept) plus beside-placed ghost `previewElements`.
 */
export function materializeForkTake(
  spec: ForkTakeSpec,
  subgraph: SelectedSubgraph,
  now = Date.now()
): ForkTake {
  const layout = layoutSemanticGraphToElements(spec.graph, {
    anchorBounds: subgraph.bounds,
    idPrefix: "fk",
    colGap: 236,
    rowGap: 112,
    now,
  });
  const laidOut = spec.groupsAsZones
    ? {
        ...layout,
        elements: layout.elements.map((e) =>
          e.kind === "frame" ? { ...e, kind: "zone" as const } : e
        ),
      }
    : layout;

  const shapeEls = laidOut.elements.filter(
    (e) => isShapeElement(e) && !isContainerKind(e.kind)
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

  const { previewElements, placement } = shiftElementsForForkPreview(
    laidOut.elements,
    subgraph.bounds
  );

  return {
    ...spec,
    id: uid("fork"),
    elements: [...laidOut.elements, ...rewiredArrows],
    previewElements,
    previewPlacement: placement,
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
  const selectionBounds = computeBounds(
    currentElements.filter((el) => removeSet.has(el.id) && el.kind !== "arrow")
  );
  const kept = makeRoomForSwap(
    currentElements.filter((el) => !removeSet.has(el.id)),
    take.elements,
    selectionBounds
  );
  const framesToAdd = take.elements.filter((e) => isContainerKind(e.kind));
  const othersToAdd = take.elements.filter((e) => !isContainerKind(e.kind));
  return [...framesToAdd, ...kept, ...othersToAdd];
}

const SWAP_CLEARANCE_PX = 32;

type PushDirection = "left" | "right" | "up" | "down";

function isPushableShape(el: JevElement): boolean {
  return el.kind !== "arrow" && el.kind !== "freedraw" && el.kind !== "frame";
}

function pushDirectionFor(rect: Rect, selection: Rect): PushDirection {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const right = selection.x + selection.width;
  const bottom = selection.y + selection.height;
  const outX = cx < selection.x ? selection.x - cx : cx > right ? cx - right : 0;
  const outY = cy < selection.y ? selection.y - cy : cy > bottom ? cy - bottom : 0;
  if (outX === 0 && outY === 0) return "down";
  if (outX >= outY) return cx < selection.x ? "left" : "right";
  return cy < selection.y ? "up" : "down";
}

function clearOf(rect: Rect, obstacles: Rect[], dir: PushDirection): Rect {
  const next = { ...rect };
  for (let guard = 0; guard <= obstacles.length; guard++) {
    const hit = obstacles.find((o) => rectsOverlap(next, o, SWAP_CLEARANCE_PX));
    if (!hit) break;
    if (dir === "left") next.x = hit.x - SWAP_CLEARANCE_PX - next.width - 1;
    if (dir === "right") next.x = hit.x + hit.width + SWAP_CLEARANCE_PX + 1;
    if (dir === "up") next.y = hit.y - SWAP_CLEARANCE_PX - next.height - 1;
    if (dir === "down") next.y = hit.y + hit.height + SWAP_CLEARANCE_PX + 1;
  }
  return next;
}

/**
 * Pushes kept shapes out of the area the accepted take occupies (and cascades to the
 * shapes they bump into), moving each away from the original selection.
 */
function makeRoomForSwap(
  kept: JevElement[],
  added: JevElement[],
  selection: Rect | null
): JevElement[] {
  const obstacles: Rect[] = added
    .filter((e) => e.kind !== "arrow" && e.kind !== "freedraw")
    .map(getElementRect);
  if (!selection || obstacles.length === 0) return kept;

  const moved = new Map<string, Rect>();
  let changed = true;
  for (let pass = 0; changed && pass <= kept.length; pass++) {
    changed = false;
    for (const el of kept) {
      if (!isPushableShape(el) || moved.has(el.id)) continue;
      const rect = getElementRect(el);
      if (!obstacles.some((o) => rectsOverlap(rect, o, SWAP_CLEARANCE_PX))) continue;
      const cleared = clearOf(rect, obstacles, pushDirectionFor(rect, selection));
      moved.set(el.id, cleared);
      obstacles.push(cleared);
      changed = true;
    }
  }

  if (moved.size === 0) return kept;
  return kept.map((el) => {
    const r = moved.get(el.id);
    return r ? { ...el, x: Math.round(r.x), y: Math.round(r.y) } : el;
  });
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

const rawConstrainedForkTakeSpecSchema = rawForkTakeSpecSchema.extend({
  buys: z.string().trim().min(4).max(180),
  costs: forkCostLinesSchema,
  failureMode: z.string().trim().min(4).max(160),
});

const rawConstrainedForkTakesPayloadSchema = z.object({
  takes: z.array(rawConstrainedForkTakeSpecSchema).length(3),
});

/**
 * Validates model-generated takes. With a stated constraint every take must also carry
 * `buys`, one cost line per axis and a `failureMode`; they land on `take.tradeoffs`.
 */
export function validateForkTakesPayload(
  raw: unknown,
  opts: { constraint?: ForkConstraint | null } = {}
): { ok: true; takes: ForkTakeSpec[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || hasForbiddenObjectKeys(raw)) {
    return { ok: false, error: "Invalid or unsafe fork takes payload" };
  }
  const pressure = opts.constraint?.pressure;
  const parsed = pressure
    ? rawConstrainedForkTakesPayloadSchema.safeParse(raw)
    : rawForkTakesPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid fork takes payload",
    };
  }

  const validatedTakes: ForkTakeSpec[] = [];
  for (const item of parsed.data.takes as Array<
    z.infer<typeof rawForkTakeSpecSchema> & Partial<z.infer<typeof rawConstrainedForkTakeSpecSchema>>
  >) {
    const graphCheck = validateSemanticGraph(item.graph);
    if (!graphCheck.ok) {
      return { ok: false, error: `Invalid take graph: ${graphCheck.error}` };
    }
    const { buys, costs, failureMode } = item;
    validatedTakes.push({
      archetype: item.archetype,
      title: item.title,
      rationale: item.rationale,
      tradeoffTag: item.tradeoffTag,
      graph: graphCheck.graph,
      ...(pressure && buys && costs && failureMode
        ? { tradeoffs: { pressure, buys, costs, failureMode } }
        : {}),
    });
  }

  return { ok: true, takes: validatedTakes };
}
