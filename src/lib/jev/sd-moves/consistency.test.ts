import { describe, expect, it } from "vitest";
import { board } from "./__fixtures__/boards";
import { checkConsistency } from "./consistency";

const ORDER_CLASS = { sublabel: "- id: UUID\n- status: OrderStatus\n- total: Money\n- user: User\n--\n+ pay(): void" };
const ORDERS_TABLE = { sublabel: "id uuid PK\nuser_id uuid FK\ntotal numeric\ncreated_at timestamptz" };
const POST_ORDERS = { sublabel: "req: {item_id, couponCode}\nres: 201 {order_id, total}\nidem: Idempotency-Key header" };

describe("Class ↔ API ↔ table consistency", () => {
  it("reports a class attribute with no column and an API field that is never stored", () => {
    const b = board()
      .shape("class", "Order", { id: "cls", ...ORDER_CLASS })
      .shape("entity", "orders", { id: "tbl", ...ORDERS_TABLE })
      .shape("api", "POST /orders", { id: "api", ...POST_ORDERS });
    const r = checkConsistency(b.els);
    expect(r.status).toBe("found");
    expect(r.mismatches.map((m) => m.text)).toEqual([
      "Order.status has no column in orders",
      "POST /orders takes item_id, not stored in orders",
      "POST /orders takes coupon_code, not stored in orders",
    ]);
    expect(r.mismatches[0].elementIds).toEqual(["cls", "tbl"]);
    expect(r.mismatches[2].elementIds).toEqual(["api", "tbl"]);
    expect(r.compared).toEqual(["order"]);
  });

  it("a column the class does not have is reported; keys and timestamps are not", () => {
    const b = board()
      .shape("class", "Order", { sublabel: "- id: UUID\n- user: User" })
      .shape("entity", "orders", { sublabel: "id uuid PK\nuser_id uuid FK\nnote text\ncreated_at timestamptz" });
    expect(checkConsistency(b.els).mismatches.map((m) => m.text)).toEqual(["orders.note is not on class Order"]);
  });

  it("a response field with neither a column nor an attribute", () => {
    const b = board()
      .shape("class", "Order", { sublabel: "- total: Money" })
      .shape("api", "GET /orders/{id}", { sublabel: "res: 200 {order_id, total, eta}" });
    expect(checkConsistency(b.els).mismatches.map((m) => m.text)).toEqual([
      "GET /orders/{id} returns eta: no attribute on Order",
    ]);
  });

  it("agreeing class, API and table: says they agree", () => {
    const b = board()
      .shape("class", "OrderItem", { sublabel: "- id: UUID\n- qty: int\n- order: Order" })
      .shape("entity", "order_items", { sublabel: "id uuid PK\norder_id uuid FK\nqty int" })
      .shape("api", "POST /order-items", { sublabel: "req: {order_id, qty}\nres: 201 {order_item_id}" });
    const r = checkConsistency(b.els);
    expect(r.status).toBe("clean");
    expect(r.mismatches).toEqual([]);
    expect(r.compared).toEqual(["order_item"]);
  });

  it("nothing to compare when no name appears in two notations", () => {
    const b = board().shape("class", "Order", ORDER_CLASS).shape("entity", "users", ORDERS_TABLE);
    expect(checkConsistency(b.els)).toEqual({ status: "nothing", mismatches: [], compared: [] });
    expect(checkConsistency([]).status).toBe("nothing");
  });
});
