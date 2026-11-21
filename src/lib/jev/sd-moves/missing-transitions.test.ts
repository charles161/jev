import { describe, expect, it } from "vitest";
import { buildStarter } from "../notation-packs";
import { board, morphed } from "./__fixtures__/boards";
import { buildTransitionGhosts, findMissingTransitions } from "./missing-transitions";

const orderLifecycle = (extra: Array<{ id: string; from: string; to: string; event: string }> = [], labels = ["Pending", "Paid", "Shipped"]) =>
  morphed("state", labels, {
    states: labels.map((label, i) => ({ id: `sem_${i}`, label, initial: i === 0, terminal: i === labels.length - 1 })),
    transitions: [
      { id: "t1", from: "sem_0", to: "sem_1", event: "pay" },
      { id: "t2", from: "sem_1", to: "sem_2", event: "ship" },
      ...extra,
    ],
  });

const labelOf = (els: { id: string; label: string }[], id: string | undefined) => els.find((e) => e.id === id)?.label;

describe("Missing state transitions", () => {
  it("an order lifecycle is missing cancel, timeout and refund", () => {
    const els = orderLifecycle();
    const r = findMissingTransitions(els, []);
    expect(r.status).toBe("found");
    expect(r.suggestions.map((s) => [s.event, labelOf(els, s.fromId), s.toLabel])).toEqual([
      ["cancel", "Pending", "Cancelled"],
      ["timeout", "Pending", "Expired"],
      ["refund", "Paid", "Refunded"],
    ]);
    expect(r.suggestions.every((s) => s.reason.length > 0)).toBe(true);
  });

  it("a failed state with no way out gets a retry back to where it came from", () => {
    const els = orderLifecycle(
      [
        { id: "t3", from: "sem_0", to: "sem_2", event: "decline" },
        { id: "t4", from: "sem_0", to: "sem_3", event: "cancel" },
        { id: "t5", from: "sem_0", to: "sem_3", event: "timeout" },
        { id: "t6", from: "sem_1", to: "sem_4", event: "refund" },
      ],
      ["Pending", "Paid", "Failed", "Cancelled", "Refunded"]
    );
    const r = findMissingTransitions(els, []);
    expect(r.suggestions.map((s) => [s.event, labelOf(els, s.fromId), labelOf(els, s.toId) ?? s.toLabel])).toEqual([
      ["retry", "Failed", "Pending"],
    ]);
  });

  it("reuses an existing target state instead of adding a duplicate", () => {
    const els = orderLifecycle([], ["Pending", "Paid", "Shipped", "Cancelled"]);
    const cancel = findMissingTransitions(els, []).suggestions.find((s) => s.event === "cancel")!;
    expect(labelOf(els, cancel.toId)).toBe("Cancelled");
  });

  it("a subscription that never expires", () => {
    const els = morphed("state", ["Trial", "Active"], {
      states: [
        { id: "sem_0", label: "Trial", initial: true },
        { id: "sem_1", label: "Active", terminal: true },
      ],
      transitions: [{ id: "t1", from: "sem_0", to: "sem_1", event: "subscribe" }],
    });
    const events = findMissingTransitions(els, []).suggestions.map((s) => `${s.event}:${labelOf(els, s.fromId)}`);
    expect(events).toContain("expire:Trial");
  });

  it("a complete lifecycle reports nothing missing, and a board with no state diagram says so", () => {
    const els = morphed("state", ["Draft", "Published"], {
      states: [
        { id: "sem_0", label: "Draft", initial: true },
        { id: "sem_1", label: "Published", terminal: true },
      ],
      transitions: [{ id: "t1", from: "sem_0", to: "sem_1", event: "publish" }],
    });
    expect(findMissingTransitions(els, []).status).toBe("clean");
    const hld = board().shape("node", "API").shape("database", "DB").arrow("API", "DB");
    expect(findMissingTransitions(hld.els, []).status).toBe("not-state");
  });

  it("works on a hand-drawn state diagram (initial dot, boxes, final ring)", () => {
    const b = board().shape("initial", "start").shape("node", "Booked").shape("node", "Completed").shape("final", "end");
    b.arrow("start", "Booked").arrow("Booked", "Completed", "check out").arrow("Completed", "end");
    const events = findMissingTransitions(b.els, []).suggestions.map((s) => s.event);
    expect(events).toEqual(["cancel", "refund"]);
  });

  it("a cancel that ends at the final pseudo-state counts (the /state starter draws it that way)", () => {
    const now = 1;
    const els = buildStarter("state", { x: 0, y: 0 }, now);
    const r = findMissingTransitions(els, []);
    expect(r.suggestions.map((s) => s.event)).toEqual(["refund"]);
  });

  it("ghosts: new target states plus labelled transitions, none on top of the diagram", () => {
    const els = orderLifecycle();
    const ghosts = buildTransitionGhosts(findMissingTransitions(els, []), els, 1);
    const states = ghosts.filter((e) => e.kind !== "arrow");
    const arrows = ghosts.filter((e) => e.kind === "arrow");
    expect(states.map((s) => s.label)).toEqual(["Cancelled", "Expired", "Refunded"]);
    expect(arrows.map((a) => a.label)).toEqual(["cancel", "timeout [after 15 min]", "refund"]);
    const boxes = [...els.filter((e) => e.kind !== "arrow"), ...states];
    const diagramBottom = Math.max(...els.filter((e) => e.kind !== "arrow").map((e) => e.y + e.height));
    for (const s of states) expect(s.y).toBeGreaterThan(diagramBottom);
    for (const s of states) {
      const hits = boxes.filter(
        (o) => o.id !== s.id && o.x < s.x + s.width && s.x < o.x + o.width && o.y < s.y + s.height && s.y < o.y + o.height
      );
      expect(hits.map((h) => h.label)).toEqual([]);
    }
  });
});
