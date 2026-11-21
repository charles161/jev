import { describe, expect, it } from "vitest";
import { getElementRect, rectsOverlap } from "../geometry";
import { cardLayout } from "../shape-layout";
import { board, morphed } from "./__fixtures__/boards";
import { findBreakAt10x } from "./break-at-10x";
import { breakCard, consistencyCard, failureNotes, RULE_SOURCE, sourceLine } from "./cards";
import { checkConsistency } from "./consistency";
import { findFailureSteps } from "./failure-steps";

const threeNode = () => {
  const b = board().shape("actor", "User").shape("node", "API").shape("database", "Orders DB");
  b.arrow("User", "API").arrow("API", "Orders DB");
  return b;
};

const fitsAllLines = (card: { label: string; sublabel?: string; width: number; height: number }) => {
  const l = cardLayout(card);
  return l.visibleLines === l.lines.length;
};

describe("move cards", () => {
  it("Breaks at 10×: a card beside the database, an arrow to it, fixes and an honest source line", () => {
    const b = threeNode();
    const [card, pointer] = breakCard(findBreakAt10x(b.els), b.els, 1);
    const db = b.els.find((e) => e.label === "Orders DB")!;
    expect(card.kind).toBe("card");
    expect(card.label).toBe("Breaks at 10×");
    const lines = card.sublabel!.split("\n");
    expect(lines[0]).toBe("Orders DB takes every read and write");
    expect(lines.filter((l) => l.startsWith("Fix: "))).toHaveLength(3);
    expect(lines[lines.length - 1]).toBe(sourceLine(RULE_SOURCE));
    expect(card.x).toBeGreaterThanOrEqual(db.x + db.width);
    expect(card.x - (db.x + db.width)).toBeLessThan(160);
    expect(card.y).toBeLessThan(db.y + db.height);
    expect(fitsAllLines(card)).toBe(true);
    expect(pointer).toMatchObject({ kind: "arrow", fromId: card.id, toId: db.id, dashed: true });
    for (const s of b.els.filter((e) => e.kind !== "arrow")) {
      expect(rectsOverlap(getElementRect(card), getElementRect(s))).toBe(false);
    }
  });

  it("failure notes sit right of the sequence, one per flagged step, without overlapping each other", () => {
    const els = morphed("sequence", ["Client", "Checkout", "Stripe"], {
      actors: [
        { id: "sem_0", label: "Client", kind: "actor" },
        { id: "sem_1", label: "Checkout", kind: "node" },
        { id: "sem_2", label: "Stripe", kind: "external" },
      ],
      messages: [
        { id: "m1", from: "sem_0", to: "sem_1", label: "POST /checkout", order: 1 },
        { id: "m2", from: "sem_1", to: "sem_2", label: "charge card", order: 2 },
      ],
    });
    const notes = failureNotes(findFailureSteps(els, []), els, 1);
    expect(notes.map((n) => n.label)).toEqual(["Step 1 · Idempotency key", "Step 2 · Timeout + idempotency key"]);
    const right = Math.max(...els.filter((e) => e.kind !== "arrow").map((e) => e.x + e.width));
    for (const n of notes) {
      expect(n.x).toBeGreaterThan(right);
      expect(fitsAllLines(n)).toBe(true);
    }
    expect(rectsOverlap(getElementRect(notes[0]), getElementRect(notes[1]))).toBe(false);
  });

  it("HLD failure notes go in a row under the diagram, named after their arrow", () => {
    const b = board().shape("actor", "User").shape("node", "Orders").shape("external", "Stripe");
    b.arrow("User", "Orders", "pay").arrow("Orders", "Stripe", "charge");
    const notes = failureNotes(findFailureSteps(b.els, []), b.els, 1);
    expect(notes.map((n) => n.label)).toEqual(["pay · Idempotency key", "charge · Timeout + idempotency key"]);
    const bottom = Math.max(...b.els.filter((e) => e.kind !== "arrow").map((e) => e.y + e.height));
    for (const n of notes) expect(n.y).toBeGreaterThan(bottom);
    expect(rectsOverlap(getElementRect(notes[0]), getElementRect(notes[1]))).toBe(false);
  });

  it("the consistency card numbers each mismatch", () => {
    const b = board()
      .shape("class", "Order", { sublabel: "- status: OrderStatus" })
      .shape("entity", "orders", { sublabel: "id uuid PK" });
    const card = consistencyCard(checkConsistency(b.els), b.els, 1)!;
    expect(card.label).toBe("Consistency check");
    expect(card.sublabel!.split("\n")[0]).toBe("1. Order.status has no column in orders");
    expect(fitsAllLines(card)).toBe(true);
  });
});
