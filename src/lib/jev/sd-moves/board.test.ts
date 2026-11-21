import { describe, expect, it } from "vitest";
import { board } from "./__fixtures__/boards";
import { buildHldGraph, componentRole, entityKey, fieldKey } from "./board";

describe("componentRole: what a shape is on an HLD board", () => {
  it.each([
    ["database", "Orders DB", "db"],
    ["database", "Read replica", "replica"],
    ["node", "Postgres", "db"],
    ["node", "Redis", "cache"],
    ["node", "Kafka", "queue"],
    ["node", "Stripe", "external"],
    ["node", "Users", "client"],
    ["node", "Order API", "service"],
    ["actor", "Shopper", "client"],
    ["lb", "ALB", "lb"],
  ] as const)("%s %s is a %s", (kind, label, role) => {
    const b = board().shape(kind, label);
    expect(componentRole(b.els[0])).toBe(role);
  });
});

describe("buildHldGraph", () => {
  it("keeps components and arrows between them, and drops notes, cards and morphed notation", () => {
    const b = board()
      .shape("actor", "User")
      .shape("node", "API")
      .shape("card", "Requirements")
      .shape("node", "Lifeline head", { morphMeta: { groupId: "g", notation: "sequence", role: "actor" } })
      .arrow("User", "API", "GET /feed");
    const g = buildHldGraph(b.els);
    expect([...g.nodes.keys()]).toEqual([b.id("User"), b.id("API")]);
    expect(g.edges.map((e) => [e.from, e.to, e.label])).toEqual([[b.id("User"), b.id("API"), "GET /feed"]]);
  });

  it("a bidirectional arrow is an edge both ways; a dashed or publish arrow is async", () => {
    const b = board()
      .shape("node", "A")
      .shape("node", "B")
      .shape("node", "C")
      .arrow("A", "B", "", { bidirectional: true })
      .arrow("A", "C", "publish order.created");
    const g = buildHldGraph(b.els);
    expect(g.out(b.id("B")).map((e) => e.to)).toEqual([b.id("A")]);
    expect(g.out(b.id("A")).map((e) => [e.to, e.async])).toEqual([
      [b.id("B"), false],
      [b.id("C"), true],
    ]);
  });
});

describe("names: class Order, table orders and /orders are one thing", () => {
  it.each([
    ["Order", "order"],
    ["orders", "order"],
    ["OrderItems", "order_item"],
    ["order_items", "order_item"],
    ["categories", "category"],
    ["addresses", "address"],
    ["status", "status"],
  ])("entityKey(%s) = %s", (raw, key) => {
    expect(entityKey(raw)).toBe(key);
  });

  it.each([
    ["couponCode", "coupon_code"],
    ["- total_cents: int", "total_cents"],
    ["+ status: OrderStatus", "status"],
    ["Coupon-Code", "coupon_code"],
  ])("fieldKey(%s) = %s", (raw, key) => {
    expect(fieldKey(raw)).toBe(key);
  });
});
