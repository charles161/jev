import { inferToneFromLabel } from "./colors";
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

interface SemanticSuggestion {
  label: string;
  sublabel?: string;
  kind: ElementKind;
  edgeLabel?: string;
  tone?: ColorTone;
}

/**
 * Suggests domain-aware next components given the label of the current node.
 */
function inferNextStepsForLabel(
  label: string,
  existingLabels: Set<string>
): SemanticSuggestion[] {
  const l = label.toLowerCase();
  let candidates: SemanticSuggestion[] = [];

  if (/(user|client|browser|mobile|visitor|customer|frontend|app)/.test(l)) {
    candidates = [
      { label: "API Gateway", sublabel: "HTTPS / Edge", kind: "node", edgeLabel: "request" },
      { label: "Auth Check?", sublabel: "Session / OAuth", kind: "diamond", edgeLabel: "verify" },
      { label: "CDN / Edge Cache", sublabel: "Static & SSR", kind: "node", edgeLabel: "fetch" },
      { label: "WebRTC Peer", sublabel: "DataChannel", kind: "node", edgeLabel: "p2p sync" },
    ];
  } else if (/(auth|login|oauth|signup|sso|session|jwt)/.test(l)) {
    candidates = [
      { label: "Valid Token?", sublabel: "JWT verify", kind: "diamond", edgeLabel: "check" },
      { label: "API Gateway", sublabel: "Authorized", kind: "node", edgeLabel: "bearer" },
      { label: "User Store", sublabel: "Postgres", kind: "database", edgeLabel: "lookup" },
      { label: "Session Cache", sublabel: "Redis TTL", kind: "database", edgeLabel: "store" },
    ];
  } else if (/(gateway|api|server|backend|router|proxy|controller)/.test(l)) {
    candidates = [
      { label: "Redis Cache", sublabel: "Sub-ms lookup", kind: "database", edgeLabel: "read-through" },
      { label: "Core Service", sublabel: "Business logic", kind: "node", edgeLabel: "dispatch" },
      { label: "Postgres DB", sublabel: "Primary store", kind: "database", edgeLabel: "query" },
      { label: "Event Queue", sublabel: "Async jobs", kind: "node", edgeLabel: "publish" },
    ];
  } else if (/(cache|redis|memcache|cdn)/.test(l)) {
    candidates = [
      { label: "Cache Hit?", sublabel: "TTL check", kind: "diamond", edgeLabel: "lookup" },
      { label: "Postgres DB", sublabel: "Origin fallback", kind: "database", edgeLabel: "miss" },
      { label: "Invalidator", sublabel: "Pub/Sub", kind: "node", edgeLabel: "purge" },
    ];
  } else if (/(queue|kafka|rabbit|pubsub|stream|event|bus|broker)/.test(l)) {
    candidates = [
      { label: "Worker Pool", sublabel: "Consumers", kind: "node", edgeLabel: "consume" },
      { label: "Dead Letter Queue", sublabel: "Retry / Inspect", kind: "node", edgeLabel: "failed" },
      { label: "Analytics Sink", sublabel: "ClickHouse", kind: "database", edgeLabel: "ingest" },
    ];
  } else if (/(db|database|postgres|mysql|mongo|sqlite|store|storage|s3|warehouse)/.test(l)) {
    candidates = [
      { label: "Read Replica", sublabel: "Low-latency read", kind: "database", edgeLabel: "replicate" },
      { label: "Redis Cache", sublabel: "Hot keys", kind: "database", edgeLabel: "warm" },
      { label: "Backup / S3", sublabel: "Snapshots", kind: "database", edgeLabel: "archive" },
    ];
  } else if (/(webrtc|peer|p2p|signaling|mesh|collab|canvas|whiteboard|jev)/.test(l)) {
    candidates = [
      { label: "STUN / Signaling", sublabel: "ICE handshake", kind: "node", edgeLabel: "SDP" },
      { label: "CRDT State Sync", sublabel: "Conflict-free", kind: "node", edgeLabel: "ops" },
      { label: "Intent Engine", sublabel: "Live predictions", kind: "node", edgeLabel: "predict" },
      { label: "Local Storage", sublabel: "Offline-first", kind: "database", edgeLabel: "persist" },
    ];
  } else if (/(llm|ai|agent|model|prompt|rag|embed)/.test(l)) {
    candidates = [
      { label: "Vector DB", sublabel: "Embeddings", kind: "database", edgeLabel: "retrieve" },
      { label: "Tool Router", sublabel: "Function calls", kind: "diamond", edgeLabel: "decide" },
      { label: "Streaming Response", sublabel: "SSE / Tokens", kind: "node", edgeLabel: "stream" },
    ];
  } else if (/(worker|processor|service|billing|payment|order|checkout)/.test(l)) {
    candidates = [
      { label: "Postgres DB", sublabel: "Commit txn", kind: "database", edgeLabel: "write" },
      { label: "Event Bus", sublabel: "Emit domain event", kind: "node", edgeLabel: "emit" },
      { label: "Notification", sublabel: "Email / Webhook", kind: "node", edgeLabel: "notify" },
    ];
  } else {
    candidates = [
      { label: "Next Step", sublabel: "Continue flow", kind: "node", edgeLabel: "then" },
      { label: "Decision?", sublabel: "Branch logic", kind: "diamond", edgeLabel: "check" },
      { label: "Data Store", sublabel: "Persist state", kind: "database", edgeLabel: "save" },
    ];
  }

  // Filter out labels already on the canvas so predictions stay fresh
  const filtered = candidates.filter(
    (c) => !existingLabels.has(c.label.toLowerCase())
  );
  if (filtered.length >= 3) return filtered.slice(0, 3);

  const fallbacks: SemanticSuggestion[] = [
    { label: "Observability", sublabel: "Logs & Traces", kind: "node", edgeLabel: "telemetry" },
    { label: "Rate Limiter", sublabel: "Guardrail", kind: "diamond", edgeLabel: "throttle" },
    { label: "Audit Store", sublabel: "Append-only", kind: "database", edgeLabel: "record" },
  ];
  for (const f of fallbacks) {
    if (!existingLabels.has(f.label.toLowerCase()) && !filtered.some((x) => x.label === f.label)) {
      filtered.push(f);
    }
  }
  return filtered.slice(0, 3);
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
export function generatePredictions(
  intent: SpatialIntent | null,
  elements: JevElement[]
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
        const nextSteps = inferNextStepsForLabel(subject.label, existingLabels);
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
      const nextStep = inferNextStepsForLabel(subject.label, existingLabels)[0];
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
    const suggestion = inferNextStepsForLabel(subject.label, existingLabels)[0];
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
      const dbNode = makeNode("database", dbSpot.x, dbSpot.y, "Data Store", "Persist state", "teal");
      actions.push({
        id: uid("pred"),
        title: "Attach Data Store below",
        subtitle: "Connect persistent storage to this branch",
        category: "extend",
        addElements: [dbNode, makeArrow(subject.id, dbNode.id, "save")],
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
        title: `Two-way sync ${fromEl.label} ↔ ${toEl.label}`,
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

  const suggestions = inferNextStepsForLabel(anchor.label, existingLabels);

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
      title: `Attach ↘ ${s3.label}`,
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
  elements: JevElement[]
): PredictedAction[] {
  const base = generatePredictions(intent, elements);
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

  const extras = inferNextStepsForLabel(subject.label, existingLabels);
  for (let i = 0; i < extras.length && pool.length < 6; i++) {
    const s = extras[i];
    const title = `Add → ${s.label}`;
    if (existingTitles.has(title)) continue;
    const spot = findFreeSpot(
      {
        x: subject.x + subject.width + 96,
        y: subject.y + i * 96,
        width: 172,
        height: 72,
      },
      elements
    );
    const node = makeNode(s.kind, spot.x, spot.y, s.label, s.sublabel);
    pool.push({
      id: uid("pred"),
      title,
      subtitle: s.sublabel ? `${s.sublabel} · extend architecture` : "Extend flow",
      category: "extend",
      addElements: [node, makeArrow(subject.id, node.id, s.edgeLabel ?? "")],
      focusId: node.id,
    });
    existingTitles.add(title);
  }

  // Leave probability undefined until a live TypeSafe Jev model returns calibrated probabilities.
  // Attach compact pattern keys so the adaptive feedback store can learn user preferences.
  return pool.map((action) => ({
    ...action,
    feedbackKeys: buildActionFeedbackKeys(action, intent),
  }));
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
