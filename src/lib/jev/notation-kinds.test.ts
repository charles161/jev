import { describe, expect, it } from "vitest";
import {
  cardinalityToEnds,
  DEFAULT_KIND_SIZE,
  formatTransitionLabel,
  inferShapeKindFromLabel,
  isLldElement,
  KIND_LABELS,
  parseClassCompartments,
  parseEntityRows,
  parseTransitionLabel,
  resolveArrowEnds,
  resolveRenderStyle,
} from "./notation-kinds";
import { SHAPE_KINDS, type JevElement } from "./types";

function el(partial: Partial<JevElement>): JevElement {
  return {
    id: "a",
    kind: "node",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    label: "",
    tone: "ink",
    seed: 1,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("inferShapeKindFromLabel", () => {
  it.each([
    ["Kafka", "queue"],
    ["SQS jobs", "queue"],
    ["Order events topic", "queue"],
    ["Redis", "cache"],
    ["Session Cache", "cache"],
    ["S3", "blob"],
    ["Media bucket", "blob"],
    ["nginx", "lb"],
    ["ALB", "lb"],
    ["CloudFront CDN", "lb"],
    ["Stripe", "external"],
    ["APNs / FCM", "external"],
    ["User", "actor"],
    ["Mobile app", "actor"],
    ["Postgres", "database"],
    ["users table", "database"],
    ["Payment Gateway", "external"],
    ["payment-gateway", "external"],
    ["API Gateway", "lb"],
    ["Client App", "actor"],
    ["Web client", "actor"],
    ["Mobile clients", "actor"],
    ["Web & Mobile", "actor"],
  ])("%s → %s", (label, kind) => {
    expect(inferShapeKindFromLabel(label)).toBe(kind);
  });

  it("returns null for plain services so callers keep their default", () => {
    expect(inferShapeKindFromLabel("Order Service")).toBeNull();
    expect(inferShapeKindFromLabel("")).toBeNull();
  });
});

describe("cardinalityToEnds", () => {
  it("maps 1:N to exactly-one → zero-or-many crow's foot", () => {
    expect(cardinalityToEnds("1:N")).toEqual({ startEnd: "er_only_one", endEnd: "er_zero_many" });
    expect(cardinalityToEnds("one-to-many")).toEqual({ startEnd: "er_only_one", endEnd: "er_zero_many" });
  });
  it("maps N:1, 1:1, M:N, 1:0..1 and 1:1..*", () => {
    expect(cardinalityToEnds("N:1")).toEqual({ startEnd: "er_zero_many", endEnd: "er_only_one" });
    expect(cardinalityToEnds("1:1")).toEqual({ startEnd: "er_only_one", endEnd: "er_only_one" });
    expect(cardinalityToEnds("M:N")).toEqual({ startEnd: "er_zero_many", endEnd: "er_zero_many" });
    expect(cardinalityToEnds("1:0..1")).toEqual({ startEnd: "er_only_one", endEnd: "er_zero_one" });
    expect(cardinalityToEnds("1:1..*")).toEqual({ startEnd: "er_only_one", endEnd: "er_one_many" });
  });
  it("leaves ordinary labels alone", () => {
    expect(cardinalityToEnds("reads")).toBeNull();
    expect(cardinalityToEnds("ttl: 60s")).toBeNull();
    expect(cardinalityToEnds(undefined)).toBeNull();
  });
});

describe("entity rows and class compartments", () => {
  it("parses PK/FK markers wherever they sit", () => {
    expect(parseEntityRows("id uuid PK\nuser_id: uuid FK\nemail text UK\nPK,FK order_id bigint")).toEqual([
      { name: "id", type: "uuid", keys: ["PK"] },
      { name: "user_id", type: "uuid", keys: ["FK"] },
      { name: "email", type: "text", keys: ["UK"] },
      { name: "order_id", type: "bigint", keys: ["PK", "FK"] },
    ]);
  });
  it("splits class attributes and operations on a -- line, or by parentheses", () => {
    expect(parseClassCompartments("- id: UUID\n- spots: int\n--\n+ park(car): Ticket")).toEqual({
      attributes: ["- id: UUID", "- spots: int"],
      operations: ["+ park(car): Ticket"],
    });
    expect(parseClassCompartments("capacity: int\nget(key)")).toEqual({
      attributes: ["capacity: int"],
      operations: ["get(key)"],
    });
  });
});

describe("transition labels", () => {
  it("formats and parses event [guard] / action", () => {
    const label = formatTransitionLabel("pay", "amount > 0", "charge card");
    expect(label).toBe("pay [amount > 0] / charge card");
    expect(parseTransitionLabel(label)).toEqual({ event: "pay", guard: "amount > 0", action: "charge card" });
    expect(parseTransitionLabel("timeout")).toEqual({ event: "timeout" });
    expect(parseTransitionLabel("cancel / refund")).toEqual({ event: "cancel", action: "refund" });
  });
});

describe("render style and ends", () => {
  it("LLD notation renders clean on a sketch board; HLD follows the board", () => {
    expect(resolveRenderStyle(el({ kind: "entity" }), "sketch")).toBe("clean");
    expect(resolveRenderStyle(el({ kind: "arrow", endEnd: "er_zero_many" }), "sketch")).toBe("clean");
    expect(resolveRenderStyle(el({ kind: "node", morphMeta: { groupId: "g", notation: "sequence" } }), "sketch")).toBe("clean");
    expect(resolveRenderStyle(el({ kind: "queue" }), "sketch")).toBe("sketch");
    expect(isLldElement(el({ kind: "arrow" }))).toBe(false);
  });
  it("keeps legacy arrows unchanged", () => {
    expect(resolveArrowEnds(el({ kind: "arrow" }))).toEqual({ start: "none", end: "arrow" });
    expect(resolveArrowEnds(el({ kind: "arrow", bidirectional: true }))).toEqual({ start: "arrow", end: "arrow" });
    expect(resolveArrowEnds(el({ kind: "arrow", morphMeta: { groupId: "g", notation: "sequence", role: "lifeline" } }))).toEqual({ start: "none", end: "none" });
  });
  it("every shape kind has a size and a label", () => {
    for (const k of SHAPE_KINDS) {
      expect(DEFAULT_KIND_SIZE[k].width).toBeGreaterThan(0);
      expect(KIND_LABELS[k].length).toBeGreaterThan(0);
    }
  });
});
