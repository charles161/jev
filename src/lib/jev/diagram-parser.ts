import { inferToneFromLabel } from "./colors";
import { computeBounds, makeSeed, uid } from "./geometry";
import { ColorTone, ElementKind, JevElement } from "./types";

interface ParsedNode {
  key: string;
  label: string;
  sublabel?: string;
  kind: ElementKind;
  tone: ColorTone;
  layer: number;
  group?: string;
}

interface ParsedEdge {
  fromKey: string;
  toKey: string;
  label?: string;
  dashed?: boolean;
  bidirectional?: boolean;
}

interface ParsedGraph {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  frames?: Array<{ label: string; nodeKeys: string[] }>;
  summary: string;
}

function inferKindFromLabel(label: string): ElementKind {
  const l = label.toLowerCase();
  if (
    /(\?|check|valid|decide|condition|gate|hit\?|authorized|approved|if\s)/.test(l)
  ) {
    return "diamond";
  }
  if (
    /(db|database|postgres|mysql|mongo|sqlite|redis|cache|store|storage|s3|bucket|warehouse|vector|clickhouse|dynamo|replica|index)/.test(
      l
    )
  ) {
    return "database";
  }
  if (/(^user$|^client$|^browser$|^mobile$|^visitor$|^customer$|^start$|^end$|^peer\s?[a-z0-9]?$)/.test(l.trim())) {
    return "ellipse";
  }
  return "node";
}

function cleanLabel(raw: string): string {
  const trimmed = raw
    .replace(/^[\[\(\{\s]+|[\]\)\}\s]+$/g, "")
    .replace(/^(a|an|the)\s+/i, "")
    .trim();
  if (!trimmed) return "";
  // Title-case gently while preserving acronyms like API, JWT, WebRTC, DB, AI, SQL
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (word === word.toUpperCase() && word.length >= 2) return word;
      if (/^(WebRTC|CRDT|OAuth|PostgreSQL|Postgres|GraphQL|Next\.js|Node\.js|GitHub|YouTube|iOS|macOS)$/i.test(word)) {
        const map: Record<string, string> = {
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
        };
        return map[word.toLowerCase()] ?? word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function nodeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function createParsedNode(
  rawLabel: string,
  layer: number,
  sublabel?: string,
  explicitKind?: ElementKind
): ParsedNode {
  const label = cleanLabel(rawLabel);
  const kind = explicitKind ?? inferKindFromLabel(label);
  return {
    key: nodeKey(label) || uid("n"),
    label,
    sublabel,
    kind,
    tone: inferToneFromLabel(label),
    layer,
  };
}

/**
 * Parses explicit arrow notation such as:
 * "User -> API Gateway -> [Auth, Billing] -> Postgres"
 * "Client --HTTPS--> Edge -> Cache Hit? -> Yes: Fast Return, No: DB"
 */
function parseArrowSyntax(input: string): ParsedGraph | null {
  if (!/(->|=>|→|<->|↔|--.+-->)/.test(input)) return null;

  const nodeMap = new Map<string, ParsedNode>();
  const edges: ParsedEdge[] = [];
  const lines = input
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);

  let titlePrefix = "";

  for (const rawLine of lines) {
    let line = rawLine;
    // Strip optional "Title: A -> B"
    const colonIdx = line.indexOf(":");
    const arrowIdx = line.search(/(->|=>|→|<->|↔|--)/);
    if (colonIdx > 0 && colonIdx < arrowIdx) {
      titlePrefix = line.slice(0, colonIdx).trim();
      line = line.slice(colonIdx + 1).trim();
    }

    // Split by arrow operators while preserving operators and inline labels
    const tokens = line.split(/\s*(<->|↔|--[^-]+-->|->|=>|→)\s*/);
    let prevKeys: string[] = [];
    let layer = 0;
    let pendingEdgeLabel: string | undefined;
    let pendingBidi = false;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].trim();
      if (!tok) continue;

      if (tok === "<->" || tok === "↔") {
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

      // Check for parenthesized edge label at start: "(HTTPS) API Gateway"
      let segment = tok;
      const parenMatch = segment.match(/^\(([^)]+)\)\s+(.+)$/);
      if (parenMatch) {
        pendingEdgeLabel = parenMatch[1].trim();
        segment = parenMatch[2].trim();
      }

      // Support bracketed or comma-separated parallel branches: "[Auth, Billing]" or "Yes: Home, No: Login"
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

        // "Yes: Dashboard" or "No: Retry"
        const branchLabelMatch = branch.match(/^([A-Za-z0-9\s]{1,16}):\s*(.+)$/);
        if (branchLabelMatch) {
          edgeLbl = branchLabelMatch[1].trim();
          nodeText = branchLabelMatch[2].trim();
        }

        const label = cleanLabel(nodeText);
        if (!label) continue;
        const key = nodeKey(label);
        if (!nodeMap.has(key)) {
          nodeMap.set(key, createParsedNode(label, layer));
        } else {
          const existing = nodeMap.get(key)!;
          existing.layer = Math.max(existing.layer, layer);
        }
        currentKeys.push(key);

        for (const pk of prevKeys) {
          if (pk === key) continue;
          const dup = edges.some((e) => e.fromKey === pk && e.toKey === key);
          if (!dup) {
            edges.push({
              fromKey: pk,
              toKey: key,
              label: edgeLbl,
              dashed: edgeLbl
                ? /^(no|fail|error|miss|fallback|async|retry)$/i.test(edgeLbl)
                : false,
              bidirectional: pendingBidi,
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

  const frames =
    titlePrefix && nodes.length >= 2
      ? [{ label: cleanLabel(titlePrefix), nodeKeys: nodes.map((n) => n.key) }]
      : undefined;

  return {
    nodes,
    edges,
    frames,
    summary: titlePrefix || `${nodes[0].label} → ${nodes[nodes.length - 1].label}`,
  };
}

/**
 * Parses natural-language architecture & workflow prompts into rich, opinionated graphs.
 */
function parseNaturalLanguage(input: string): ParsedGraph {
  const lower = input.toLowerCase().trim();

  // Comparison pattern: "X vs Y"
  const vsMatch = input.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i);
  if (vsMatch) {
    const leftTitle = cleanLabel(vsMatch[1]);
    const rightTitle = cleanLabel(vsMatch[2]);
    const n1 = createParsedNode(leftTitle, 0, "Option A", "node");
    const n2 = createParsedNode("Strengths", 1, `Why ${leftTitle}`, "node");
    const n3 = createParsedNode("Trade-offs", 1, "Constraints", "node");
    const n4 = createParsedNode(rightTitle, 0, "Option B", "node");
    const n5 = createParsedNode("Strengths ", 1, `Why ${rightTitle}`, "node");
    const n6 = createParsedNode("Trade-offs ", 1, "Constraints", "node");
    n2.key = "left_pros";
    n3.key = "left_cons";
    n5.key = "right_pros";
    n6.key = "right_cons";
    n1.tone = "cobalt";
    n4.tone = "terracotta";
    return {
      nodes: [n1, n2, n3, n4, n5, n6],
      edges: [
        { fromKey: n1.key, toKey: n2.key, label: "pros" },
        { fromKey: n1.key, toKey: n3.key, label: "cons", dashed: true },
        { fromKey: n4.key, toKey: n5.key, label: "pros" },
        { fromKey: n4.key, toKey: n6.key, label: "cons", dashed: true },
      ],
      frames: [
        { label: leftTitle, nodeKeys: [n1.key, n2.key, n3.key] },
        { label: rightTitle, nodeKeys: [n4.key, n5.key, n6.key] },
      ],
      summary: `${leftTitle} vs ${rightTitle}`,
    };
  }

  // Known rich architectural blueprints when user describes a domain
  if (/(webrtc|p2p|peer[- ]to[- ]peer|whiteboard|collab)/.test(lower) && lower.split(/\s+/).length >= 2) {
    const peerA = createParsedNode("Peer A Browser", 0, "Jev Canvas", "ellipse");
    const peerB = createParsedNode("Peer B Browser", 0, "Jev Canvas", "ellipse");
    const signal = createParsedNode("Signaling Server", 1, "SDP Offer / Answer", "node");
    const stun = createParsedNode("STUN / ICE", 1, "NAT Traversal", "node");
    const channel = createParsedNode("RTCDataChannel", 2, "Direct P2P Mesh", "node");
    const crdt = createParsedNode("CRDT Sync State", 3, "Conflict-free ops", "database");
    return {
      nodes: [peerA, peerB, signal, stun, channel, crdt],
      edges: [
        { fromKey: peerA.key, toKey: signal.key, label: "offer", dashed: true },
        { fromKey: peerB.key, toKey: signal.key, label: "answer", dashed: true },
        { fromKey: signal.key, toKey: stun.key, label: "ICE" },
        { fromKey: peerA.key, toKey: channel.key, label: "direct", bidirectional: true },
        { fromKey: peerB.key, toKey: channel.key, label: "direct", bidirectional: true },
        { fromKey: channel.key, toKey: crdt.key, label: "deltas" },
      ],
      frames: [
        { label: "Zero-Cost Handshake", nodeKeys: [signal.key, stun.key] },
      ],
      summary: "WebRTC P2P Architecture",
    };
  }

  if (/(auth|oauth|login|sso|signup)/.test(lower) && !/(microservice|rag|ai)/.test(lower)) {
    const user = createParsedNode("User", 0, "Browser / App", "ellipse");
    const login = createParsedNode("Login / OAuth", 1, "Identity Provider", "node");
    const check = createParsedNode("Valid Creds?", 2, "Verify + MFA", "diamond");
    const jwt = createParsedNode("JWT + Session", 3, "Signed Cookie", "node");
    const err = createParsedNode("Retry / Error", 3, "401 Unauthorized", "node");
    const db = createParsedNode("User Store", 4, "Postgres + Redis", "database");
    err.tone = "terracotta";
    return {
      nodes: [user, login, check, jwt, err, db],
      edges: [
        { fromKey: user.key, toKey: login.key, label: "credentials" },
        { fromKey: login.key, toKey: check.key, label: "verify" },
        { fromKey: check.key, toKey: jwt.key, label: "Yes" },
        { fromKey: check.key, toKey: err.key, label: "No", dashed: true },
        { fromKey: jwt.key, toKey: db.key, label: "persist" },
      ],
      summary: "Authentication Flow",
    };
  }

  if (/(rag|llm|ai agent|agentic|chatbot|embedding)/.test(lower)) {
    const user = createParsedNode("User Prompt", 0, "Natural Language", "ellipse");
    const router = createParsedNode("Intent Router", 1, "Classify & Plan", "diamond");
    const embed = createParsedNode("Vector DB", 2, "Semantic Retrieval", "database");
    const tools = createParsedNode("Tool Executor", 2, "APIs & Actions", "node");
    const llm = createParsedNode("Reasoning Model", 3, "Context + Tools", "node");
    const stream = createParsedNode("Streaming UI", 4, "Live Tokens", "node");
    return {
      nodes: [user, router, embed, tools, llm, stream],
      edges: [
        { fromKey: user.key, toKey: router.key, label: "query" },
        { fromKey: router.key, toKey: embed.key, label: "retrieve" },
        { fromKey: router.key, toKey: tools.key, label: "invoke" },
        { fromKey: embed.key, toKey: llm.key, label: "chunks" },
        { fromKey: tools.key, toKey: llm.key, label: "results" },
        { fromKey: llm.key, toKey: stream.key, label: "SSE" },
      ],
      frames: [{ label: "Agent Runtime", nodeKeys: [router.key, embed.key, tools.key, llm.key] }],
      summary: "AI Agent / RAG Pipeline",
    };
  }

  if (/(microservice|e-?commerce|saas|backend|system architecture|distributed)/.test(lower)) {
    const client = createParsedNode("Web & Mobile", 0, "Clients", "ellipse");
    const gw = createParsedNode("API Gateway", 1, "Auth + Rate Limit", "node");
    const auth = createParsedNode("Auth Service", 2, "Sessions / RBAC", "node");
    const core = createParsedNode("Core Service", 2, "Domain API", "node");
    const billing = createParsedNode("Billing Service", 2, "Stripe Webhooks", "node");
    const cache = createParsedNode("Redis Cache", 3, "Hot State", "database");
    const queue = createParsedNode("Event Bus", 3, "Kafka / Async", "node");
    const db = createParsedNode("Postgres DB", 3, "Primary Store", "database");
    return {
      nodes: [client, gw, auth, core, billing, cache, queue, db],
      edges: [
        { fromKey: client.key, toKey: gw.key, label: "HTTPS" },
        { fromKey: gw.key, toKey: auth.key },
        { fromKey: gw.key, toKey: core.key },
        { fromKey: gw.key, toKey: billing.key },
        { fromKey: auth.key, toKey: cache.key, label: "TTL" },
        { fromKey: core.key, toKey: db.key, label: "SQL" },
        { fromKey: billing.key, toKey: queue.key, label: "events", dashed: true },
      ],
      frames: [{ label: "Service Mesh", nodeKeys: [auth.key, core.key, billing.key] }],
      summary: "Microservices Architecture",
    };
  }

  if (/(ci\s*\/?\s*cd|deploy|release pipeline|devops)/.test(lower)) {
    const git = createParsedNode("Git Push", 0, "PR / Branch", "ellipse");
    const build = createParsedNode("Build & Lint", 1, "Typecheck", "node");
    const test = createParsedNode("Tests Pass?", 2, "Unit + E2E", "diamond");
    const stage = createParsedNode("Preview Deploy", 3, "Staging URL", "node");
    const prod = createParsedNode("Production", 4, "Canary Rollout", "node");
    return {
      nodes: [git, build, test, stage, prod],
      edges: [
        { fromKey: git.key, toKey: build.key, label: "trigger" },
        { fromKey: build.key, toKey: test.key, label: "artifacts" },
        { fromKey: test.key, toKey: stage.key, label: "Yes" },
        { fromKey: stage.key, toKey: prod.key, label: "promote" },
      ],
      summary: "CI/CD Release Pipeline",
    };
  }

  if (/(funnel|onboarding|checkout|journey)/.test(lower)) {
    const s1 = createParsedNode("Landing Page", 0, "100% visitors", "ellipse");
    const s2 = createParsedNode("Sign Up", 1, "Email / OAuth", "node");
    const s3 = createParsedNode("Activated?", 2, "First Aha Moment", "diamond");
    const s4 = createParsedNode("Active Workspace", 3, "Retained User", "node");
    const s5 = createParsedNode("Nudge Email", 3, "Re-engage", "node");
    return {
      nodes: [s1, s2, s3, s4, s5],
      edges: [
        { fromKey: s1.key, toKey: s2.key, label: "start" },
        { fromKey: s2.key, toKey: s3.key, label: "verify" },
        { fromKey: s3.key, toKey: s4.key, label: "Yes" },
        { fromKey: s3.key, toKey: s5.key, label: "Drop-off", dashed: true },
      ],
      summary: "User Onboarding Funnel",
    };
  }

  // Generic natural language extractor: split by connectors / commas / "with" / "then"
  const withMatch = input.match(/^(.+?)\s+(?:with|using|via|including)\s+(.+)$/i);
  if (withMatch) {
    const hub = createParsedNode(withMatch[1], 0);
    const items = withMatch[2]
      .split(/,\s*|\s+and\s+|\s*\+\s*/i)
      .map((s) => cleanLabel(s))
      .filter((s) => s.length > 0 && s.length < 48);

    if (items.length >= 2) {
      const nodes: ParsedNode[] = [hub];
      const edges: ParsedEdge[] = [];
      items.forEach((item, idx) => {
        const isDb = inferKindFromLabel(item) === "database";
        const layer = isDb ? 2 : 1;
        const n = createParsedNode(item, layer);
        n.key = `${n.key}_${idx}`;
        nodes.push(n);
        if (layer === 1) {
          edges.push({ fromKey: hub.key, toKey: n.key });
        }
      });
      // Connect layer 1 nodes to layer 2 (databases)
      const layer1 = nodes.filter((n) => n.layer === 1);
      const layer2 = nodes.filter((n) => n.layer === 2);
      if (layer1.length > 0 && layer2.length > 0) {
        for (const l2 of layer2) {
          edges.push({ fromKey: layer1[layer1.length - 1].key, toKey: l2.key });
        }
      } else if (layer1.length === 0) {
        for (const l2 of layer2) {
          edges.push({ fromKey: hub.key, toKey: l2.key });
        }
      }
      return {
        nodes,
        edges,
        summary: hub.label,
      };
    }
  }

  // Sequential split ("then", "to", "into", commas, "and")
  const parts = input
    .split(/\s*(?:,\s*then\s+|,\s*|\s+then\s+|\s+into\s+|\s+feeds\s+|\s+calls\s+|\s+connects to\s+|\s+to\s+)\s*/i)
    .map((s) => cleanLabel(s))
    .filter((s) => s.length > 0 && s.length < 56);

  if (parts.length >= 2) {
    const nodes = parts.map((p, idx) => {
      const n = createParsedNode(p, idx);
      n.key = `${n.key}_${idx}`;
      return n;
    });
    const edges: ParsedEdge[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ fromKey: nodes[i].key, toKey: nodes[i + 1].key });
    }
    return {
      nodes,
      edges,
      summary: `${nodes[0].label} → ${nodes[nodes.length - 1].label}`,
    };
  }

  // Single concept -> create clean node so Tab + Enter can immediately expand it!
  const single = createParsedNode(input, 0);
  return {
    nodes: [single],
    edges: [],
    summary: single.label,
  };
}

/**
 * Turns any prompt string into fully laid-out, collision-free JevElements
 * positioned neatly relative to existing elements on the canvas.
 */
export function parsePromptToElements(
  prompt: string,
  existingElements: JevElement[],
  anchorCenter?: { x: number; y: number }
): { elements: JevElement[]; summary: string; focusId?: string } {
  const trimmed = prompt.trim();
  if (!trimmed) return { elements: [], summary: "" };

  const graph = parseArrowSyntax(trimmed) ?? parseNaturalLanguage(trimmed);

  // Group nodes by layer
  const layers = new Map<number, ParsedNode[]>();
  for (const n of graph.nodes) {
    const arr = layers.get(n.layer) ?? [];
    arr.push(n);
    layers.set(n.layer, arr);
  }
  const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);

  // Compute starting origin below existing diagram (or centered if empty)
  const existingBounds = computeBounds(existingElements);
  const startX = anchorCenter
    ? anchorCenter.x - (sortedLayers.length * 240) / 2
    : existingBounds
      ? existingBounds.x
      : 120;
  const startY = anchorCenter
    ? anchorCenter.y - 60
    : existingBounds
      ? existingBounds.y + existingBounds.height + 130
      : 180;

  const colGap = 250;
  const rowGap = 122;
  const keyToElement = new Map<string, JevElement>();
  const createdNodes: JevElement[] = [];
  const now = Date.now();

  sortedLayers.forEach((layerNum, colIdx) => {
    const colNodes = layers.get(layerNum) ?? [];
    const totalColHeight = (colNodes.length - 1) * rowGap;
    colNodes.forEach((pn, rowIdx) => {
      const id = uid("el");
      const width =
        pn.kind === "diamond"
          ? 148
          : pn.kind === "database"
            ? 156
            : pn.kind === "ellipse"
              ? 154
              : Math.min(220, Math.max(158, pn.label.length * 9 + 46));
      const height =
        pn.kind === "diamond" ? 96 : pn.kind === "database" ? 86 : 72;

      const x = Math.round(startX + colIdx * colGap);
      const y = Math.round(startY + rowIdx * rowGap - totalColHeight / 2);

      const el: JevElement = {
        id,
        kind: pn.kind,
        x,
        y,
        width,
        height,
        label: pn.label,
        sublabel: pn.sublabel,
        tone: pn.tone,
        seed: makeSeed(id),
        positionHistory: [],
        createdAt: now,
        updatedAt: now,
      };
      keyToElement.set(pn.key, el);
      createdNodes.push(el);
    });
  });

  // Create frames first so they render behind nodes
  const createdFrames: JevElement[] = [];
  if (graph.frames) {
    for (const f of graph.frames) {
      const members = f.nodeKeys
        .map((k) => keyToElement.get(k))
        .filter((e): e is JevElement => Boolean(e));
      const b = computeBounds(members);
      if (b) {
        const id = uid("frm");
        createdFrames.push({
          id,
          kind: "frame",
          x: Math.round(b.x - 32),
          y: Math.round(b.y - 44),
          width: Math.round(b.width + 64),
          height: Math.round(b.height + 72),
          label: f.label,
          tone: "slate",
          seed: makeSeed(id),
          positionHistory: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  // Create arrows
  const createdArrows: JevElement[] = [];
  for (const edge of graph.edges) {
    const fromEl = keyToElement.get(edge.fromKey);
    const toEl = keyToElement.get(edge.toKey);
    if (!fromEl || !toEl) continue;
    const id = uid("arr");
    createdArrows.push({
      id,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      label: edge.label ?? "",
      tone: edge.dashed ? "terracotta" : "ink",
      seed: makeSeed(id),
      positionHistory: [],
      fromId: fromEl.id,
      toId: toEl.id,
      arrowStyle: "curved",
      dashed: edge.dashed,
      bidirectional: edge.bidirectional,
      createdAt: now,
      updatedAt: now,
    });
  }

  const all = [...createdFrames, ...createdNodes, ...createdArrows];
  const focusId = createdNodes[createdNodes.length - 1]?.id;
  return { elements: all, summary: graph.summary, focusId };
}
