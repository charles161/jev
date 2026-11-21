import { describe, expect, it } from "vitest";
import {
  SEMANTIC_NODE_KINDS,
  buildLocalSemanticGraphFromPrompt,
  inferSemanticKind,
  layoutSemanticGraphToElements,
  measureSemanticNode,
  serializeBoardToGraph,
  serializedBoardGraphSchema,
  validateLayoutElements,
  validateSemanticGraph,
  type SemanticGraph,
  type SemanticPatternHint,
} from "@/lib/jev/semantic-graph";
import { DEFAULT_KIND_SIZE, inferShapeKindFromLabel } from "@/lib/jev/notation-kinds";
import { parsePromptToElements } from "@/lib/jev/diagram-parser";
import type { JevElement } from "@/lib/jev/types";

describe("inferSemanticKind: text → shape kind", () => {
  const cases: Array<[string, string]> = [
    ["kafka", "queue"],
    ["Kafka Topic", "queue"],
    ["SQS", "queue"],
    ["RabbitMQ", "queue"],
    ["Dead Letter Queue", "queue"],
    ["Webhook Queue", "queue"],
    ["redis", "cache"],
    ["Memcached", "cache"],
    ["Redis Cache", "cache"],
    ["s3", "blob"],
    ["GCS bucket", "blob"],
    ["nginx", "lb"],
    ["ALB", "lb"],
    ["CloudFront", "lb"],
    ["API Gateway", "lb"],
    ["stripe", "external"],
    ["Payment Gateway", "external"],
    ["Twilio SMS", "external"],
    ["user", "actor"],
    ["Users", "actor"],
    ["client", "actor"],
    ["Client App", "actor"],
    ["Customer", "actor"],
    ["postgres", "database"],
    ["Ledger DB", "database"],
    ["Postgres Read Replica", "database"],
    ["State Store", "database"],
    ["Vector Store", "database"],
    ["Order Service", "node"],
    ["Checkout API", "node"],
    ["Invalidation Worker", "node"],
    ["Cache Hit?", "diamond"],
    ["Valid Creds?", "diamond"],
    ["Quality gate", "diamond"],
    ["Start", "ellipse"],
    ["end", "ellipse"],
    ["Peer A", "ellipse"],
  ];

  it.each(cases)("%s → %s", (label, kind) => {
    expect(inferSemanticKind(label)).toBe(kind);
  });

  it("only ever returns a kind the semantic schema accepts", () => {
    for (const [label] of cases) {
      expect(SEMANTIC_NODE_KINDS).toContain(inferSemanticKind(label));
    }
  });

  it("typing a component into the Thought Bar draws its HLD shape, not a box", () => {
    const shapeOf = (prompt: string) =>
      parsePromptToElements(prompt, []).elements.filter((e) => e.kind !== "arrow" && e.kind !== "frame");
    expect(shapeOf("kafka")[0].kind).toBe("queue");
    expect(shapeOf("redis")[0].kind).toBe("cache");
    expect(shapeOf("s3")[0].kind).toBe("blob");
    expect(shapeOf("nginx")[0].kind).toBe("lb");
    expect(shapeOf("stripe")[0].kind).toBe("external");
    expect(shapeOf("user")[0].kind).toBe("actor");
    expect(shapeOf("client -> nginx -> api -> kafka -> worker -> postgres").map((s) => s.kind)).toEqual([
      "actor",
      "lb",
      "node",
      "queue",
      "node",
      "database",
    ]);
  });
});

describe("local heuristic templates agree with kind inference", () => {
  const prompts: Array<[string, SemanticPatternHint | null]> = [
    ["event-driven order processing with kafka and dead letter queue", null],
    ["high-throughput read API with redis cache and postgres read replica", null],
    ["payment checkout with stripe webhook and ledger db", null],
    ["webrtc p2p whiteboard", null],
    ["login auth flow", "auth_flow"],
    ["saas microservices backend", "microservices"],
    ["rag agent", "ai_rag"],
    ["ci cd pipeline", "ci_cd"],
    ["onboarding funnel", "onboarding_funnel"],
    ["kafka vs rabbitmq", null],
    ["order service with valkey, mongo and gcs", null],
  ];

  it.each(prompts)("%s", (prompt, hint) => {
    const { graph } = buildLocalSemanticGraphFromPrompt(prompt, hint);
    for (const node of graph.nodes) {
      if (node.kind === "diamond") continue;
      const inferred = inferShapeKindFromLabel(node.label);
      if (inferred) expect({ label: node.label, kind: node.kind }).toEqual({ label: node.label, kind: inferred });
    }
    expect(validateSemanticGraph(graph).ok).toBe(true);
  });

  it("hub-and-spoke puts every data store (database, cache, blob) in the data tier", () => {
    const { graph } = buildLocalSemanticGraphFromPrompt("order service with valkey, mongo and gcs");
    const layerOf = (label: string) => graph.nodes.find((n) => n.label === label)?.layer;
    expect(layerOf("Valkey")).toBe(2);
    expect(layerOf("Mongo")).toBe(2);
    expect(layerOf("GCS")).toBe(2);
  });
});

describe("semantic graph schema + layout for HLD / LLD kinds", () => {
  it("accepts every HLD kind and the LLD boxes an AI can emit, and rejects unknown kinds", () => {
    expect([...SEMANTIC_NODE_KINDS].sort()).toEqual(
      ["actor", "api", "blob", "cache", "card", "class", "database", "diamond", "ellipse", "entity", "external", "lb", "node", "queue", "text"].sort()
    );
    const graph = {
      summary: "all kinds",
      nodes: SEMANTIC_NODE_KINDS.map((kind) => ({ id: `n_${kind}`, label: kind, kind })),
      edges: [],
    };
    expect(validateSemanticGraph(graph).ok).toBe(true);
    for (const bad of ["cylinder", "zone", "activation", "fragment", "initial", "final", "frame", "arrow"]) {
      const res = validateSemanticGraph({ summary: "x", nodes: [{ id: "a", label: "A", kind: bad }], edges: [] });
      expect(res.ok, bad).toBe(false);
    }
  });

  it("keeps the measured size of the original kinds unchanged", () => {
    const m = (kind: SemanticGraph["nodes"][number]["kind"], label: string) => measureSemanticNode({ id: "a", label, kind });
    expect(m("node", "Order Service")).toEqual({ width: 162, height: 72 });
    expect(m("node", "A Much Longer Service Name Here")).toEqual({ width: 224, height: 72 });
    expect(m("diamond", "Valid?")).toEqual({ width: 148, height: 96 });
    expect(m("database", "Postgres")).toEqual({ width: 156, height: 86 });
    expect(m("ellipse", "Client")).toEqual({ width: 152, height: 74 });
    expect(m("text", "Note")).toEqual({ width: 120, height: 42 });
  });

  it("sizes new kinds from DEFAULT_KIND_SIZE, growing with the label but bounded", () => {
    for (const kind of ["queue", "cache", "lb", "blob", "external"] as const) {
      const short = measureSemanticNode({ id: "a", label: "X", kind });
      expect(short).toEqual(DEFAULT_KIND_SIZE[kind]);
      const long = measureSemanticNode({ id: "a", label: "A very long component label that keeps going", kind });
      expect(long.height).toBe(DEFAULT_KIND_SIZE[kind].height);
      expect(long.width).toBeGreaterThan(DEFAULT_KIND_SIZE[kind].width);
      expect(long.width).toBeLessThanOrEqual(DEFAULT_KIND_SIZE[kind].width + 80);
    }
    expect(measureSemanticNode({ id: "a", label: "Customer", kind: "actor" })).toEqual(DEFAULT_KIND_SIZE.actor);
  });

  it("grows entity and class boxes with their rows", () => {
    const small = measureSemanticNode({ id: "e", label: "users", kind: "entity" });
    expect(small).toEqual(DEFAULT_KIND_SIZE.entity);
    const rows = Array.from({ length: 10 }, (_, i) => `column_${i} text`).join("\n");
    const tall = measureSemanticNode({ id: "e", label: "users", sublabel: rows, kind: "entity" });
    expect(tall.height).toBeGreaterThan(DEFAULT_KIND_SIZE.entity.height);
    const cls = measureSemanticNode({
      id: "c",
      label: "ParkingLot",
      sublabel: "- spots: Spot[]\n- levels: int\n- name: string\n- open: bool\n--\n+ park(v: Vehicle): Ticket\n+ leave(t: Ticket): void\n+ freeSpots(): int",
      kind: "class",
    });
    expect(cls.height).toBeGreaterThan(DEFAULT_KIND_SIZE.class.height);
    expect(cls.width).toBeGreaterThanOrEqual(DEFAULT_KIND_SIZE.class.width);
    expect(cls.width).toBeLessThanOrEqual(320);
  });

  it("grows API cards and note cards with their rows", () => {
    for (const kind of ["api", "card"] as const) {
      expect(measureSemanticNode({ id: "a", label: "X", kind })).toEqual(DEFAULT_KIND_SIZE[kind]);
      const rows = Array.from({ length: 8 }, (_, i) => `err: 4${i}0 something went wrong`).join("\n");
      expect(measureSemanticNode({ id: "a", label: "POST /orders", sublabel: rows, kind }).height).toBeGreaterThan(
        DEFAULT_KIND_SIZE[kind].height
      );
    }
  });

  it("lays out a mixed HLD graph with kinds preserved and zero overlap", () => {
    const graph: SemanticGraph = {
      notation: "architecture",
      summary: "Order pipeline",
      nodes: [
        { id: "u", label: "User", kind: "actor" },
        { id: "cdn", label: "CloudFront", kind: "lb" },
        { id: "api", label: "Order API", kind: "node" },
        { id: "q", label: "Kafka", kind: "queue" },
        { id: "c", label: "Redis", kind: "cache" },
        { id: "b", label: "S3", kind: "blob" },
        { id: "s", label: "Stripe", kind: "external" },
        { id: "db", label: "orders", sublabel: "id uuid PK\nuser_id uuid FK", kind: "entity" },
      ],
      edges: [
        { from: "u", to: "cdn" },
        { from: "cdn", to: "api" },
        { from: "api", to: "q", kind: "async" },
        { from: "api", to: "c" },
        { from: "api", to: "b" },
        { from: "api", to: "s" },
        { from: "api", to: "db" },
      ],
    };
    const { elements } = layoutSemanticGraphToElements(graph, { now: 1 });
    const byLabel = new Map(elements.filter((e) => e.kind !== "arrow").map((e) => [e.label, e]));
    expect(byLabel.get("User")?.kind).toBe("actor");
    expect(byLabel.get("Kafka")?.kind).toBe("queue");
    expect(byLabel.get("orders")?.kind).toBe("entity");
    expect(byLabel.get("orders")?.sublabel).toBe("id uuid PK\nuser_id uuid FK");
    expect(validateLayoutElements(elements).ok).toBe(true);
  });

  it("carries explicit arrow end markers from the AI graph onto arrows, and rejects unknown ends", () => {
    const graph = {
      notation: "er",
      summary: "users have orders",
      nodes: [
        { id: "u", label: "users", kind: "entity" },
        { id: "o", label: "orders", kind: "entity" },
      ],
      edges: [{ from: "u", to: "o", label: "places", startEnd: "er_only_one", endEnd: "er_zero_many" }],
    };
    const v = validateSemanticGraph(graph);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const arrow = layoutSemanticGraphToElements(v.graph, { now: 1 }).elements.find((e) => e.kind === "arrow");
    expect(arrow?.startEnd).toBe("er_only_one");
    expect(arrow?.endEnd).toBe("er_zero_many");

    const bad = validateSemanticGraph({ ...graph, edges: [{ from: "u", to: "o", endEnd: "crowsfoot" }] });
    expect(bad.ok).toBe(false);
  });

  it("allows class/entity compartments longer than a one-line sublabel", () => {
    const rows = Array.from({ length: 14 }, (_, i) => `column_number_${i} varchar`).join("\n");
    expect(rows.length).toBeGreaterThan(160);
    const v = validateSemanticGraph({ summary: "x", nodes: [{ id: "e", label: "wide", kind: "entity", sublabel: rows }], edges: [] });
    expect(v.ok).toBe(true);
  });
});

describe("serializeBoardToGraph with new kinds", () => {
  const base = { tone: "ink" as const, seed: 1, createdAt: 1, updatedAt: 1, rev: 1 };
  const el = (o: Partial<JevElement> & Pick<JevElement, "id" | "kind">): JevElement => ({
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    label: o.id,
    ...base,
    ...o,
  });

  it("serializes HLD/LLD kinds as nodes, zones as groups, and arrow end markers on edges", () => {
    const elements: JevElement[] = [
      el({ id: "zone1", kind: "zone", x: -50, y: -50, width: 600, height: 300, label: "VPC" }),
      el({ id: "q", kind: "queue", x: 0, y: 0, label: "Kafka" }),
      el({ id: "c", kind: "cache", x: 200, y: 0, label: "Redis" }),
      el({ id: "u", kind: "entity", x: 0, y: 400, label: "users" }),
      el({ id: "o", kind: "entity", x: 300, y: 400, label: "orders" }),
      el({ id: "a1", kind: "arrow", width: 0, height: 0, fromId: "q", toId: "c", label: "" }),
      el({ id: "a2", kind: "arrow", width: 0, height: 0, fromId: "u", toId: "o", label: "", startEnd: "er_only_one", endEnd: "er_zero_many" }),
    ];
    const g = serializeBoardToGraph(elements);
    expect(g.nodes.map((n) => n.kind).sort()).toEqual(["cache", "entity", "entity", "queue"]);
    expect(g.groups).toEqual([{ id: "zone1", label: "VPC", nodeIds: ["q", "c"] }]);
    const er = g.edges.find((e) => e.id === "a2");
    expect(er).toMatchObject({ startEnd: "er_only_one", endEnd: "er_zero_many" });
    expect(g.edges.find((e) => e.id === "a1")).not.toHaveProperty("startEnd");
    expect(serializedBoardGraphSchema.safeParse(g).success).toBe(true);
  });

  it("keeps the canonical hash of a legacy board (no end markers) unchanged", () => {
    const legacy: JevElement[] = [
      el({ id: "n1", kind: "node", label: "API" }),
      el({ id: "n2", kind: "database", x: 300, label: "DB" }),
      el({ id: "a", kind: "arrow", width: 0, height: 0, fromId: "n1", toId: "n2", label: "reads" }),
    ];
    expect(serializeBoardToGraph(legacy).canonicalHash).toBe("49fd6367431ba3f2");
  });

  it("changes the canonical hash when only an end marker changes", () => {
    const mk = (endEnd?: JevElement["endEnd"]) =>
      serializeBoardToGraph([
        el({ id: "u", kind: "entity", label: "users" }),
        el({ id: "o", kind: "entity", x: 300, label: "orders" }),
        el({ id: "a", kind: "arrow", width: 0, height: 0, fromId: "u", toId: "o", label: "", ...(endEnd ? { endEnd } : {}) }),
      ]).canonicalHash;
    expect(mk("er_zero_many")).not.toBe(mk("er_one_many"));
    expect(mk("er_zero_many")).not.toBe(mk());
  });
});
