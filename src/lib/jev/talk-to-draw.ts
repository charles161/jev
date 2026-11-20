import { z } from "zod";
import { inferToneFromLabel } from "./colors";
import {
  findFreeSpot,
  getElementCenter,
  isShapeElement,
  makeSeed,
  Rect,
  resolveArrowEndpoints,
  uid,
} from "./geometry";
import { hasForbiddenObjectKeys } from "./semantic-graph";
import type {
  ColorTone,
  ElementKind,
  ElementPatch,
  JevElement,
  Point,
  PredictedAction,
} from "./types";

export const MAX_STROKE_TIMELINE = 24;
export const STROKE_CORRELATION_WINDOW_MS = 6000;

export interface StrokeTimelineEntry {
  strokeId: string;
  elementId?: string;
  kind: ElementKind;
  startPoint: Point;
  endPoint: Point;
  fromId?: string;
  toId?: string;
  label?: string;
  startedAt: number;
  endedAt?: number;
  inProgress: boolean;
}

export interface TalkToDrawNodeSpec {
  label: string;
  kind: "node" | "diamond" | "database" | "ellipse" | "text";
  tone?: ColorTone;
  edgeLabel?: string;
  dashed?: boolean;
}

export interface TalkToDrawParsedSpec {
  strokeLabel: string;
  summary: string;
  targetNodes: TalkToDrawNodeSpec[];
  shapeKindHint?: "node" | "diamond" | "database" | "ellipse";
}

export interface TalkToDrawPredictionResult {
  action: PredictedAction;
  strokeLabel: string;
  summary: string;
  transcript: string;
  correlatedStroke: StrokeTimelineEntry | null;
  targetNodeLabels: string[];
  isHeuristic: boolean;
}

export const TALK_TO_DRAW_SAMPLE_CHIPS: readonly string[] = [
  "this caches the reads",
  "sends events to Kafka queue",
  "validates JWT auth then hits Postgres",
  "API Gateway",
] as const;

const colorToneSchema = z.enum([
  "ink",
  "terracotta",
  "cobalt",
  "teal",
  "ochre",
  "plum",
  "slate",
]);

export const talkToDrawLlmResultSchema = z.object({
  strokeLabel: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(160),
  shapeKindHint: z.enum(["node", "diamond", "database", "ellipse"]).optional(),
  targetNodes: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        kind: z
          .enum(["node", "diamond", "database", "ellipse", "text"])
          .default("node"),
        tone: colorToneSchema.optional(),
        edgeLabel: z.string().trim().max(80).optional(),
        dashed: z.boolean().optional(),
      })
    )
    .max(4),
});

export type TalkToDrawLlmResult = z.infer<typeof talkToDrawLlmResultSchema>;

export function validateTalkToDrawLlmResult(
  raw: unknown
): { ok: true; result: TalkToDrawLlmResult } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || hasForbiddenObjectKeys(raw)) {
    return { ok: false, error: "Invalid or unsafe talk-to-draw payload" };
  }
  const parsed = talkToDrawLlmResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? "Talk-to-draw schema mismatch",
    };
  }
  return { ok: true, result: parsed.data };
}

/* ============================================================================
 * BOUNDED ROLLING STROKE TIMELINE
 * ============================================================================ */

export function recordStrokeStart(
  timeline: StrokeTimelineEntry[],
  entry: Omit<StrokeTimelineEntry, "inProgress" | "endedAt">
): StrokeTimelineEntry[] {
  const next: StrokeTimelineEntry = {
    ...entry,
    startPoint: { ...entry.startPoint },
    endPoint: { ...entry.endPoint },
    inProgress: true,
  };
  const filtered = timeline.filter((t) => t.strokeId !== entry.strokeId);
  return [...filtered, next].slice(-MAX_STROKE_TIMELINE);
}

export function recordStrokeMove(
  timeline: StrokeTimelineEntry[],
  strokeId: string,
  endPoint: Point
): StrokeTimelineEntry[] {
  return timeline.map((entry) =>
    entry.strokeId === strokeId
      ? { ...entry, endPoint: { ...endPoint } }
      : entry
  );
}

export function recordStrokeEnd(
  timeline: StrokeTimelineEntry[],
  strokeId: string,
  update: {
    elementId?: string;
    endPoint?: Point;
    fromId?: string;
    toId?: string;
    label?: string;
    endedAt: number;
  }
): StrokeTimelineEntry[] {
  return timeline.map((entry) =>
    entry.strokeId === strokeId
      ? {
          ...entry,
          elementId: update.elementId ?? entry.elementId,
          endPoint: update.endPoint ? { ...update.endPoint } : entry.endPoint,
          fromId: update.fromId ?? entry.fromId,
          toId: update.toId ?? entry.toId,
          label: update.label ?? entry.label,
          endedAt: update.endedAt,
          inProgress: false,
        }
      : entry
  );
}

/**
 * Correlates a spoken utterance timestamp to the active in-progress stroke or the
 * most recently completed stroke within `windowMs` (default 6000ms).
 */
export function correlateUtteranceToStroke(
  timeline: StrokeTimelineEntry[],
  spokenAt: number,
  windowMs = STROKE_CORRELATION_WINDOW_MS
): StrokeTimelineEntry | null {
  if (timeline.length === 0) return null;

  // 1. Prefer any stroke currently in progress (pointer down while speaking)
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].inProgress) {
      return timeline[i];
    }
  }

  // 2. Otherwise prefer a stroke that overlapped `spokenAt` or ended within `windowMs`
  let best: StrokeTimelineEntry | null = null;
  let bestDelta = Infinity;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    const refTime = entry.endedAt ?? entry.startedAt;
    if (spokenAt >= entry.startedAt && entry.endedAt !== undefined && spokenAt <= entry.endedAt) {
      return entry;
    }
    const delta = spokenAt - refTime;
    if (delta >= -1500 && delta <= windowMs) {
      const absDelta = Math.abs(delta);
      if (absDelta < bestDelta) {
        bestDelta = absDelta;
        best = entry;
      }
    }
  }

  return best;
}

/* ============================================================================
 * DETERMINISTIC LOCAL NLP PARSER (HONEST HEURISTIC FALLBACK)
 * ============================================================================ */

const SPECIAL_WORDS: Record<string, string> = {
  api: "API",
  jwt: "JWT",
  oauth: "OAuth",
  sso: "SSO",
  db: "DB",
  sql: "SQL",
  cdn: "CDN",
  dlq: "DLQ",
  dns: "DNS",
  tls: "TLS",
  http: "HTTP",
  https: "HTTPS",
  grpc: "gRPC",
  graphql: "GraphQL",
  kafka: "Kafka",
  redis: "Redis",
  postgres: "Postgres",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mongo: "MongoDB",
  mongodb: "MongoDB",
  sqlite: "SQLite",
  s3: "S3",
  sqs: "SQS",
  sns: "SNS",
  llm: "LLM",
  rag: "RAG",
  webrtc: "WebRTC",
  crdt: "CRDT",
  rbac: "RBAC",
};

function titleCaseComponent(raw: string): string {
  const cleaned = raw
    .replace(/^(?:a|an|the|my|our|this|that)\s+/i, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(SPECIAL_WORDS, lower)) {
        return SPECIAL_WORDS[lower];
      }
      if (word === word.toUpperCase() && word.length >= 2) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function cleanActionLabel(raw: string): string {
  return raw
    .replace(/^(?:this|it|that|here|we|now|arrow|line)\s+/i, "")
    .replace(/\b(?:the|a|an)\s+/gi, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferNodeKindFromPhrase(label: string): TalkToDrawNodeSpec["kind"] {
  const l = label.toLowerCase();
  if (
    /(cache|redis|db|database|postgres|postgresql|mysql|mongo|sqlite|s3|bucket|store|storage|warehouse|vector|replica|ledger|index)/.test(
      l
    )
  ) {
    return "database";
  }
  if (/(\?|check|valid|auth|verify|guard|decide|rate limit|router|policy)/.test(l)) {
    return "diamond";
  }
  if (/^(user|client|browser|mobile|customer|visitor)$/.test(l.trim())) {
    return "ellipse";
  }
  return "node";
}

function inferImpliedTargetFromAction(actionText: string): TalkToDrawNodeSpec | null {
  const l = actionText.toLowerCase();
  if (/\b(cache|caches|caching|cached|memoize|ttl|redis)\b/.test(l)) {
    return {
      label: /\bredis\b/.test(l) ? "Redis Cache" : "Redis / Cache",
      kind: "database",
      tone: "teal",
    };
  }
  if (/\b(kafka|queue|queues|enqueue|pubsub|broker|topic|dlq|rabbitmq|sqs)\b/.test(l)) {
    const label = /\bkafka\b/.test(l)
      ? "Kafka Queue"
      : /\brabbit/.test(l)
        ? "RabbitMQ Queue"
        : /\bsqs\b/.test(l)
          ? "SQS Queue"
          : /\bdlq\b/.test(l)
            ? "Dead Letter Queue"
            : "Event Queue";
    return { label, kind: "node", tone: "ochre", dashed: true };
  }
  if (/\b(postgres|postgresql|mysql|mongo|sqlite|database|db|persist|persists|saves|stores|writes)\b/.test(l)) {
    const label = /\bpostgres/.test(l)
      ? "Postgres DB"
      : /\bmysql\b/.test(l)
        ? "MySQL DB"
        : /\bmongo/.test(l)
          ? "MongoDB"
          : "Primary DB";
    return { label, kind: "database", tone: "teal" };
  }
  if (/\b(auth|jwt|oauth|sso|verify|verifies|validate|validates|authenticate|login)\b/.test(l)) {
    return {
      label: /\bjwt\b/.test(l) ? "JWT Auth" : "Auth Service",
      kind: "diamond",
      tone: "plum",
    };
  }
  if (/\b(rate limit|throttle|throttles|gateway|proxy|cdn|load balanc)\b/.test(l)) {
    return {
      label: /rate limit|throttle/.test(l) ? "Rate Limiter" : "API Gateway",
      kind: "node",
      tone: "cobalt",
    };
  }
  if (/\b(webhook|notif|email|slack|push|alert)\b/.test(l)) {
    return {
      label: /\bwebhook\b/.test(l) ? "Webhook Dispatcher" : "Notification Service",
      kind: "node",
      tone: "ochre",
      dashed: true,
    };
  }
  if (/\b(log|logs|metric|metrics|trace|telemetry|analytics|monitor)\b/.test(l)) {
    return {
      label: "Observability",
      kind: "node",
      tone: "slate",
      dashed: true,
    };
  }
  return null;
}

function inferNaturalFollowUpForComponent(label: string): TalkToDrawNodeSpec {
  const l = label.toLowerCase();
  if (/(gateway|edge|cdn|balancer)/.test(l)) {
    return { label: "Auth & Rate Limit", kind: "diamond", tone: "plum", edgeLabel: "inspect" };
  }
  if (/(rate limit|limiter|auth|jwt|oauth|guard)/.test(l)) {
    return { label: "Core API", kind: "node", tone: "cobalt", edgeLabel: "allow" };
  }
  if (/(cache|redis)/.test(l)) {
    return { label: "Postgres DB", kind: "database", tone: "teal", edgeLabel: "miss", dashed: true };
  }
  if (/(queue|kafka|event|broker|topic)/.test(l)) {
    return { label: "Async Worker", kind: "node", tone: "cobalt", edgeLabel: "consume" };
  }
  if (/(worker|service|api|server)/.test(l)) {
    return { label: "Postgres DB", kind: "database", tone: "teal", edgeLabel: "persist" };
  }
  return { label: "Downstream Service", kind: "node", tone: "cobalt", edgeLabel: "next" };
}

function parseSingleClauseTarget(clause: string): {
  verb: string;
  target: TalkToDrawNodeSpec;
} | null {
  const trimmed = clause.trim();
  const prepMatch = trimmed.match(
    /^(.+?)\s+(?:to|into|in|on|from|via|through|with|against)\s+(.+)$/i
  );
  if (prepMatch) {
    const verb = cleanActionLabel(prepMatch[1]);
    const targetName = titleCaseComponent(prepMatch[2]);
    if (targetName) {
      const kind = inferNodeKindFromPhrase(targetName);
      return {
        verb: verb || "calls",
        target: {
          label: targetName,
          kind,
          tone: inferToneFromLabel(targetName),
          edgeLabel: verb || undefined,
          dashed: /(queue|kafka|event|async|webhook|pub|emit|send)/i.test(
            `${verb} ${targetName}`
          ),
        },
      };
    }
  }

  const verbObjMatch = trimmed.match(
    /^(?:this\s+|it\s+|that\s+)?(hits|calls|queries|reads|writes|saves|stores|publishes|sends|emits|pushes|validates|verifies|checks|authenticates|caches|routes|forwards)\s+(.+)$/i
  );
  if (verbObjMatch) {
    const verb = verbObjMatch[1].toLowerCase();
    const objRaw = verbObjMatch[2].trim();
    const targetName = titleCaseComponent(objRaw);
    if (targetName) {
      const implied = inferImpliedTargetFromAction(`${verb} ${objRaw}`);
      // If object names a concrete technology/service (e.g. "Postgres", "JWT auth"), prefer its crisp title
      const isGenericNoun = /^(reads|writes|data|requests|responses|traffic|items|results)$/i.test(
        objRaw.replace(/^(?:the|a|an)\s+/i, "").trim()
      );
      const finalTarget: TalkToDrawNodeSpec =
        isGenericNoun && implied
          ? implied
          : {
              label: targetName,
              kind: inferNodeKindFromPhrase(targetName),
              tone: inferToneFromLabel(targetName),
              edgeLabel: verb,
            };
      return {
        verb: isGenericNoun ? cleanActionLabel(`${verb} ${objRaw}`) : verb,
        target: finalTarget,
      };
    }
  }

  return null;
}

/**
 * Parses a spoken utterance + active stroke kind into a structured Talk-to-Draw spec.
 */
export function parseTalkToDrawUtterance(
  rawUtterance: string,
  strokeKind: ElementKind = "arrow"
): TalkToDrawParsedSpec {
  const trimmed = rawUtterance.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return {
      strokeLabel: "",
      summary: "Spoken sketch",
      targetNodes: [],
    };
  }

  // 1) Multi-clause speech ("validates JWT auth then hits Postgres")
  const clauses = trimmed
    .split(/\s*(?:,?\s+and\s+then\s+|,?\s+then\s+|\s+before\s+|\s+which\s+(?:calls|hits|writes|sends)\s+|->|→)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  if (clauses.length >= 2) {
    const first = clauses[0];
    const rest = clauses.slice(1);
    const firstParsed = parseSingleClauseTarget(first);
    const firstClean = cleanActionLabel(first);
    const firstTitle = firstParsed
      ? firstParsed.target.label
      : titleCaseComponent(firstClean);

    const downstreamNodes: TalkToDrawNodeSpec[] = [];
    for (const clause of rest.slice(0, 3)) {
      const parsed = parseSingleClauseTarget(clause);
      if (parsed) {
        downstreamNodes.push({
          ...parsed.target,
          edgeLabel: parsed.verb,
        });
      } else {
        const implied = inferImpliedTargetFromAction(clause);
        if (implied) {
          downstreamNodes.push({
            ...implied,
            edgeLabel: cleanActionLabel(clause).split(/\s+/)[0] || "next",
          });
        } else {
          const name = titleCaseComponent(clause);
          if (name) {
            downstreamNodes.push({
              label: name,
              kind: inferNodeKindFromPhrase(name),
              tone: inferToneFromLabel(name),
              edgeLabel: "next",
            });
          }
        }
      }
    }

    if (strokeKind === "arrow") {
      // Arrow gets first clause's verb label, ghosts first target + downstream chain
      const firstNode: TalkToDrawNodeSpec = firstParsed
        ? firstParsed.target
        : {
            label: firstTitle || "Step",
            kind: inferNodeKindFromPhrase(firstTitle || "Step"),
            tone: inferToneFromLabel(firstTitle || "Step"),
          };
      return {
        strokeLabel: firstClean.slice(0, 48) || "next",
        summary: `${firstNode.label} → ${downstreamNodes.map((n) => n.label).join(" → ")}`,
        targetNodes: [firstNode, ...downstreamNodes],
      };
    }

    // Shape gets first clause as its label + downstream connected ghost node(s)
    return {
      strokeLabel: firstTitle || titleCaseComponent(first),
      summary: `${firstTitle} → ${downstreamNodes.map((n) => n.label).join(" → ")}`,
      shapeKindHint: (() => {
        const k = inferNodeKindFromPhrase(firstTitle || first);
        return k === "text" ? "node" : k;
      })(),
      targetNodes: downstreamNodes,
    };
  }

  // 2) Single clause with explicit preposition ("sends events to Kafka queue")
  const explicit = parseSingleClauseTarget(trimmed);
  if (strokeKind === "arrow") {
    if (explicit) {
      return {
        strokeLabel: explicit.verb || cleanActionLabel(trimmed),
        summary: `${explicit.verb} → ${explicit.target.label}`,
        targetNodes: [explicit.target],
      };
    }

    // Implied target ("this caches the reads" -> label "caches reads", ghost "Redis / Cache")
    const cleaned = cleanActionLabel(trimmed);
    const implied = inferImpliedTargetFromAction(trimmed);
    if (implied) {
      return {
        strokeLabel: cleaned || trimmed,
        summary: `${cleaned} → ${implied.label}`,
        targetNodes: [implied],
      };
    }

    // Fallback: arrow gets concise label and ghosts a node named from the phrase
    const nodeLabel = titleCaseComponent(cleaned || trimmed) || "Next Service";
    return {
      strokeLabel: cleaned.slice(0, 40) || "calls",
      summary: `Connect to ${nodeLabel}`,
      targetNodes: [
        {
          label: nodeLabel,
          kind: inferNodeKindFromPhrase(nodeLabel),
          tone: inferToneFromLabel(nodeLabel),
        },
      ],
    };
  }

  // 3) Shape or Freedraw stroke with single phrase ("API Gateway", "rate limiter", "this caches the reads")
  const wordCount = trimmed.split(/\s+/).length;
  const startsWithPronounVerb = /^(?:this|it|that)\s+/i.test(trimmed);

  if (startsWithPronounVerb) {
    const implied = inferImpliedTargetFromAction(trimmed);
    const cleaned = cleanActionLabel(trimmed);
    const shapeLabel = implied ? implied.label : titleCaseComponent(cleaned) || "Service";
    const followUp = inferNaturalFollowUpForComponent(shapeLabel);
    return {
      strokeLabel: shapeLabel,
      summary: `Label "${shapeLabel}" + ghost ${followUp.label}`,
      shapeKindHint: implied && implied.kind !== "text" ? implied.kind : undefined,
      targetNodes: [followUp],
    };
  }

  if (explicit && wordCount >= 4) {
    const shapeLabel = titleCaseComponent(explicit.verb) || "Service";
    return {
      strokeLabel: shapeLabel,
      summary: `${shapeLabel} → ${explicit.target.label}`,
      targetNodes: [explicit.target],
    };
  }

  const componentLabel = titleCaseComponent(trimmed) || "Component";
  const inferredKind = inferNodeKindFromPhrase(componentLabel);
  const followUp = inferNaturalFollowUpForComponent(componentLabel);
  return {
    strokeLabel: componentLabel,
    summary: `Label "${componentLabel}" + ghost ${followUp.label}`,
    shapeKindHint: inferredKind === "text" ? "node" : inferredKind,
    targetNodes: [followUp],
  };
}

function measureTalkNode(spec: TalkToDrawNodeSpec): { width: number; height: number } {
  if (spec.kind === "diamond") {
    return {
      width: Math.min(200, Math.max(148, Math.round(spec.label.length * 8.4 + 54))),
      height: 94,
    };
  }
  if (spec.kind === "database") {
    return {
      width: Math.min(212, Math.max(158, Math.round(spec.label.length * 8.4 + 48))),
      height: 84,
    };
  }
  if (spec.kind === "ellipse") {
    return {
      width: Math.min(196, Math.max(146, Math.round(spec.label.length * 8.4 + 44))),
      height: 70,
    };
  }
  return {
    width: Math.min(216, Math.max(162, Math.round(spec.label.length * 8.6 + 44))),
    height: 72,
  };
}

/**
 * Computes a clean bounding box for a Talk-to-Draw ghost target node shifted past
 * the arrow tip along its direction vector so it never overlaps the arrow midpoint label pill.
 */
export function computeTalkGhostNodeRect(params: {
  start: Point;
  end: Point;
  nodeSize: { width: number; height: number };
  arrowLabel?: string;
  tipGap?: number;
}): Rect {
  const { start, end, nodeSize } = params;
  const tipGap = params.tipGap ?? 28;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);

  const ux = len > 4 ? dx / len : 1;
  const uy = len > 4 ? dy / len : 0;

  // Distance from node center to its rectangular boundary along unit ray (ux, uy)
  const hw = nodeSize.width / 2;
  const hh = nodeSize.height / 2;
  const boundaryHalf =
    1 / Math.max(Math.abs(ux) / Math.max(1, hw), Math.abs(uy) / Math.max(1, hh));

  // Ensure the arrow span between `start` and the near edge of the target node
  // leaves clean room for the midpoint label pill in any orientation.
  const lbl = (params.arrowLabel ?? "").trim();
  const pillW = lbl.length > 0 ? Math.max(48, lbl.length * 7.2 + 22) : 0;
  const pillH = lbl.length > 0 ? 22 : 0;
  const pillProjectedSpan =
    lbl.length > 0 ? Math.abs(ux) * pillW + Math.abs(uy) * pillH : 0;
  const minArrowSpan = Math.max(88, Math.ceil(pillProjectedSpan + 44));

  const extraPastTip = Math.max(tipGap, minArrowSpan - len);
  const centerDistFromEnd = extraPastTip + boundaryHalf;

  const cx = end.x + ux * centerDistFromEnd;
  const cy = end.y + uy * centerDistFromEnd;

  return {
    x: Math.round(cx - hw),
    y: Math.round(cy - hh),
    width: nodeSize.width,
    height: nodeSize.height,
  };
}

/**
 * Turns `(utterance, activeStroke, elements)` into a Jev `PredictedAction` that plugs
 * directly into Jev's ghost preview renderer + `Tab`/`Enter`/`Esc` acceptance flow.
 */
export function buildTalkToDrawPrediction(params: {
  utterance: string;
  activeStroke: StrokeTimelineEntry | null;
  elements: JevElement[];
  selectedIds?: string[];
  viewportCenter?: Point;
  llmOverride?: TalkToDrawLlmResult | null;
  now?: number;
}): TalkToDrawPredictionResult | null {
  const transcript = params.utterance.trim();
  if (!transcript) return null;

  const now = params.now ?? Date.now();
  const byId = new Map(params.elements.map((e) => [e.id, e]));

  // Resolve target element on canvas (correlated stroke element -> selected element -> standalone)
  let targetEl: JevElement | undefined = params.activeStroke?.elementId
    ? byId.get(params.activeStroke.elementId)
    : undefined;

  if (!targetEl && params.selectedIds && params.selectedIds.length > 0) {
    targetEl = byId.get(params.selectedIds[0]);
  }

  const effectiveKind: ElementKind =
    targetEl?.kind ?? params.activeStroke?.kind ?? "arrow";

  const parsed: TalkToDrawParsedSpec = params.llmOverride
    ? {
        strokeLabel: params.llmOverride.strokeLabel,
        summary: params.llmOverride.summary,
        shapeKindHint: params.llmOverride.shapeKindHint,
        targetNodes: params.llmOverride.targetNodes,
      }
    : parseTalkToDrawUtterance(transcript, effectiveKind);

  const patchElements: ElementPatch[] = [];
  const addElements: JevElement[] = [];
  const removeIds: string[] = [];

  const arrowEndpoints: { start: Point; end: Point } | null = (() => {
    if (targetEl && targetEl.kind === "arrow") {
      const resolved = resolveArrowEndpoints(targetEl, byId);
      return { start: resolved.start, end: resolved.end };
    }
    if (params.activeStroke && params.activeStroke.kind === "arrow") {
      return {
        start: params.activeStroke.startPoint,
        end: params.activeStroke.endPoint,
      };
    }
    return null;
  })();

  const anchorPoint: Point = (() => {
    if (arrowEndpoints) return arrowEndpoints.end;
    if (targetEl && isShapeElement(targetEl)) {
      return {
        x: targetEl.x + targetEl.width + 110,
        y: targetEl.y + targetEl.height / 2,
      };
    }
    if (params.activeStroke) {
      return params.activeStroke.endPoint;
    }
    return params.viewportCenter ?? { x: 420, y: 260 };
  })();

  let previousNodeId: string | undefined;
  let focusId: string | undefined;

  // CASE A: Active arrow stroke
  if (targetEl && targetEl.kind === "arrow") {
    const existingDest = targetEl.toId ? byId.get(targetEl.toId) : undefined;
    const isAutoSpawnedPlaceholder =
      existingDest !== undefined &&
      existingDest.kind === "node" &&
      existingDest.label === "New Step";

    const firstTarget = parsed.targetNodes[0];
    if (firstTarget) {
      const sz = measureTalkNode(firstTarget);
      const startPt = arrowEndpoints?.start ?? {
        x: anchorPoint.x - 140,
        y: anchorPoint.y,
      };
      const tipEnd =
        isAutoSpawnedPlaceholder && existingDest
          ? getElementCenter(existingDest)
          : arrowEndpoints?.end ?? anchorPoint;
      const computedRect = computeTalkGhostNodeRect({
        start: startPt,
        end: tipEnd,
        nodeSize: sz,
        arrowLabel: parsed.strokeLabel,
      });

      const preferredRect =
        isAutoSpawnedPlaceholder && existingDest
          ? (() => {
              // Keep placeholder's spot only if it already leaves clean room past the midpoint label pill
              const existingCenter = getElementCenter(existingDest);
              const existingDist = Math.hypot(
                existingCenter.x - startPt.x,
                existingCenter.y - startPt.y
              );
              const computedCenter = {
                x: computedRect.x + computedRect.width / 2,
                y: computedRect.y + computedRect.height / 2,
              };
              const minDist = Math.hypot(
                computedCenter.x - startPt.x,
                computedCenter.y - startPt.y
              );
              if (existingDist >= minDist - 24) {
                return {
                  x: existingDest.x,
                  y: existingDest.y,
                  width: sz.width,
                  height: sz.height,
                };
              }
              return computedRect;
            })()
          : computedRect;

      const ignoreIds = new Set<string>(
        isAutoSpawnedPlaceholder && existingDest ? [existingDest.id] : []
      );
      const freeSpot = findFreeSpot(
        preferredRect,
        params.elements.filter((e) => !ignoreIds.has(e.id))
      );

      const newNodeId = uid("ttd");
      const newNode: JevElement = {
        id: newNodeId,
        kind: firstTarget.kind,
        x: Math.round(freeSpot.x),
        y: Math.round(freeSpot.y),
        width: sz.width,
        height: sz.height,
        label: firstTarget.label,
        tone: firstTarget.tone ?? inferToneFromLabel(firstTarget.label),
        seed: makeSeed(newNodeId),
        createdAt: now,
        updatedAt: now,
        rev: 1,
      };
      addElements.push(newNode);
      previousNodeId = newNodeId;
      focusId = newNodeId;

      if (isAutoSpawnedPlaceholder && existingDest) {
        removeIds.push(existingDest.id);
        patchElements.push({
          id: targetEl.id,
          label: parsed.strokeLabel,
          toId: newNodeId,
          ...(firstTarget.dashed ? { dashed: true } : {}),
        });
      } else if (!targetEl.toId) {
        patchElements.push({
          id: targetEl.id,
          label: parsed.strokeLabel,
          toId: newNodeId,
          ...(firstTarget.dashed ? { dashed: true } : {}),
        });
      } else {
        // Arrow already connected A -> B: label it and splice/connect new node alongside
        patchElements.push({
          id: targetEl.id,
          label: parsed.strokeLabel,
          toId: newNodeId,
          ...(firstTarget.dashed ? { dashed: true } : {}),
        });
        const bridgeId = uid("ttda");
        addElements.push({
          id: bridgeId,
          kind: "arrow",
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          fromId: newNodeId,
          toId: targetEl.toId,
          label: "",
          tone: targetEl.tone,
          seed: makeSeed(bridgeId),
          arrowStyle: "curved",
          createdAt: now,
          updatedAt: now,
          rev: 1,
        });
      }

      // Chain any additional downstream targets (e.g. "validates JWT auth then hits Postgres")
      let chainCursorX = newNode.x + newNode.width + 92;
      const chainCursorY = newNode.y + newNode.height / 2;
      for (const extra of parsed.targetNodes.slice(1)) {
        const esz = measureTalkNode(extra);
        const spot = findFreeSpot(
          {
            x: chainCursorX,
            y: Math.round(chainCursorY - esz.height / 2),
            width: esz.width,
            height: esz.height,
          },
          [...params.elements, ...addElements]
        );
        const extraId = uid("ttd");
        const extraNode: JevElement = {
          id: extraId,
          kind: extra.kind,
          x: Math.round(spot.x),
          y: Math.round(spot.y),
          width: esz.width,
          height: esz.height,
          label: extra.label,
          tone: extra.tone ?? inferToneFromLabel(extra.label),
          seed: makeSeed(extraId),
          createdAt: now,
          updatedAt: now,
          rev: 1,
        };
        const arrId = uid("ttda");
        const extraArrow: JevElement = {
          id: arrId,
          kind: "arrow",
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          fromId: previousNodeId,
          toId: extraId,
          label: extra.edgeLabel ?? "",
          tone: extra.dashed ? "ochre" : "ink",
          seed: makeSeed(arrId),
          arrowStyle: "curved",
          ...(extra.dashed ? { dashed: true } : {}),
          createdAt: now,
          updatedAt: now,
          rev: 1,
        };
        addElements.push(extraNode, extraArrow);
        previousNodeId = extraId;
        focusId = extraId;
        chainCursorX = extraNode.x + extraNode.width + 92;
      }
    } else {
      patchElements.push({
        id: targetEl.id,
        label: parsed.strokeLabel,
      });
      focusId = targetEl.id;
    }
  } else if (targetEl && isShapeElement(targetEl)) {
    // CASE B: Active shape stroke (Box, Diamond, Database, Ellipse, etc.)
    const nextTone = inferToneFromLabel(parsed.strokeLabel);
    const shouldUpgradeKind =
      targetEl.kind === "node" &&
      parsed.shapeKindHint &&
      parsed.shapeKindHint !== "node" &&
      (targetEl.label === "Service" || targetEl.label === "New Step");

    patchElements.push({
      id: targetEl.id,
      label: parsed.strokeLabel,
      tone: nextTone,
      ...(shouldUpgradeKind ? { kind: parsed.shapeKindHint } : {}),
    });

    previousNodeId = targetEl.id;
    focusId = targetEl.id;

    const baseCenter = getElementCenter(targetEl);
    let cursorX = targetEl.x + targetEl.width + 96;

    for (const target of parsed.targetNodes) {
      const sz = measureTalkNode(target);
      const spot = findFreeSpot(
        {
          x: Math.round(cursorX),
          y: Math.round(baseCenter.y - sz.height / 2),
          width: sz.width,
          height: sz.height,
        },
        [...params.elements, ...addElements]
      );
      const newId = uid("ttd");
      const newNode: JevElement = {
        id: newId,
        kind: target.kind,
        x: Math.round(spot.x),
        y: Math.round(spot.y),
        width: sz.width,
        height: sz.height,
        label: target.label,
        tone: target.tone ?? inferToneFromLabel(target.label),
        seed: makeSeed(newId),
        createdAt: now,
        updatedAt: now,
        rev: 1,
      };
      const arrId = uid("ttda");
      const connArrow: JevElement = {
        id: arrId,
        kind: "arrow",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId: previousNodeId,
        toId: newId,
        label: target.edgeLabel ?? "",
        tone: target.dashed ? "ochre" : "ink",
        seed: makeSeed(arrId),
        arrowStyle: "curved",
        ...(target.dashed ? { dashed: true } : {}),
        createdAt: now,
        updatedAt: now,
        rev: 1,
      };
      addElements.push(newNode, connArrow);
      previousNodeId = newId;
      focusId = newId;
      cursorX = newNode.x + newNode.width + 96;
    }
  } else {
    // CASE C: Freedraw stroke or no committed target element yet (e.g. speaking mid-draw or standalone)
    const nodesToCreate: TalkToDrawNodeSpec[] =
      parsed.targetNodes.length > 0
        ? parsed.targetNodes
        : [
            {
              label: parsed.strokeLabel || titleCaseComponent(transcript) || "Node",
              kind: parsed.shapeKindHint ?? "node",
              tone: inferToneFromLabel(parsed.strokeLabel || transcript),
            },
          ];

    let cursorX = anchorPoint.x;
    const cursorY = anchorPoint.y;

    for (let i = 0; i < nodesToCreate.length; i++) {
      const spec = nodesToCreate[i];
      const sz = measureTalkNode(spec);
      const initialRect =
        i === 0 && arrowEndpoints
          ? computeTalkGhostNodeRect({
              start: arrowEndpoints.start,
              end: arrowEndpoints.end,
              nodeSize: sz,
              arrowLabel: parsed.strokeLabel,
            })
          : {
              x: Math.round(cursorX - (i === 0 ? sz.width / 2 : 0)),
              y: Math.round(cursorY - sz.height / 2),
              width: sz.width,
              height: sz.height,
            };
      const spot = findFreeSpot(
        initialRect,
        [...params.elements, ...addElements]
      );
      const newId = uid("ttd");
      const newNode: JevElement = {
        id: newId,
        kind: spec.kind,
        x: Math.round(spot.x),
        y: Math.round(spot.y),
        width: sz.width,
        height: sz.height,
        label: spec.label,
        tone: spec.tone ?? inferToneFromLabel(spec.label),
        seed: makeSeed(newId),
        createdAt: now,
        updatedAt: now,
        rev: 1,
      };
      addElements.push(newNode);

      if (i === 0 && params.activeStroke?.fromId && byId.has(params.activeStroke.fromId)) {
        const arrId = uid("ttda");
        addElements.push({
          id: arrId,
          kind: "arrow",
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          fromId: params.activeStroke.fromId,
          toId: newId,
          label: parsed.strokeLabel,
          tone: spec.dashed ? "ochre" : "ink",
          seed: makeSeed(arrId),
          arrowStyle: "curved",
          ...(spec.dashed ? { dashed: true } : {}),
          createdAt: now,
          updatedAt: now,
          rev: 1,
        });
      } else if (previousNodeId) {
        const arrId = uid("ttda");
        addElements.push({
          id: arrId,
          kind: "arrow",
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          fromId: previousNodeId,
          toId: newId,
          label: spec.edgeLabel ?? "",
          tone: spec.dashed ? "ochre" : "ink",
          seed: makeSeed(arrId),
          arrowStyle: "curved",
          ...(spec.dashed ? { dashed: true } : {}),
          createdAt: now,
          updatedAt: now,
          rev: 1,
        });
      }

      previousNodeId = newId;
      focusId = newId;
      cursorX = newNode.x + newNode.width + 96;
    }
  }

  const targetNodeLabels = addElements
    .filter((e) => isShapeElement(e))
    .map((e) => e.label);

  const title =
    targetNodeLabels.length > 0
      ? `"${parsed.strokeLabel}" → ${targetNodeLabels.join(" → ")}`
      : `Label "${parsed.strokeLabel}"`;

  const action: PredictedAction = {
    id: uid("ttd_act"),
    title: title.slice(0, 80),
    subtitle: `Voice: "${transcript.slice(0, 64)}"`,
    category: targetEl?.kind === "arrow" ? "connect" : "extend",
    feedbackKeys: ["cat:talk_to_draw", `ttd:${effectiveKind}`],
    addElements,
    ...(patchElements.length > 0 ? { patchElements } : {}),
    ...(removeIds.length > 0 ? { removeIds } : {}),
    focusId,
  };

  return {
    action,
    strokeLabel: parsed.strokeLabel,
    summary: parsed.summary,
    transcript,
    correlatedStroke: params.activeStroke,
    targetNodeLabels,
    isHeuristic: !params.llmOverride,
  };
}

/**
 * Atomically applies a Talk-to-Draw PredictedAction (label patch + ghost target nodes + placeholder cleanup)
 * in a single board state transition for single-step Undo/Redo & WebRTC sync.
 */
export function applyTalkToDrawAction(
  currentElements: JevElement[],
  action: PredictedAction,
  now = Date.now()
): JevElement[] {
  const removeSet = new Set(action.removeIds ?? []);
  const patchMap = new Map(
    (action.patchElements ?? []).map((p) => [p.id, p])
  );

  const updated = currentElements
    .filter((el) => !removeSet.has(el.id))
    .map((el) => {
      const p = patchMap.get(el.id);
      if (!p) return el;
      return {
        ...el,
        ...p,
        updatedAt: now,
      };
    });

  const framesToAdd = action.addElements.filter((e) => e.kind === "frame");
  const othersToAdd = action.addElements.filter((e) => e.kind !== "frame");
  return [...framesToAdd, ...updated, ...othersToAdd];
}
