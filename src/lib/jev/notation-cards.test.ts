import { describe, expect, it } from "vitest";
import {
  DEFAULT_KIND_SIZE,
  isHldKind,
  isLldKind,
  KIND_LABELS,
  parseApiCard,
  parseCardBullets,
  resolveRenderStyle,
} from "./notation-kinds";
import type { JevElement } from "./types";

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

describe("api card contract", () => {
  it("is LLD notation, so it renders clean even on a sketch board", () => {
    expect(isLldKind("api")).toBe(true);
    expect(resolveRenderStyle(el({ kind: "api" }), "sketch")).toBe("clean");
    expect(KIND_LABELS.api).toBe("API card");
    expect(DEFAULT_KIND_SIZE.api.width).toBeGreaterThanOrEqual(240);
  });

  it("splits the label into an HTTP method badge and a path", () => {
    expect(parseApiCard("POST /orders", "")).toMatchObject({ method: "POST", path: "/orders" });
    expect(parseApiCard("get /users/{id}", "")).toMatchObject({ method: "GET", path: "/users/{id}" });
    expect(parseApiCard("/health", "")).toMatchObject({ method: null, path: "/health" });
    expect(parseApiCard("  DELETE   /carts/1  ", "")).toMatchObject({ method: "DELETE", path: "/carts/1" });
  });

  it("reads req: / res: / err: / idem: lines as labelled rows, in the order written", () => {
    const card = parseApiCard(
      "POST /orders",
      "req: {item_id, qty}\nres: 201 {order_id}\nerr: 409 duplicate\nerr: 422 invalid qty\nidem: Idempotency-Key header"
    );
    expect(card.rows).toEqual([
      { key: "req", title: "Request", text: "{item_id, qty}" },
      { key: "res", title: "Response", text: "201 {order_id}" },
      { key: "err", title: "Errors", text: "409 duplicate" },
      { key: "err", title: "Errors", text: "422 invalid qty" },
      { key: "idem", title: "Idempotency key", text: "Idempotency-Key header" },
    ]);
  });

  it("accepts the long prefixes and keeps unprefixed lines as notes", () => {
    const card = parseApiCard("PUT /a", "request: body\nResponse: 200\nerrors: 404\nidempotency: key\nrate limited 10/s");
    expect(card.rows.map((r) => r.key)).toEqual(["req", "res", "err", "idem", "note"]);
    expect(card.rows[4]).toEqual({ key: "note", title: "", text: "rate limited 10/s" });
  });
});

describe("note card contract", () => {
  it("is an HLD building block that follows the board style", () => {
    expect(isHldKind("card")).toBe(true);
    expect(resolveRenderStyle(el({ kind: "card" }), "sketch")).toBe("sketch");
    expect(KIND_LABELS.card).toBe("Note card");
  });

  it("turns sublabel lines into bullets, stripping typed bullet markers", () => {
    expect(parseCardBullets("- 100M DAU\n• 10 writes/user/day\n* p99 < 100 ms\n\nread heavy")).toEqual([
      "100M DAU",
      "10 writes/user/day",
      "p99 < 100 ms",
      "read heavy",
    ]);
    expect(parseCardBullets(undefined)).toEqual([]);
  });
});
