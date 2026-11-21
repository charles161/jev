import { describe, expect, it } from "vitest";
import { parseEntityRows } from "../notation-kinds";
import { board } from "./__fixtures__/boards";
import { apiSources, buildSchemaElements, proposeSchema } from "./api-schema";

const POST_ORDERS = {
  id: "api1",
  label: "POST /orders",
  sublabel: "req: {item_id, qty}\nres: 201 {order_id, status}\nerr: 409 duplicate order\nidem: Idempotency-Key header",
};

describe("API → schema", () => {
  it("POST /orders proposes orders with a PK, an FK to items, typed columns and a UK idempotency key", () => {
    const p = proposeSchema([POST_ORDERS], []);
    const orders = p.entities.find((e) => e.name === "orders")!;
    expect(orders.rows).toEqual([
      "id uuid PK",
      "item_id uuid FK",
      "qty int",
      "status text",
      "idempotency_key text UK",
      "created_at timestamptz",
    ]);
    expect(p.entities.find((e) => e.name === "items")!.rows).toEqual(["id uuid PK"]);
    expect(p.relations).toEqual([{ parent: "items", child: "orders", label: "item_id" }]);
  });

  it("a nested path makes the parent an entity and gives the child its FK", () => {
    const p = proposeSchema([{ id: "a", label: "GET /v1/users/{user_id}/orders", sublabel: "res: 200 {orders[], next_cursor}" }], []);
    expect(p.entities.map((e) => e.name)).toEqual(["users", "orders"]);
    expect(p.entities[1].rows).toContain("user_id uuid FK");
    expect(p.entities[1].rows.join(" ")).not.toMatch(/cursor|orders\b/);
    expect(p.relations).toEqual([{ parent: "users", child: "orders", label: "user_id" }]);
  });

  it("two APIs on one resource merge into one entity", () => {
    const p = proposeSchema(
      [POST_ORDERS, { id: "b", label: "PATCH /orders/{id}", sublabel: "req: {status, couponCode}" }],
      []
    );
    const orders = p.entities.filter((e) => e.name === "orders");
    expect(orders).toHaveLength(1);
    expect(orders[0].rows).toContain("coupon_code text");
    expect(orders[0].sourceIds).toEqual(["api1", "b"]);
  });

  it("an entity already on the board is not proposed again", () => {
    const p = proposeSchema([POST_ORDERS], ["orders"]);
    expect(p.entities.map((e) => e.name)).toEqual(["items"]);
    expect(p.existing).toEqual(["orders"]);
  });

  it("apiSources: the selected API cards, else labels like POST /orders, else every API card", () => {
    const b = board()
      .shape("api", "POST /orders", { id: "c1" })
      .shape("api", "GET /users/{id}", { id: "c2" })
      .shape("node", "DELETE /carts/{id}", { id: "n1" })
      .shape("node", "Checkout", { id: "n2" });
    expect(apiSources(b.els, ["c2"]).map((e) => e.id)).toEqual(["c2"]);
    expect(apiSources(b.els, ["n1", "n2"]).map((e) => e.id)).toEqual(["n1"]);
    expect(apiSources(b.els, []).map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(apiSources(board().shape("node", "Checkout").els, [])).toEqual([]);
  });

  it("builds entities to the right of the API card with crow's-foot relations", () => {
    const api = board().shape("api", POST_ORDERS.label, { id: "api1", sublabel: POST_ORDERS.sublabel, x: 100, y: 50, width: 280 });
    const els = buildSchemaElements(proposeSchema([POST_ORDERS], []), api.els, 1);
    const entities = els.filter((e) => e.kind === "entity");
    expect(entities.map((e) => e.label).sort()).toEqual(["items", "orders"]);
    for (const e of entities) {
      expect(e.x).toBeGreaterThanOrEqual(100 + 280 + 40);
      expect(parseEntityRows(e.sublabel)[0].keys).toContain("PK");
      expect(e.height).toBeGreaterThanOrEqual(30 + parseEntityRows(e.sublabel).length * 18);
    }
    const rel = els.find((e) => e.kind === "arrow")!;
    expect(rel).toMatchObject({ startEnd: "er_only_one", endEnd: "er_zero_many", label: "item_id" });
    expect(rel.fromId).toBe(entities.find((e) => e.label === "items")!.id);
  });

  it("says so when there is no API to read", () => {
    expect(proposeSchema([], [])).toEqual({ entities: [], relations: [], existing: [] });
  });
});
