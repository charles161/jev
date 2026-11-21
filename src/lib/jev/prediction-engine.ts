import { z } from "zod";
import { inferToneFromLabel } from "./colors";
import { findBoardCounterpart } from "./component-catalog";
import {
  computeBounds,
  findFreeSpot,
  getElementCenter,
  isShapeElement,
  makeSeed,
  uid,
} from "./geometry";
import {
  ColorTone,
  ElementKind,
  JevElement,
  PredictedAction,
  SpatialIntent,
} from "./types";
import { isComponentShape } from "./notation-kinds";
import { recognizeStroke, type StrokeShape } from "./stroke-recognition";

export interface SemanticSuggestion {
  label: string;
  sublabel?: string;
  kind: ElementKind;
  edgeLabel?: string;
  tone?: ColorTone;
}

export interface SuggestionContext {
  neighborLabels: string[];
  boardTitle?: string;
}

/** Labels that say nothing about the board. At most one may reach the visible top 3. */
export const GENERIC_SUGGESTION_LABELS: ReadonlySet<string> = new Set([
  "Next Step",
  "Decision?",
  "Data Store",
  "Observability",
  "Rate Limiter",
  "Audit Store",
  "Core Architecture",
  "Parallel Group",
]);

type LexiconRule = {
  match: RegExp;
  suggest: (ctx: SuggestionContext) => SemanticSuggestion[];
};

const isCommerce = (ctx: SuggestionContext) =>
  /(checkout|payment|billing|cart|order|stripe|invoice)/i.test(ctx.neighborLabels.join(" "));

const LEXICON: LexiconRule[] = [
  {
    match: /(error|fail|exception|fault|retry|incident|fallback)/,
    suggest: (ctx) => [
      { label: "Retry Queue", sublabel: "Backoff & retry", kind: "node", edgeLabel: "retry" },
      {
        label: isCommerce(ctx)
          ? "Payment Failed Alert"
          : ctx.neighborLabels[0]
            ? `${shortLabel(ctx.neighborLabels[0], 18)} Failed Alert`
            : "Failure Alert",
        sublabel: "Page on-call",
        kind: "node",
        edgeLabel: "alert",
      },
      { label: "Dead-letter Queue", sublabel: "Park & inspect", kind: "node", edgeLabel: "give up" },
      { label: "Error Log", sublabel: "Trace failures", kind: "database", edgeLabel: "record" },
    ],
  },
  {
    match: /(user|client|browser|mobile|visitor|customer|frontend|app)/,
    suggest: () => [
      { label: "API Gateway", sublabel: "HTTPS / Edge", kind: "node", edgeLabel: "request" },
      { label: "Auth Check?", sublabel: "Session / OAuth", kind: "diamond", edgeLabel: "verify" },
      { label: "CDN / Edge Cache", sublabel: "Static & SSR", kind: "node", edgeLabel: "fetch" },
      { label: "WebRTC Peer", sublabel: "DataChannel", kind: "node", edgeLabel: "p2p sync" },
    ],
  },
  {
    match: /(auth|login|oauth|signup|sso|session|jwt)/,
    suggest: () => [
      { label: "Valid Token?", sublabel: "JWT verify", kind: "diamond", edgeLabel: "check" },
      { label: "API Gateway", sublabel: "Authorized", kind: "node", edgeLabel: "bearer" },
      { label: "User Store", sublabel: "Postgres", kind: "database", edgeLabel: "lookup" },
      { label: "Session Cache", sublabel: "Redis TTL", kind: "database", edgeLabel: "store" },
    ],
  },
  {
    match: /(checkout|cart|payment|stripe)/,
    suggest: () => [
      { label: "Payment Gateway", sublabel: "Stripe / Adyen", kind: "node", edgeLabel: "charge" },
      { label: "Fraud Check?", sublabel: "Risk score", kind: "diamond", edgeLabel: "screen" },
      { label: "Orders DB", sublabel: "Commit order", kind: "database", edgeLabel: "write" },
      { label: "Receipt Email", sublabel: "Confirm purchase", kind: "node", edgeLabel: "notify" },
    ],
  },
  {
    match: /(notif|email|sms|push|webhook|alert)/,
    suggest: () => [
      { label: "Delivery Queue", sublabel: "Fan-out sends", kind: "node", edgeLabel: "enqueue" },
      { label: "Template Service", sublabel: "Render message", kind: "node", edgeLabel: "render" },
      { label: "Delivery Log", sublabel: "Sent / bounced", kind: "database", edgeLabel: "record" },
    ],
  },
  {
    match: /(chat|message|inbox|presence|dm\b)/,
    suggest: () => [
      { label: "WebSocket Gateway", sublabel: "Live connections", kind: "node", edgeLabel: "push" },
      { label: "Message Store", sublabel: "History", kind: "database", edgeLabel: "persist" },
      { label: "Presence Service", sublabel: "Online / typing", kind: "node", edgeLabel: "heartbeat" },
    ],
  },
  {
    match: /(feed|timeline|post|follow)/,
    suggest: () => [
      { label: "Fan-out Worker", sublabel: "Write to followers", kind: "node", edgeLabel: "fan out" },
      { label: "Feed Cache", sublabel: "Precomputed", kind: "database", edgeLabel: "read" },
      { label: "Ranking Service", sublabel: "Order items", kind: "node", edgeLabel: "rank" },
    ],
  },
  {
    match: /(search|index|query)/,
    suggest: () => [
      { label: "Search Index", sublabel: "Inverted index", kind: "database", edgeLabel: "query" },
      { label: "Indexer Worker", sublabel: "Keep in sync", kind: "node", edgeLabel: "index" },
      { label: "Query Parser", sublabel: "Tokenize", kind: "node", edgeLabel: "parse" },
    ],
  },
  {
    match: /(upload|file|image|media|video|photo)/,
    suggest: () => [
      { label: "Object Storage", sublabel: "S3 / R2", kind: "database", edgeLabel: "put" },
      { label: "Thumbnail Worker", sublabel: "Resize", kind: "node", edgeLabel: "process" },
      { label: "Media CDN", sublabel: "Edge delivery", kind: "node", edgeLabel: "serve" },
    ],
  },
  {
    match: /(gateway|api|server|backend|router|proxy|controller)/,
    suggest: () => [
      { label: "Redis Cache", sublabel: "Sub-ms lookup", kind: "database", edgeLabel: "read-through" },
      { label: "Core Service", sublabel: "Business logic", kind: "node", edgeLabel: "dispatch" },
      { label: "Postgres DB", sublabel: "Primary store", kind: "database", edgeLabel: "query" },
      { label: "Event Queue", sublabel: "Async jobs", kind: "node", edgeLabel: "publish" },
    ],
  },
  {
    match: /(cache|redis|memcache|cdn)/,
    suggest: () => [
      { label: "Cache Hit?", sublabel: "TTL check", kind: "diamond", edgeLabel: "lookup" },
      { label: "Postgres DB", sublabel: "Origin fallback", kind: "database", edgeLabel: "miss" },
      { label: "Invalidator", sublabel: "Pub/Sub", kind: "node", edgeLabel: "purge" },
    ],
  },
  {
    match: /(queue|kafka|rabbit|pubsub|stream|event|bus|broker)/,
    suggest: () => [
      { label: "Worker Pool", sublabel: "Consumers", kind: "node", edgeLabel: "consume" },
      { label: "Dead Letter Queue", sublabel: "Retry / Inspect", kind: "node", edgeLabel: "failed" },
      { label: "Analytics Sink", sublabel: "ClickHouse", kind: "database", edgeLabel: "ingest" },
    ],
  },
  {
    match: /(db|database|postgres|mysql|mongo|sqlite|store|storage|s3|warehouse)/,
    suggest: () => [
      { label: "Read Replica", sublabel: "Low-latency read", kind: "database", edgeLabel: "replicate" },
      { label: "Redis Cache", sublabel: "Hot keys", kind: "database", edgeLabel: "warm" },
      { label: "Backup / S3", sublabel: "Snapshots", kind: "database", edgeLabel: "archive" },
    ],
  },
  {
    match: /(webrtc|peer|p2p|signaling|mesh|collab|canvas|whiteboard|jev|skot)/,
    suggest: () => [
      { label: "STUN / Signaling", sublabel: "ICE handshake", kind: "node", edgeLabel: "SDP" },
      { label: "CRDT State Sync", sublabel: "Conflict-free", kind: "node", edgeLabel: "ops" },
      { label: "Intent Engine", sublabel: "Live predictions", kind: "node", edgeLabel: "predict" },
      { label: "Local Storage", sublabel: "Offline-first", kind: "database", edgeLabel: "persist" },
    ],
  },
  {
    match: /(llm|ai|agent|model|prompt|rag|embed)/,
    suggest: () => [
      { label: "Vector DB", sublabel: "Embeddings", kind: "database", edgeLabel: "retrieve" },
      { label: "Tool Router", sublabel: "Function calls", kind: "diamond", edgeLabel: "decide" },
      { label: "Streaming Response", sublabel: "SSE / Tokens", kind: "node", edgeLabel: "stream" },
    ],
  },
  {
    match: /(worker|processor|service|billing|order)/,
    suggest: () => [
      { label: "Postgres DB", sublabel: "Commit txn", kind: "database", edgeLabel: "write" },
      { label: "Event Bus", sublabel: "Emit domain event", kind: "node", edgeLabel: "emit" },
      { label: "Notification", sublabel: "Email / Webhook", kind: "node", edgeLabel: "notify" },
    ],
  },
];

function shortLabel(label: string, max = 22): string {
  const clean = label.replace(/\s+/g, " ").trim() || "This";
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function labelDerivedSuggestions(label: string): SemanticSuggestion[] {
  const name = shortLabel(label);
  return [
    { label: `After ${name}`, sublabel: `Continue from ${name}`, kind: "node", edgeLabel: "then" },
    { label: `${name} OK?`, sublabel: "Branch on outcome", kind: "diamond", edgeLabel: "check" },
    { label: `${name} Store`, sublabel: "Persist state", kind: "database", edgeLabel: "save" },
  ];
}

function lexiconSuggestions(text: string, ctx: SuggestionContext): SemanticSuggestion[] | null {
  const l = text.toLowerCase();
  const rule = LEXICON.find((r) => r.match.test(l));
  return rule ? rule.suggest(ctx) : null;
}

/**
 * Suggests context-named next components: first from the node's own label, then from its
 * neighbours and the board title, and finally names derived from the label itself.
 */
export function inferNextStepsForLabel(
  label: string,
  existingLabels: Set<string>,
  ctx: SuggestionContext = { neighborLabels: [] },
  /** The board: a suggestion it already has (its cache, its database, by name or role) is not offered again. */
  board: JevElement[] = []
): SemanticSuggestion[] {
  const surroundings = [...ctx.neighborLabels, ctx.boardTitle ?? ""].join(" ").trim();
  const derived = labelDerivedSuggestions(label);
  const candidates =
    lexiconSuggestions(label, ctx) ??
    (surroundings ? lexiconSuggestions(surroundings, ctx) : null) ??
    derived;

  const fresh = (c: SemanticSuggestion, picked: SemanticSuggestion[]) =>
    !existingLabels.has(c.label.toLowerCase()) &&
    !picked.some((x) => x.label === c.label) &&
    !findBoardCounterpart(c, board);
  const picked: SemanticSuggestion[] = [];
  for (const c of [...candidates, ...derived]) {
    if (picked.length < 3 && fresh(c, picked)) picked.push(c);
  }
  const fallbacks: SemanticSuggestion[] = [
    { label: "Observability", sublabel: "Logs & Traces", kind: "node", edgeLabel: "telemetry" },
    { label: "Rate Limiter", sublabel: "Guardrail", kind: "diamond", edgeLabel: "throttle" },
    { label: "Audit Store", sublabel: "Append-only", kind: "database", edgeLabel: "record" },
  ];
  for (const f of fallbacks) {
    if (picked.length < 3 && fresh(f, picked)) picked.push(f);
  }
  return picked;
}

function connectedLabels(anchorId: string, elements: JevElement[]): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const labels: string[] = [];
  for (const e of elements) {
    if (e.kind !== "arrow") continue;
    const otherId = e.fromId === anchorId ? e.toId : e.toId === anchorId ? e.fromId : undefined;
    const other = otherId ? byId.get(otherId) : undefined;
    const label = other?.label.trim();
    if (label && !labels.includes(label)) labels.push(label.slice(0, 80));
  }
  return labels.slice(0, 8);
}

export function suggestionContextFor(
  anchor: JevElement,
  elements: JevElement[],
  boardTitle?: string
): SuggestionContext {
  const title = boardTitle?.trim();
  return {
    neighborLabels: connectedLabels(anchor.id, elements),
    ...(title ? { boardTitle: title.slice(0, 120) } : {}),
  };
}

function makeNode(
  kind: ElementKind,
  x: number,
  y: number,
  label: string,
  sublabel?: string,
  tone?: ColorTone
): JevElement {
  const id = uid("el");
  const isDiamond = kind === "diamond";
  const isDb = kind === "database";
  const isEllipse = kind === "ellipse";
  const width = isDiamond ? 148 : isEllipse ? 154 : isDb ? 156 : 172;
  const height = isDiamond ? 96 : isDb ? 86 : 72;
  const now = Date.now();
  return {
    id,
    kind,
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
    label,
    sublabel,
    tone: tone ?? inferToneFromLabel(label),
    seed: makeSeed(id),
    createdAt: now,
    updatedAt: now,
  };
}

function makeArrow(
  fromId: string,
  toId: string,
  label = "",
  opts?: { dashed?: boolean; bidirectional?: boolean; tone?: ColorTone }
): JevElement {
  const id = uid("arr");
  const now = Date.now();
  return {
    id,
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label,
    tone: opts?.tone ?? "ink",
    seed: makeSeed(id),
    fromId,
    toId,
    arrowStyle: "curved",
    dashed: opts?.dashed,
    bidirectional: opts?.bidirectional,
    createdAt: now,
    updatedAt: now,
  };
}

function makeWrapperFrame(
  targets: JevElement[],
  label: string
): JevElement {
  const bounds = computeBounds(targets) ?? { x: 0, y: 0, width: 240, height: 140 };
  const padX = 34;
  const padTop = 44;
  const padBottom = 28;
  const id = uid("frm");
  const now = Date.now();
  return {
    id,
    kind: "frame",
    x: Math.round(bounds.x - padX),
    y: Math.round(bounds.y - padTop),
    width: Math.round(bounds.width + padX * 2),
    height: Math.round(bounds.height + padTop + padBottom),
    label,
    tone: "slate",
    seed: makeSeed(id),
    createdAt: now,
    updatedAt: now,
  };
}

function pickGapStep(fromLabel: string, toLabel: string): SemanticSuggestion {
  const combined = `${fromLabel} ${toLabel}`.toLowerCase();
  if (/(db|postgres|store|sql|mongo)/.test(toLabel.toLowerCase())) {
    return { label: "Redis Cache", sublabel: "Read-through", kind: "database", edgeLabel: "cache" };
  }
  if (/(worker|consumer|billing|email|notif)/.test(toLabel.toLowerCase())) {
    return { label: "Event Queue", sublabel: "Async buffer", kind: "node", edgeLabel: "enqueue" };
  }
  if (/(user|client|browser|mobile)/.test(fromLabel.toLowerCase())) {
    return { label: "Auth Guard", sublabel: "Verify session", kind: "diamond", edgeLabel: "auth" };
  }
  if (/(webrtc|peer|canvas)/.test(combined)) {
    return { label: "CRDT Sync", sublabel: "Delta merge", kind: "node", edgeLabel: "sync" };
  }
  return { label: "Middleware", sublabel: "Validate & route", kind: "node", edgeLabel: "via" };
}

/**
 * Generates exactly 3 context-aware, ghost-previewable next actions
 * that the user can cycle with Tab and commit with Enter.
 */
export interface PredictionOptions {
  boardTitle?: string;
}

export function generatePredictions(
  intent: SpatialIntent | null,
  elements: JevElement[],
  opts: PredictionOptions = {}
): PredictedAction[] {
  if (!intent || elements.length === 0) return [];

  const byId = new Map(elements.map((e) => [e.id, e]));
  const subject = intent.subjectId ? byId.get(intent.subjectId) : undefined;
  const existingLabels = new Set(
    elements.filter(isShapeElement).map((e) => e.label.trim().toLowerCase())
  );
  const actions: PredictedAction[] = [];

  // --- CASE 1: SPLICING INTO AN EXISTING EDGE ---
  if (intent.kind === "splice_into_edge" && subject && intent.relatedIds.length >= 3) {
    const [edgeId, fromId, toId] = intent.relatedIds;
    const fromEl = byId.get(fromId);
    const toEl = byId.get(toId);
    if (fromEl && toEl) {
      const a1 = makeArrow(fromEl.id, subject.id, "");
      const a2 = makeArrow(subject.id, toEl.id, "");
      actions.push({
        id: uid("pred"),
        title: `Splice ${fromEl.label} → ${subject.label} → ${toEl.label}`,
        subtitle: "Rewire existing arrow through this node",
        category: "connect",
        addElements: [a1, a2],
        removeIds: [edgeId],
        focusId: subject.id,
      });

      const branchArrow = makeArrow(fromEl.id, subject.id, "parallel", { dashed: true });
      actions.push({
        id: uid("pred"),
        title: `Branch ${fromEl.label} → ${subject.label} in parallel`,
        subtitle: `Keep ${fromEl.label} → ${toEl.label} intact`,
        category: "connect",
        addElements: [branchArrow],
        focusId: subject.id,
      });

      const frame = makeWrapperFrame(
        [fromEl, subject, toEl],
        `${fromEl.label} Pipeline`
      );
      actions.push({
        id: uid("pred"),
        title: "Wrap all 3 nodes into a pipeline zone",
        subtitle: "Group flow inside a named boundary frame",
        category: "structure",
        addElements: [frame],
        focusId: frame.id,
      });

      return actions.slice(0, 3);
    }
  }

  // --- CASE 2: OPENED A PIPELINE GAP ---
  if (intent.kind === "open_pipeline_gap" && subject && intent.relatedIds.length >= 2) {
    const [peerId, edgeId] = intent.relatedIds;
    const peer = byId.get(peerId);
    const edge = byId.get(edgeId);
    if (peer && edge) {
      const isPeerSource = edge.fromId === peer.id;
      const leftNode = isPeerSource ? peer : subject;
      const rightNode = isPeerSource ? subject : peer;
      const lc = getElementCenter(leftNode);
      const rc = getElementCenter(rightNode);
      const midX = (lc.x + rc.x) / 2;
      const midY = (lc.y + rc.y) / 2;

      const step = pickGapStep(leftNode.label, rightNode.label);
      const inserted = makeNode(
        step.kind,
        midX - 82,
        midY - 38,
        step.label,
        step.sublabel
      );
      const e1 = makeArrow(leftNode.id, inserted.id, step.edgeLabel ?? "");
      const e2 = makeArrow(inserted.id, rightNode.id, "");

      actions.push({
        id: uid("pred"),
        title: `Insert "${step.label}" in the gap`,
        subtitle: `Wire ${leftNode.label} → ${step.label} → ${rightNode.label}`,
        category: "extend",
        addElements: [inserted, e1, e2],
        removeIds: [edge.id],
        focusId: inserted.id,
      });

      // Option 2: Insert a decision gate
      const gate = makeNode(
        "diamond",
        midX - 74,
        midY - 48,
        "Valid?",
        "Guard check"
      );
      actions.push({
        id: uid("pred"),
        title: `Insert "Valid?" decision check in gap`,
        subtitle: "Add conditional routing between both nodes",
        category: "extend",
        addElements: [
          gate,
          makeArrow(leftNode.id, gate.id, ""),
          makeArrow(gate.id, rightNode.id, "yes"),
        ],
        removeIds: [edge.id],
        focusId: gate.id,
      });

      // Option 3: Wrap both connected nodes in a subsystem frame
      const gapFrame = makeWrapperFrame(
        [leftNode, rightNode],
        `${leftNode.label} Pipeline`
      );
      actions.push({
        id: uid("pred"),
        title: `Frame ${leftNode.label} → ${rightNode.label}`,
        subtitle: "Group this flow inside a named boundary",
        category: "structure",
        addElements: [gapFrame],
        focusId: gapFrame.id,
      });
      return actions.slice(0, 3);
    }
  }

  // --- CASE 3: DECISION BRANCH ---
  if (intent.kind === "decision_branch" && subject) {
    const rightSpot = findFreeSpot(
      { x: subject.x + subject.width + 110, y: subject.y - 46, width: 172, height: 72 },
      elements
    );
    const downSpot = findFreeSpot(
      { x: subject.x + subject.width + 110, y: subject.y + 68, width: 172, height: 72 },
      elements
    );

    const yesNode = makeNode("node", rightSpot.x, rightSpot.y, "Proceed", "Happy path", "teal");
    const noNode = makeNode("node", downSpot.x, downSpot.y, "Fallback / Retry", "Handle failure", "terracotta");

    actions.push({
      id: uid("pred"),
      title: "Split Yes → Proceed & No → Fallback",
      subtitle: "Generate both conditional branches at once",
      category: "extend",
      addElements: [
        yesNode,
        noNode,
        makeArrow(subject.id, yesNode.id, "Yes", { tone: "teal" }),
        makeArrow(subject.id, noNode.id, "No", { dashed: true, tone: "terracotta" }),
      ],
      focusId: yesNode.id,
    });

    const errSpot = findFreeSpot(
      { x: subject.x - 10, y: subject.y + subject.height + 92, width: 172, height: 72 },
      elements
    );
    const errNode = makeNode("node", errSpot.x, errSpot.y, "Error Handler", "Log & alert", "ochre");
    actions.push({
      id: uid("pred"),
      title: "Add Error Handler branch below",
      subtitle: "Connect dashed failure route underneath",
      category: "extend",
      addElements: [
        errNode,
        makeArrow(subject.id, errNode.id, "error", { dashed: true, tone: "ochre" }),
      ],
      focusId: errNode.id,
    });

    const auditSpot = findFreeSpot(
      { x: subject.x + subject.width + 110, y: subject.y + 10, width: 156, height: 86 },
      elements
    );
    const auditDb = makeNode("database", auditSpot.x, auditSpot.y, "Audit Log", "Record outcome", "teal");
    actions.push({
      id: uid("pred"),
      title: "Attach Audit Log store",
      subtitle: "Persist decision results",
      category: "extend",
      addElements: [auditDb, makeArrow(subject.id, auditDb.id, "log")],
      focusId: auditDb.id,
    });

    return actions.slice(0, 3);
  }

  // --- CASE 4: ALIGNING INTO PIPELINE / ROW ---
  if (intent.kind === "align_pipeline" && subject && intent.relatedIds.length > 0) {
    const peer = byId.get(intent.relatedIds[0]);
    if (peer) {
      const subjectIsRight = getElementCenter(subject).x >= getElementCenter(peer).x;
      const fromEl = subjectIsRight ? peer : subject;
      const toEl = subjectIsRight ? subject : peer;
      const alreadyLinked = elements.some(
        (e) =>
          e.kind === "arrow" &&
          ((e.fromId === peer.id && e.toId === subject.id) ||
            (e.fromId === subject.id && e.toId === peer.id))
      );

      const alignedY = Math.round(
        getElementCenter(peer).y - subject.height / 2
      );

      if (!alreadyLinked) {
        actions.push({
          id: uid("pred"),
          title: `Align & connect ${fromEl.label} → ${toEl.label}`,
          subtitle: "Snap row alignment and wire flow arrow",
          category: "connect",
          addElements: [makeArrow(fromEl.id, toEl.id, "")],
          patchElements: [{ id: subject.id, y: alignedY }],
          focusId: subject.id,
        });
      } else {
        const nextSteps = inferNextStepsForLabel(subject.label, existingLabels, suggestionContextFor(subject, elements, opts.boardTitle), elements);
        const step = nextSteps[0];
        const spot = findFreeSpot(
          {
            x: subject.x + subject.width + 96,
            y: alignedY,
            width: 172,
            height: 72,
          },
          elements
        );
        const nextNode = makeNode(step.kind, spot.x, spot.y, step.label, step.sublabel);
        actions.push({
          id: uid("pred"),
          title: `Continue row with → ${step.label}`,
          subtitle: "Extend aligned horizontal pipeline",
          category: "extend",
          addElements: [nextNode, makeArrow(subject.id, nextNode.id, step.edgeLabel ?? "")],
          patchElements: [{ id: subject.id, y: alignedY }],
          focusId: nextNode.id,
        });
      }

      // Option 2: Extend pipeline right with smart next step
      const nextStep = inferNextStepsForLabel(subject.label, existingLabels, suggestionContextFor(subject, elements, opts.boardTitle), elements)[0];
      const nextSpot = findFreeSpot(
        {
          x: Math.max(subject.x, peer.x) + subject.width + 98,
          y: alignedY,
          width: 172,
          height: 72,
        },
        elements
      );
      const continuation = makeNode(
        nextStep.kind,
        nextSpot.x,
        nextSpot.y,
        nextStep.label,
        nextStep.sublabel
      );
      actions.push({
        id: uid("pred"),
        title: `Add "${nextStep.label}" next in row`,
        subtitle: `Extend flow from ${subject.label}`,
        category: "extend",
        addElements: [
          continuation,
          makeArrow(subject.id, continuation.id, nextStep.edgeLabel ?? ""),
        ],
        focusId: continuation.id,
      });

      // Option 3: Wrap row into a subsystem frame
      const rowNodes = [peer, subject];
      const frame = makeWrapperFrame(rowNodes, `${fromEl.label} Flow`);
      actions.push({
        id: uid("pred"),
        title: `Group "${fromEl.label}" & "${toEl.label}" in frame`,
        subtitle: "Encapsulate aligned nodes in a boundary",
        category: "structure",
        addElements: [frame],
        focusId: frame.id,
      });

      return actions.slice(0, 3);
    }
  }

  // --- CASE 5: BRANCHING OUT / VERTICAL STACK ---
  if (
    (intent.kind === "branch_out" || intent.kind === "align_column") &&
    subject
  ) {
    const peer = intent.relatedIds[0] ? byId.get(intent.relatedIds[0]) : undefined;
    if (peer) {
      const alreadyLinked = elements.some(
        (e) =>
          e.kind === "arrow" &&
          ((e.fromId === peer.id && e.toId === subject.id) ||
            (e.fromId === subject.id && e.toId === peer.id))
      );
      if (!alreadyLinked) {
        actions.push({
          id: uid("pred"),
          title: `Fork arrow ${peer.label} → ${subject.label}`,
          subtitle: "Connect this branch off the main flow",
          category: "connect",
          addElements: [makeArrow(peer.id, subject.id, "branch")],
          focusId: subject.id,
        });
      }
    }

    // Twin parallel sibling
    const twinSpot = findFreeSpot(
      {
        x: subject.x + subject.width + 90,
        y: subject.y,
        width: subject.width,
        height: subject.height,
      },
      elements
    );
    const suggestion = inferNextStepsForLabel(subject.label, existingLabels, suggestionContextFor(subject, elements, opts.boardTitle), elements)[0];
    const twinNode = makeNode(
      suggestion.kind,
      twinSpot.x,
      twinSpot.y,
      suggestion.label,
      suggestion.sublabel
    );
    actions.push({
      id: uid("pred"),
      title: `Extend branch → ${suggestion.label}`,
      subtitle: "Add downstream step on this branch",
      category: "extend",
      addElements: [
        twinNode,
        makeArrow(subject.id, twinNode.id, suggestion.edgeLabel ?? ""),
      ],
      focusId: twinNode.id,
    });

    // Option 3: Wrap branch & anchor in zone, or attach a data store
    if (peer) {
      const frame = makeWrapperFrame([peer, subject], "Parallel Group");
      actions.push({
        id: uid("pred"),
        title: "Wrap branch & anchor in zone",
        subtitle: "Create a visual boundary frame",
        category: "structure",
        addElements: [frame],
        focusId: frame.id,
      });
    } else {
      const dbSpot = findFreeSpot(
        {
          x: subject.x,
          y: subject.y + subject.height + 92,
          width: 156,
          height: 86,
        },
        elements
      );
      const storeSuggestion =
        inferNextStepsForLabel(subject.label, existingLabels, suggestionContextFor(subject, elements, opts.boardTitle), elements).find(
          (s) => s.kind === "database"
        ) ?? { label: `${shortLabel(subject.label)} Store`, sublabel: "Persist state", edgeLabel: "save" };
      const dbNode = makeNode("database", dbSpot.x, dbSpot.y, storeSuggestion.label, storeSuggestion.sublabel, "teal");
      actions.push({
        id: uid("pred"),
        title: `Attach ${storeSuggestion.label} below`,
        subtitle: "Connect persistent storage to this branch",
        category: "extend",
        addElements: [dbNode, makeArrow(subject.id, dbNode.id, storeSuggestion.edgeLabel ?? "save")],
        focusId: dbNode.id,
      });
    }

    return actions.slice(0, 3);
  }

  // --- CASE 6: NEARBY UNCONNECTED NODE ---
  if (intent.kind === "connect_nearby" && subject && intent.relatedIds[0]) {
    const peer = byId.get(intent.relatedIds[0]);
    if (peer) {
      const fromEl =
        getElementCenter(peer).x <= getElementCenter(subject).x ? peer : subject;
      const toEl = fromEl.id === peer.id ? subject : peer;

      actions.push({
        id: uid("pred"),
        title: `Connect ${fromEl.label} → ${toEl.label}`,
        subtitle: "Link adjacent nodes with smart routed arrow",
        category: "connect",
        addElements: [makeArrow(fromEl.id, toEl.id, "")],
        focusId: subject.id,
      });

      actions.push({
        id: uid("pred"),
        title: `Two-way sync ${fromEl.label} ⇄ ${toEl.label}`,
        subtitle: "Add bidirectional data flow arrow",
        category: "connect",
        addElements: [
          makeArrow(fromEl.id, toEl.id, "sync", { bidirectional: true }),
        ],
        focusId: subject.id,
      });

      const frame = makeWrapperFrame([fromEl, toEl], `${fromEl.label} + ${toEl.label}`);
      actions.push({
        id: uid("pred"),
        title: "Group both into a shared zone",
        subtitle: "Draw boundary frame around both items",
        category: "structure",
        addElements: [frame],
        focusId: frame.id,
      });

      return actions.slice(0, 3);
    }
  }

  // --- DEFAULT / DOMAIN CONTINUATION ---
  const anchor =
    subject ??
    elements
      .filter((e) => isShapeElement(e) && e.kind !== "frame")
      .slice(-1)[0];

  if (!anchor) return [];

  const suggestions = inferNextStepsForLabel(anchor.label, existingLabels, suggestionContextFor(anchor, elements, opts.boardTitle), elements);

  // Option 1: Extend horizontally right
  const s1 = suggestions[0];
  const spot1 = findFreeSpot(
    {
      x: anchor.x + anchor.width + 96,
      y: anchor.y,
      width: 172,
      height: 72,
    },
    elements
  );
  const node1 = makeNode(s1.kind, spot1.x, spot1.y, s1.label, s1.sublabel);
  actions.push({
    id: uid("pred"),
    title: `Add → ${s1.label}`,
    subtitle: s1.sublabel ? `${s1.sublabel} · extend right` : "Extend flow right",
    category: "extend",
    addElements: [node1, makeArrow(anchor.id, node1.id, s1.edgeLabel ?? "")],
    focusId: node1.id,
  });

  // Option 2: Branch below
  const s2 = suggestions[1] ?? suggestions[0];
  const spot2 = findFreeSpot(
    {
      x: anchor.x + 20,
      y: anchor.y + anchor.height + 94,
      width: 172,
      height: 72,
    },
    elements
  );
  const node2 = makeNode(s2.kind, spot2.x, spot2.y, s2.label, s2.sublabel);
  actions.push({
    id: uid("pred"),
    title: `Branch ↓ ${s2.label}`,
    subtitle: s2.sublabel ? `${s2.sublabel} · add below` : "Create vertical branch",
    category: "extend",
    addElements: [
      node2,
      makeArrow(anchor.id, node2.id, s2.edgeLabel ?? "", { dashed: s2.kind === "diamond" }),
    ],
    focusId: node2.id,
  });

  // Option 3: Either wrap connected cluster in a frame OR add a 3rd semantic component
  const nonFrameShapes = elements.filter(
    (e) => isShapeElement(e) && e.kind !== "frame"
  );
  const hasFrames = elements.some((e) => e.kind === "frame");
  if (nonFrameShapes.length >= 3 && !hasFrames) {
    const clusterFrame = makeWrapperFrame(
      nonFrameShapes.slice(-4),
      "Core Architecture"
    );
    actions.push({
      id: uid("pred"),
      title: "Frame cluster as Core Architecture",
      subtitle: `Wrap ${Math.min(4, nonFrameShapes.length)} nodes in a boundary`,
      category: "structure",
      addElements: [clusterFrame],
      focusId: clusterFrame.id,
    });
  } else {
    const s3 = suggestions[2] ?? suggestions[0];
    const spot3 = findFreeSpot(
      {
        x: anchor.x + anchor.width + 96,
        y: anchor.y + 102,
        width: 172,
        height: 72,
      },
      elements
    );
    const node3 = makeNode(s3.kind, spot3.x, spot3.y, s3.label, s3.sublabel);
    actions.push({
      id: uid("pred"),
      title: `Attach ⇘ ${s3.label}`,
      subtitle: s3.sublabel ?? "Add supporting component",
      category: "extend",
      addElements: [node3, makeArrow(anchor.id, node3.id, s3.edgeLabel ?? "")],
      focusId: node3.id,
    });
  }

  return actions.slice(0, 3);
}

/**
 * Generates an expanded pool of 5–6 diverse candidate actions so TypeSafe Jev's
 * `choice` primitive can score all of them and return calibrated probabilities for Top 3.
 */
export function generateCandidatePool(
  intent: SpatialIntent | null,
  elements: JevElement[],
  opts: PredictionOptions = {}
): PredictedAction[] {
  const base = generatePredictions(intent, elements, opts);
  if (!intent || elements.length === 0) return base;

  const byId = new Map(elements.map((e) => [e.id, e]));
  const subject =
    (intent.subjectId ? byId.get(intent.subjectId) : undefined) ??
    elements.filter((e) => isShapeElement(e) && e.kind !== "frame").slice(-1)[0];
  if (!subject) return base;

  const existingLabels = new Set(
    elements.filter(isShapeElement).map((e) => e.label.trim().toLowerCase())
  );
  const existingTitles = new Set(base.map((a) => a.title));
  const pool = [...base];

  const extras = inferNextStepsForLabel(subject.label, existingLabels, suggestionContextFor(subject, elements, opts.boardTitle), elements);
  for (let i = 0; i < extras.length && pool.length < 6; i++) {
    const s = extras[i];
    const title = `Add → ${s.label}`;
    if (existingTitles.has(title)) continue;
    pool.push(extendFromSubject(uid("pred"), subject, s, i, elements, "extend architecture"));
    existingTitles.add(title);
  }

  pool.push(...linkCandidates(subject, elements));

  // Leave probability undefined until a live TypeSafe Jev model returns calibrated probabilities.
  // Attach compact pattern keys so the adaptive feedback store can learn user preferences.
  return pool.map((action) => ({
    ...action,
    feedbackKeys: buildActionFeedbackKeys(action, intent),
  }));
}

/** Same spot rule the pool has always used: right of the subject, one row (96px) per index. */
function extendFromSubject(
  id: string,
  subject: JevElement,
  s: SemanticSuggestion,
  index: number,
  elements: JevElement[],
  subtitleSuffix: string
): PredictedAction {
  const spot = findFreeSpot(
    {
      x: subject.x + subject.width + 96,
      y: subject.y + index * 96,
      width: 172,
      height: 72,
    },
    elements
  );
  const node = makeNode(s.kind, spot.x, spot.y, s.label, s.sublabel);
  return {
    id,
    title: `Add → ${s.label}`,
    subtitle: s.sublabel ? `${s.sublabel} · ${subtitleSuffix}` : "Extend flow",
    category: "extend",
    addElements: [node, makeArrow(subject.id, node.id, s.edgeLabel ?? "")],
    focusId: node.id,
  };
}

const MEANING_GROUPS: Array<[string, RegExp]> = [
  ["commerce", /(checkout|cart|payment|pay\b|order|billing|invoice|stripe|refund|inventory|product|shop)/],
  ["identity", /(auth|login|user|session|token|oauth|sso|account|signup|profile)/],
  ["messaging", /(queue|kafka|event|bus|worker|consumer|topic|broker|pubsub)/],
  ["chat", /(chat|message|inbox|presence|socket)/],
  ["feed", /(feed|post|timeline|follow)/],
  ["search", /(search|index|query)/],
  ["media", /(upload|file|image|media|video|photo|cdn)/],
  ["ai", /(llm|\bai\b|agent|model|prompt|embed|vector|rag)/],
  ["failure", /(error|retry|fail|alert|dead.?letter|dlq|incident)/],
  ["storage", /(\bdb\b|database|postgres|mysql|mongo|store|cache|redis|storage|s3)/],
];

function meaningGroups(label: string): Set<string> {
  const l = label.toLowerCase();
  return new Set(MEANING_GROUPS.filter(([, re]) => re.test(l)).map(([g]) => g));
}

/**
 * "Link X → Y" options between existing nodes that are not wired yet and where at least one side is
 * a lonely single element: the best pair by meaning first, then the nearest pair by distance.
 */
function linkCandidates(subject: JevElement, elements: JevElement[]): PredictedAction[] {
  const shapes = elements.filter((e) => isComponentShape(e) && e.label.trim());
  const arrows = elements.filter((e) => e.kind === "arrow");
  const wired = new Set(arrows.flatMap((a) => [a.fromId, a.toId]).filter(Boolean) as string[]);
  const linked = (a: string, b: string) =>
    arrows.some((e) => (e.fromId === a && e.toId === b) || (e.fromId === b && e.toId === a));

  type Pair = { a: JevElement; b: JevElement; shared: string[]; dist: number; touchesSubject: boolean };
  const pairs: Pair[] = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      if (linked(a.id, b.id) || (wired.has(a.id) && wired.has(b.id))) continue;
      const ga = meaningGroups(a.label);
      const shared = [...meaningGroups(b.label)].filter((g) => ga.has(g));
      const ca = getElementCenter(a);
      const cb = getElementCenter(b);
      pairs.push({
        a,
        b,
        shared,
        dist: Math.hypot(ca.x - cb.x, ca.y - cb.y),
        touchesSubject: a.id === subject.id || b.id === subject.id,
      });
    }
  }
  const bySubjectThenDistance = (x: Pair, y: Pair) =>
    Number(y.touchesSubject) - Number(x.touchesSubject) || x.dist - y.dist;
  const byMeaning = pairs.filter((p) => p.shared.length > 0).sort(bySubjectThenDistance)[0];
  const byDistance = pairs.filter((p) => p !== byMeaning).sort(bySubjectThenDistance)[0];

  return [byMeaning, byDistance]
    .filter((p): p is Pair => Boolean(p))
    .map((p) => {
      const [from, to] = getElementCenter(p.a).x <= getElementCenter(p.b).x ? [p.a, p.b] : [p.b, p.a];
      return {
        id: uid("pred"),
        title: `Link ${from.label} → ${to.label}`,
        subtitle: p.shared.length > 0 ? `Related by meaning · ${p.shared[0]}` : "Nearby, not connected yet",
        category: "connect" as const,
        addElements: [makeArrow(from.id, to.id, "")],
        focusId: to.id,
      };
    });
}

/** A suggestion an LLM proposed from board context; validated before it reaches the canvas. */
export const contextSuggestionSchema = z
  .object({
    id: z.string().regex(/^ctx_\d$/),
    label: z.string().trim().min(1).max(40),
    sublabel: z.string().trim().max(48).optional(),
    kind: z.enum(["node", "diamond", "database", "ellipse"]),
    edgeLabel: z.string().trim().max(24).optional(),
  })
  .strict();

export type ContextSuggestion = z.infer<typeof contextSuggestionSchema>;

export interface RankingContext {
  subjectLabel: string;
  neighborLabels: string[];
  boardTitle?: string;
}

function anchorFor(intent: SpatialIntent, elements: JevElement[]): JevElement | undefined {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return (
    (intent.subjectId ? byId.get(intent.subjectId) : undefined) ??
    elements.filter((e) => isShapeElement(e) && e.kind !== "frame").slice(-1)[0]
  );
}

export function buildRankingContext(
  intent: SpatialIntent | null,
  elements: JevElement[],
  boardTitle?: string
): RankingContext | null {
  if (!intent) return null;
  const anchor = anchorFor(intent, elements);
  if (!anchor || !anchor.label.trim()) return null;
  return { subjectLabel: anchor.label.trim().slice(0, 80), ...suggestionContextFor(anchor, elements, boardTitle) };
}

/** Puts LLM-proposed, context-named nodes at the front of the pool, placed by the pool's own spot rule. */
export function mergeContextSuggestions(
  pool: PredictedAction[],
  suggestions: ContextSuggestion[],
  intent: SpatialIntent | null,
  elements: JevElement[]
): PredictedAction[] {
  if (!intent || suggestions.length === 0) return pool;
  const subject = anchorFor(intent, elements);
  if (!subject) return pool;
  const taken = new Set([
    ...elements.filter(isShapeElement).map((e) => e.label.trim().toLowerCase()),
    ...pool.map((a) => a.addElements.find((e) => e.kind !== "arrow")?.label.trim().toLowerCase()).filter(Boolean),
  ]);
  const accepted: PredictedAction[] = [];
  for (const raw of suggestions) {
    const parsed = contextSuggestionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const s = parsed.data;
    const key = s.label.toLowerCase();
    if (GENERIC_SUGGESTION_LABELS.has(s.label) || taken.has(key)) continue;
    taken.add(key);
    const action = extendFromSubject(s.id, subject, s, accepted.length, elements, "from board context");
    accepted.push({ ...action, feedbackKeys: buildActionFeedbackKeys(action, intent) });
  }
  return [...accepted, ...pool];
}

const isLinkOnly = (a: PredictedAction) =>
  a.addElements.length > 0 && a.addElements.every((e) => e.kind === "arrow") && !a.removeIds?.length;

/** Context-named means it names something from this board: a link between real nodes, or a non-generic new node. */
export function isContextNamed(action: PredictedAction): boolean {
  if (action.addElements.length > 0 && action.addElements.every((e) => e.kind === "arrow")) return true;
  const added = action.addElements.find((e) => e.kind !== "arrow");
  return Boolean(added && added.label.trim() && !GENERIC_SUGGESTION_LABELS.has(added.label.trim()));
}

/**
 * Picks the visible top 3 from an already-ranked list: rank order is kept, at most one generic
 * option survives, and when a "link X → Y" option exists the best one is always shown.
 */
export function selectTopSuggestions(ranked: PredictedAction[]): PredictedAction[] {
  const order = new Map(ranked.map((a, i) => [a, i]));
  const picked: PredictedAction[] = [];
  let generic = 0;
  for (const a of ranked) {
    if (picked.length === 3) break;
    if (isContextNamed(a)) picked.push(a);
    else if (generic === 0) {
      picked.push(a);
      generic += 1;
    }
  }
  for (const a of ranked) {
    if (picked.length === 3) break;
    if (!picked.includes(a)) picked.push(a);
  }
  const bestLink = ranked.find(isLinkOnly);
  if (bestLink && !picked.includes(bestLink) && picked.length > 0) {
    const replaceable = [...picked].reverse().find((a) => !isLinkOnly(a));
    if (replaceable) picked.splice(picked.indexOf(replaceable), 1, bestLink);
  }
  return picked.sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
}

/** Relation verb for an arrow by what the target is: stores are written to, queues published to, etc. */
export function relationVerb(from: JevElement, to: JevElement): string {
  const t = meaningGroups(to.label);
  if (to.kind === "database" || t.has("storage")) return /cache|redis/i.test(to.label) ? "reads from" : "writes to";
  if (t.has("messaging")) return "publishes to";
  if (t.has("identity")) return "authenticates via";
  if (t.has("failure")) return "reports to";
  if (meaningGroups(from.label).has("failure")) return "retries";
  return "calls";
}

/** Who points at whom: stores and queues are targets; otherwise left to right. */
export function orientPair(a: JevElement, b: JevElement): [JevElement, JevElement] {
  const sinkRank = (e: JevElement) => {
    const g = meaningGroups(e.label);
    return e.kind === "database" || g.has("storage") ? 2 : g.has("messaging") ? 1 : 0;
  };
  if (sinkRank(a) !== sinkRank(b)) return sinkRank(a) < sinkRank(b) ? [a, b] : [b, a];
  return getElementCenter(a).x <= getElementCenter(b).x ? [a, b] : [b, a];
}

const GROUP_NEXT_NODE: Array<[string, SemanticSuggestion]> = [
  ["commerce", { label: "Order Service", sublabel: "Coordinates the order", kind: "node" }],
  ["identity", { label: "Session Service", sublabel: "Shared identity", kind: "node" }],
  ["chat", { label: "Messaging Gateway", sublabel: "Fan-in connections", kind: "node" }],
  ["feed", { label: "Feed Service", sublabel: "Assemble timelines", kind: "node" }],
  ["search", { label: "Search Service", sublabel: "Query & index", kind: "node" }],
  ["media", { label: "Media Pipeline", sublabel: "Process assets", kind: "node" }],
  ["ai", { label: "Agent Orchestrator", sublabel: "Route model calls", kind: "node" }],
  ["failure", { label: "Incident Manager", sublabel: "Triage failures", kind: "node" }],
  ["messaging", { label: "Event Router", sublabel: "Route events", kind: "node" }],
  ["storage", { label: "Data Access Layer", sublabel: "One way to the data", kind: "node" }],
];

/** The next node that relates to the whole group, named by the meaning the group shares most. */
export function groupNextNode(shapes: JevElement[], existingLabels: Set<string>): SemanticSuggestion {
  const counts = new Map<string, number>();
  for (const s of shapes) for (const g of meaningGroups(s.label)) counts.set(g, (counts.get(g) ?? 0) + 1);
  const ranked = GROUP_NEXT_NODE.filter(([g]) => counts.has(g)).sort(
    ([a], [b]) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
  );
  for (const [, s] of ranked) if (!existingLabels.has(s.label.toLowerCase())) return s;
  const names = shapes.slice(0, 2).map((s) => shortLabel(s.label, 14));
  return { label: `${names.join(" + ")} Hub`, sublabel: "Ties the selection together", kind: "node" };
}

/**
 * Context predictions for the user's current selection. One node: the normal pipeline anchored to it.
 * Several: links between the unconnected ones (by meaning, with a relation label), one next node that
 * relates to the whole group, and a frame named after the group.
 */
export function generateSelectionPredictions(
  selectedIds: string[],
  elements: JevElement[],
  opts: PredictionOptions = {}
): { intent: SpatialIntent; pool: PredictedAction[] } | null {
  const selected = new Set(selectedIds);
  const shapes = elements.filter(
    (e) => selected.has(e.id) && isShapeElement(e) && e.kind !== "frame" && e.kind !== "arrow"
  );
  if (shapes.length === 0) return null;

  if (shapes.length === 1) {
    const subject = shapes[0];
    const intent: SpatialIntent = {
      kind: "domain_continue",
      headline: `Next from "${subject.label || subject.kind}"`,
      detail: "Context predictions for the selected node",
      subjectId: subject.id,
      relatedIds: [],
      timestamp: Date.now(),
    };
    return { intent, pool: generateCandidatePool(intent, elements, opts) };
  }

  const intent: SpatialIntent = {
    kind: "domain_continue",
    headline: `Predictions for ${shapes.length} selected nodes`,
    detail: shapes.map((s) => s.label).filter(Boolean).slice(0, 3).join(", "),
    subjectId: shapes[0].id,
    relatedIds: shapes.slice(1).map((s) => s.id),
    timestamp: Date.now(),
  };
  const arrows = elements.filter((e) => e.kind === "arrow");
  const linked = (a: string, b: string) =>
    arrows.some((e) => (e.fromId === a && e.toId === b) || (e.fromId === b && e.toId === a));
  const existingLabels = new Set(elements.filter(isShapeElement).map((e) => e.label.trim().toLowerCase()));
  const pool: PredictedAction[] = [];

  const pairs: Array<{ a: JevElement; b: JevElement; shared: number; dist: number }> = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [a, b] = [shapes[i], shapes[j]];
      if (linked(a.id, b.id)) continue;
      const ga = meaningGroups(a.label);
      const shared = [...meaningGroups(b.label)].filter((g) => ga.has(g)).length;
      const ca = getElementCenter(a);
      const cb = getElementCenter(b);
      pairs.push({ a, b, shared, dist: Math.hypot(ca.x - cb.x, ca.y - cb.y) });
    }
  }
  pairs.sort((x, y) => y.shared - x.shared || x.dist - y.dist);
  for (const p of pairs.slice(0, 3)) {
    const [from, to] = orientPair(p.a, p.b);
    const verb = relationVerb(from, to);
    pool.push({
      id: uid("pred"),
      title: `Link ${from.label} → ${to.label}`,
      subtitle: `${from.label} ${verb} ${to.label}`,
      category: "connect",
      addElements: [makeArrow(from.id, to.id, verb)],
      focusId: to.id,
    });
  }

  const hub = groupNextNode(shapes, existingLabels);
  const bounds = computeBounds(shapes) ?? { x: 0, y: 0, width: 0, height: 0 };
  const spot = findFreeSpot(
    { x: bounds.x + bounds.width + 96, y: bounds.y + bounds.height / 2 - 36, width: 172, height: 72 },
    elements
  );
  const hubNode = makeNode(hub.kind, spot.x, spot.y, hub.label, hub.sublabel);
  pool.push({
    id: uid("pred"),
    title: `Add → ${hub.label}`,
    subtitle: `Connected to all ${shapes.length} selected`,
    category: "extend",
    addElements: [hubNode, ...shapes.map((s) => makeArrow(hubNode.id, s.id, relationVerb(hubNode, s)))],
    focusId: hubNode.id,
  });

  const zone = hub.label.replace(/\s+(Service|Gateway|Pipeline|Orchestrator|Manager|Router|Layer|Hub)$/i, "");
  const frame = makeWrapperFrame(shapes, `${zone} Zone`);
  pool.push({
    id: uid("pred"),
    title: `Frame selection as ${zone} Zone`,
    subtitle: `Group ${shapes.length} nodes in a named boundary`,
    category: "structure",
    addElements: [frame],
    focusId: frame.id,
  });

  return { intent, pool: pool.map((a) => ({ ...a, feedbackKeys: buildActionFeedbackKeys(a, intent) })) };
}

export function buildActionFeedbackKeys(
  action: PredictedAction,
  intent: SpatialIntent | null
): string[] {
  const keys = [`cat:${action.category}`];
  if (intent) {
    keys.push(`intent:${intent.kind}`);
  }
  const firstAddedShape = action.addElements.find(
    (e) => e.kind !== "arrow"
  );
  if (firstAddedShape) {
    keys.push(`kind:${firstAddedShape.kind}`);
  }
  const lowerTitle = action.title.toLowerCase();
  if (/cache|redis/.test(lowerTitle)) keys.push("pattern:cache");
  else if (/queue|kafka|event/.test(lowerTitle)) keys.push("pattern:queue");
  else if (/frame|zone|wrap/.test(lowerTitle)) keys.push("pattern:frame");
  else if (/gateway|auth|guard/.test(lowerTitle)) keys.push("pattern:gateway");
  else if (/splice/.test(lowerTitle)) keys.push("pattern:splice");
  else if (/replica|postgres|store|db/.test(lowerTitle)) keys.push("pattern:store");
  return Array.from(new Set(keys));
}

/**
 * Serializes the whiteboard graph + latest spatial gesture into a concise state
 * string for TypeSafe Jev (`POST /v1/systemone`).
 */
export function serializeCanvasStateForJev(
  intent: SpatialIntent,
  elements: JevElement[]
): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const shapes = elements.filter((e) => isShapeElement(e) && e.kind !== "frame");
  const frames = elements.filter((e) => e.kind === "frame");
  const arrows = elements.filter((e) => e.kind === "arrow");

  const nodeLines = shapes
    .slice(0, 24)
    .map(
      (n) =>
        `- [${n.kind}] "${n.label}"${n.sublabel ? ` (${n.sublabel})` : ""} at (${Math.round(n.x)}, ${Math.round(n.y)})`
    );

  const edgeLines = arrows.slice(0, 24).map((a) => {
    const f = a.fromId ? byId.get(a.fromId)?.label ?? a.fromId : "point";
    const t = a.toId ? byId.get(a.toId)?.label ?? a.toId : "point";
    return `- "${f}" ${a.bidirectional ? "<->" : "->"} "${t}"${a.label ? ` [${a.label}]` : ""}`;
  });

  const frameLines = frames.slice(0, 8).map((f) => `- Zone "${f.label}"`);
  const subject = intent.subjectId ? byId.get(intent.subjectId) : undefined;

  return [
    "WHITEBOARD STATE:",
    `Nodes (${shapes.length}):`,
    ...nodeLines,
    edgeLines.length > 0 ? `Connections (${arrows.length}):` : "Connections: none",
    ...edgeLines,
    frameLines.length > 0 ? `Zones: ${frameLines.join(", ")}` : "",
    "",
    "LATEST USER GESTURE:",
    `Subject: ${subject ? `[${subject.kind}] "${subject.label}"` : "canvas"}`,
    `Local geometric observation: ${intent.headline} (${intent.detail})`,
    intent.delta
      ? `Drag delta: dx=${Math.round(intent.delta.dx)}px, dy=${Math.round(intent.delta.dy)}px`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The title a fresh board starts with; it says nothing about the board, so naming ignores it. */
export const DEFAULT_BOARD_TITLE = "Untitled Sheet";

type StrokeResult = { intent: SpatialIntent; pool: PredictedAction[] };

const SHAPE_WORDS: Record<StrokeShape, string> = {
  node: "a node",
  database: "a database",
  diamond: "a diamond",
  ellipse: "an ellipse",
};
const SHAPE_NOUNS: Record<StrokeShape, string> = {
  node: "Service",
  database: "Database",
  diamond: "Decision",
  ellipse: "User",
};
const ACTOR_NAMES: Array<[string, string]> = [
  ["commerce", "Customer"],
  ["identity", "End User"],
  ["chat", "Chat Participant"],
  ["feed", "Reader"],
  ["media", "Uploader"],
  ["ai", "Prompt Author"],
  ["search", "Searcher"],
  ["failure", "On-call Engineer"],
  ["messaging", "Event Producer"],
  ["storage", "Data Analyst"],
];

const nameOf = (e: JevElement) => e.label.trim() || e.kind;

function strokeConnect(path: string[], board: JevElement[]): StrokeResult | null {
  const byId = new Map(board.map((e) => [e.id, e]));
  const nodes = path.map((id) => byId.get(id)).filter((e): e is JevElement => Boolean(e));
  if (nodes.length < 2) return null;
  const arrows = board.filter((e) => e.kind === "arrow");
  const linked = (a: string, b: string) =>
    arrows.some((e) => (e.fromId === a && e.toId === b) || (e.fromId === b && e.toId === a));
  const option = (chain: JevElement[]): PredictedAction | null => {
    const hops = chain.slice(1).map((to, i) => [chain[i], to] as const).filter(([f, t]) => !linked(f.id, t.id));
    if (hops.length === 0) return null;
    return {
      id: uid("pred"),
      title: `Connect ${chain.map(nameOf).join(" → ")}`,
      subtitle: hops.map(([f, t]) => `${nameOf(f)} ${relationVerb(f, t)} ${nameOf(t)}`).join("; "),
      category: "connect",
      addElements: hops.map(([f, t]) => makeArrow(f.id, t.id, relationVerb(f, t))),
      focusId: chain[chain.length - 1].id,
    };
  };
  const pool = [option(nodes), nodes.length > 2 ? option([nodes[0], nodes[nodes.length - 1]]) : null].filter(
    (a): a is PredictedAction => Boolean(a)
  );
  const intent: SpatialIntent = {
    kind: "connect_nearby",
    headline: `Pen stroke from "${nameOf(nodes[0])}" to "${nameOf(nodes[nodes.length - 1])}"`,
    detail: "Connect the nodes the stroke links",
    subjectId: nodes[0].id,
    relatedIds: nodes.slice(1).map((n) => n.id),
    timestamp: Date.now(),
  };
  return { intent, pool };
}

function strokeShapeNames(
  shape: StrokeShape,
  actor: boolean,
  nearest: JevElement[],
  board: JevElement[],
  boardTitle: string | undefined
): SemanticSuggestion[] {
  const existing = new Set(board.filter(isShapeElement).map((e) => e.label.trim().toLowerCase()));
  const usable = (s: SemanticSuggestion) =>
    !GENERIC_SUGGESTION_LABELS.has(s.label) && !existing.has(s.label.toLowerCase());
  if (actor || shape === "ellipse") {
    const text = [...nearest.map((n) => n.label), ...nearest.flatMap((n) => connectedLabels(n.id, board)), boardTitle ?? ""].join(" ");
    const groups = meaningGroups(text);
    const names = ACTOR_NAMES.filter(([g]) => groups.has(g)).map(([, label]) => label);
    if (nearest[0]) names.push(`${shortLabel(nameOf(nearest[0]), 16)} User`);
    names.push(SHAPE_NOUNS.ellipse);
    return [...new Set(names)]
      .map((label): SemanticSuggestion => ({ label, sublabel: "Actor", kind: "ellipse" }))
      .filter(usable)
      .slice(0, 3);
  }
  const sources: Array<{ label: string; ctx: SuggestionContext }> = nearest.length
    ? nearest.map((n) => ({ label: nameOf(n), ctx: suggestionContextFor(n, board, boardTitle) }))
    : boardTitle
      ? [{ label: boardTitle, ctx: { neighborLabels: [], boardTitle } }]
      : [];
  const picked: SemanticSuggestion[] = [];
  const consider = (list: SemanticSuggestion[]) => {
    for (const s of list) {
      if (picked.length < 3 && s.kind === shape && usable(s) && !picked.some((p) => p.label === s.label)) picked.push(s);
    }
  };
  for (const src of sources) consider(inferNextStepsForLabel(src.label, existing, src.ctx));
  for (const src of sources) consider(labelDerivedSuggestions(src.label));
  return picked.length ? picked : [{ label: SHAPE_NOUNS[shape], kind: shape }];
}

function strokeShape(
  shape: StrokeShape,
  box: { x: number; y: number; width: number; height: number },
  actor: boolean,
  board: JevElement[],
  boardTitle: string | undefined
): StrokeResult {
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = (e: JevElement) => {
    const c = getElementCenter(e);
    return Math.hypot(c.x - centre.x, c.y - centre.y);
  };
  const nearest = board
    .filter((e) => isShapeElement(e) && e.kind !== "frame" && e.kind !== "text" && e.label.trim())
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, 2);
  const names = strokeShapeNames(shape, actor, nearest, board, boardTitle);
  const word = actor ? "an actor" : SHAPE_WORDS[shape];
  const pool = names.map((s): PredictedAction => {
    const node = makeNode(shape, box.x, box.y, s.label, s.sublabel);
    const placed: JevElement = actor
      ? { ...node, x: Math.round(centre.x - node.width / 2), y: Math.round(centre.y - node.height / 2) }
      : { ...node, width: Math.max(box.width, 96), height: Math.max(box.height, 56) };
    return {
      id: uid("pred"),
      title: `Turn into ${word}: ${s.label}`,
      subtitle: nearest[0] ? `Drawn as ${word} · named from ${nameOf(nearest[0])}` : `Drawn as ${word}`,
      category: "extend",
      addElements: [placed],
      focusId: placed.id,
    };
  });
  const intent: SpatialIntent = {
    kind: "domain_continue",
    headline: `Pen stroke looks like ${word}`,
    detail: "Turn the drawing into a node",
    subjectId: nearest[0]?.id,
    relatedIds: [],
    timestamp: Date.now(),
  };
  return { intent, pool };
}

function strokeLasso(ids: string[], board: JevElement[], opts: PredictionOptions): StrokeResult | null {
  const selection = generateSelectionPredictions(ids, board, opts);
  if (!selection) return null;
  const frameOption = selection.pool.find((a) => a.category === "structure" && a.addElements[0]?.kind === "frame");
  const rest = selection.pool.filter((a) => a !== frameOption);
  const group: PredictedAction[] = frameOption
    ? [{
        ...frameOption,
        id: uid("pred"),
        title: `Group these: ${frameOption.addElements[0].label}`,
        subtitle: `Frame the ${ids.length} circled nodes`,
      }]
    : [];
  const intent: SpatialIntent = {
    ...selection.intent,
    kind: "encapsulate_group",
    headline: `Lasso around ${ids.length} nodes`,
  };
  return { intent, pool: [...group, ...rest] };
}

/**
 * Predictions for a finished pen stroke: connect the nodes it links, turn a closed drawing into a node, or
 * group the nodes it circles. Every option removes the stroke when accepted (and only then); a stroke that
 * reads as nothing returns null and stays on the board.
 */
export function generateStrokePredictions(
  stroke: JevElement,
  elements: JevElement[],
  opts: PredictionOptions = {}
): StrokeResult | null {
  const board = elements.filter((e) => e.id !== stroke.id);
  const reading = recognizeStroke(stroke.points ?? [], board);
  const title = opts.boardTitle?.trim();
  const boardTitle = title && title !== DEFAULT_BOARD_TITLE ? title.slice(0, 120) : undefined;
  const result =
    reading.kind === "connect"
      ? strokeConnect(reading.path, board)
      : reading.kind === "lasso"
        ? strokeLasso(reading.enclosedIds, board, { boardTitle })
        : reading.kind === "shape"
          ? strokeShape(reading.shape, reading.box, reading.actor, board, boardTitle)
          : null;
  if (!result || result.pool.length === 0) return null;
  return {
    intent: result.intent,
    pool: result.pool.map((a) => {
      const action = { ...a, removeIds: [stroke.id] };
      return { ...action, feedbackKeys: buildActionFeedbackKeys(action, result.intent) };
    }),
  };
}

/** What Enter does with a prediction: remove, patch, then add (frames behind everything). Null applies nothing. */
export function applyPredictionToElements(elements: JevElement[], pred: PredictedAction | null): JevElement[] {
  if (!pred) return elements;
  const removeSet = new Set(pred.removeIds ?? []);
  const patchMap = new Map((pred.patchElements ?? []).map((p) => [p.id, p]));
  const updated = elements
    .filter((el) => !removeSet.has(el.id))
    .map((el) => {
      const p = patchMap.get(el.id);
      return p ? { ...el, ...p, updatedAt: Date.now() } : el;
    });
  const framesToAdd = pred.addElements.filter((e) => e.kind === "frame");
  const othersToAdd = pred.addElements.filter((e) => e.kind !== "frame");
  return [...framesToAdd, ...updated, ...othersToAdd];
}
