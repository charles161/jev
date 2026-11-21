import { describe, expect, it } from "vitest";
import { board, morphed } from "./__fixtures__/boards";
import { findFailureSteps } from "./failure-steps";

const checkout = (charge = "charge card", insert = "INSERT order", submit = "POST /checkout") =>
  morphed("sequence", ["Client", "Checkout", "Stripe", "Orders DB"], {
    actors: [
      { id: "sem_0", label: "Client", kind: "actor" },
      { id: "sem_1", label: "Checkout", kind: "node" },
      { id: "sem_2", label: "Stripe", kind: "external" },
      { id: "sem_3", label: "Orders DB", kind: "database" },
    ],
    messages: [
      { id: "m1", from: "sem_0", to: "sem_1", label: submit, order: 1 },
      { id: "m2", from: "sem_1", to: "sem_2", label: charge, order: 2 },
      { id: "m3", from: "sem_2", to: "sem_1", label: "charge_id", order: 3, isReturn: true },
      { id: "m4", from: "sem_1", to: "sem_3", label: insert, order: 4 },
      { id: "m5", from: "sem_3", to: "sem_1", label: "ok", order: 5, isReturn: true },
      { id: "m6", from: "sem_1", to: "sem_0", label: "201", order: 6, isReturn: true },
    ],
  });

const msgId = (els: ReturnType<typeof checkout>, semanticId: string) =>
  els.find((e) => e.morphMeta?.role === "message" && e.morphMeta.semanticId === semanticId)!.id;

describe("Find the failure step", () => {
  it("on a checkout sequence flags the submit, the charge and the write after the charge", () => {
    const els = checkout();
    const r = findFailureSteps(els, []);
    expect(r.status).toBe("found");
    expect(r.source).toBe("sequence");
    const byStep = new Map(r.flags.map((f) => [f.step, f]));
    expect([...byStep.keys()]).toEqual([1, 2, 4]);
    expect(byStep.get(1)!.kinds).toEqual(["idempotency"]);
    expect(byStep.get(2)!.kinds).toEqual(["timeout", "idempotency"]);
    expect(byStep.get(2)!.text).toMatch(/charge twice/);
    expect(byStep.get(4)!.kinds).toEqual(["outbox"]);
    expect(byStep.get(2)!.anchorId).toBe(msgId(els, "m2"));
  });

  it("returns are never flagged, and labels that already carry a key and a timeout pass", () => {
    const els = checkout("charge card (Idempotency-Key, 3s timeout)", "INSERT order (outbox)", "POST /checkout + Idempotency-Key");
    const r = findFailureSteps(els, []);
    expect(r.status).toBe("clean");
    expect(r.flags).toEqual([]);
  });

  it("on an HLD board flags a service calling another service and a payment provider without timeouts", () => {
    const b = board().shape("actor", "User").shape("node", "Orders").shape("node", "Inventory").shape("external", "Stripe");
    b.arrow("User", "Orders", "GET /orders").arrow("Orders", "Inventory", "reserve").arrow("Orders", "Stripe", "capture payment");
    const r = findFailureSteps(b.els, []);
    expect(r.source).toBe("hld");
    expect(r.flags.map((f) => [b.els.find((e) => e.id === f.anchorId)!.label, f.kinds])).toEqual([
      ["reserve", ["timeout"]],
      ["capture payment", ["timeout", "idempotency"]],
    ]);
  });

  it("an arrow into a decision diamond is flow logic, not a call; an unlabelled arrow is named by its ends", () => {
    const b = board().shape("node", "Checkout").shape("diamond", "Risk ok?").shape("external", "Stripe");
    b.arrow("Checkout", "Risk ok?").arrow("Risk ok?", "Stripe");
    const r = findFailureSteps(b.els, []);
    expect(r.flags.map((f) => [f.name, f.kinds])).toEqual([["Risk ok? → Stripe", ["timeout"]]]);
  });

  it("a service whose own note says it takes an idempotency key is not flagged for one", () => {
    const b = board().shape("actor", "Customer").shape("node", "Checkout API", { sublabel: "Idempotency key" });
    b.arrow("Customer", "Checkout API", "pay");
    expect(findFailureSteps(b.els, []).status).toBe("clean");
  });

  it("a publish to a queue asks the consumer to dedupe", () => {
    const b = board().shape("node", "Orders").shape("queue", "Kafka");
    b.arrow("Orders", "Kafka", "publish order.created");
    expect(findFailureSteps(b.els, []).flags[0].kinds).toEqual(["dedupe"]);
  });

  it("reads and an empty board report nothing", () => {
    const b = board().shape("actor", "User").shape("node", "Feed").shape("cache", "Redis");
    b.arrow("User", "Feed", "GET /feed").arrow("Feed", "Redis", "get timeline (50ms timeout)");
    expect(findFailureSteps(b.els, []).status).toBe("clean");
    expect(findFailureSteps([], []).status).toBe("empty");
  });
});
