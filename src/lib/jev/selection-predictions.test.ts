// Charles (21 Nov 2026): selecting existing node(s) shows context predictions anchored to the selection,
// at the right time (after a short idle, never while dragging/editing, Esc suppresses until the selection changes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateCandidatePool,
  generateSelectionPredictions,
  isContextNamed,
  selectTopSuggestions,
} from "@/lib/jev/prediction-engine";
import { isAdditiveSelectClick, SelectionSuggestTrigger, selectionKey } from "@/lib/jev/selection-trigger";
import type { JevElement, PredictedAction } from "@/lib/jev/types";

const el = (o: Partial<JevElement> & { id: string; label: string }): JevElement => ({
  kind: "node",
  x: 100,
  y: 100,
  width: 160,
  height: 72,
  tone: "cobalt",
  seed: 1,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});
const arrow = (id: string, fromId: string, toId: string): JevElement =>
  el({ id, kind: "arrow", label: "", fromId, toId, x: 0, y: 0, width: 0, height: 0 });

const newShapes = (a: PredictedAction) => a.addElements.filter((e) => e.kind !== "arrow");
const arrowsOf = (a: PredictedAction) => a.addElements.filter((e) => e.kind === "arrow");
const isLink = (a: PredictedAction) => a.addElements.length > 0 && a.addElements.every((e) => e.kind === "arrow");

describe("selection predictions", () => {
  it("returns nothing for an empty selection or arrows only", () => {
    const board = [el({ id: "a", label: "A" }), el({ id: "b", label: "B" }), arrow("ab", "a", "b")];
    expect(generateSelectionPredictions([], board)).toBeNull();
    expect(generateSelectionPredictions(["ab"], board)).toBeNull();
  });

  it("a single selected node reuses the normal pipeline, anchored to that node", () => {
    const board = [
      el({ id: "co", label: "Checkout", x: 100, y: 100 }),
      el({ id: "eh", label: "Error Handler", x: 420, y: 100 }),
      arrow("ar1", "co", "eh"),
    ];
    const res = generateSelectionPredictions(["eh"], board, { boardTitle: "Shop" })!;
    expect(res.intent.subjectId).toBe("eh");
    const expected = generateCandidatePool(res.intent, board, { boardTitle: "Shop" });
    const strip = (a: PredictedAction[]) => a.map((x) => ({ title: x.title, at: newShapes(x).map((n) => [n.x, n.y]) }));
    expect(strip(res.pool)).toEqual(strip(expected));
    const extend = res.pool.filter((a) => a.category === "extend");
    expect(extend.length).toBeGreaterThan(0);
    for (const a of extend) expect(arrowsOf(a)[0].fromId).toBe("eh");
    expect(selectTopSuggestions(res.pool).every(isContextNamed)).toBe(true);
  });

  it("two unconnected selected nodes get a link chosen by meaning, with a relation label", () => {
    const board = [
      el({ id: "co", label: "Checkout", x: 100, y: 100 }),
      el({ id: "db", label: "Orders DB", kind: "database", x: 500, y: 300 }),
    ];
    const res = generateSelectionPredictions(["co", "db"], board)!;
    const links = res.pool.filter(isLink);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const a = arrowsOf(links[0])[0];
    expect([a.fromId, a.toId]).toEqual(["co", "db"]);
    expect(a.label).toBe("writes to");
    expect(links[0].title).toBe("Link Checkout → Orders DB");
    expect(selectTopSuggestions(res.pool)).toContain(links[0]);
  });

  it("never proposes a link that already exists", () => {
    const board = [
      el({ id: "co", label: "Checkout", x: 100, y: 100 }),
      el({ id: "pay", label: "Payment Service", x: 500, y: 100 }),
      arrow("x", "co", "pay"),
    ];
    const res = generateSelectionPredictions(["co", "pay"], board)!;
    expect(res.pool.filter(isLink)).toHaveLength(0);
  });

  it("three selected nodes get a group next node connected to each of them, placed clear of the selection", () => {
    const board = [
      el({ id: "co", label: "Checkout", x: 100, y: 100 }),
      el({ id: "inv", label: "Inventory", x: 100, y: 260 }),
      el({ id: "pay", label: "Payment Service", x: 380, y: 180 }),
    ];
    const res = generateSelectionPredictions(["co", "inv", "pay"], board)!;
    const group = res.pool.find((a) => newShapes(a).length === 1 && arrowsOf(a).length === 3)!;
    expect(group).toBeDefined();
    const node = newShapes(group)[0];
    expect(node.label).toBe("Order Service");
    const ends = arrowsOf(group).map((a) => [a.fromId, a.toId]);
    for (const id of ["co", "inv", "pay"]) {
      expect(ends.some(([f, t]) => (f === node.id && t === id) || (f === id && t === node.id))).toBe(true);
    }
    const right = Math.max(...board.map((b) => b.x + b.width));
    expect(node.x).toBeGreaterThanOrEqual(right);
    expect(isContextNamed(group)).toBe(true);
    expect(selectTopSuggestions(res.pool).filter((a) => !isContextNamed(a)).length).toBeLessThanOrEqual(1);
  });

  it("Checkout + Inventory suggests an Order Service connected to both", () => {
    const board = [el({ id: "co", label: "Checkout", x: 100, y: 100 }), el({ id: "inv", label: "Inventory", x: 400, y: 100 })];
    const res = generateSelectionPredictions(["co", "inv"], board)!;
    const group = res.pool.find((a) => newShapes(a).length === 1 && arrowsOf(a).length === 2);
    expect(group && newShapes(group)[0].label).toBe("Order Service");
  });
});

describe("SelectionSuggestTrigger", () => {
  let fired: string[];
  let trigger: SelectionSuggestTrigger;

  beforeEach(() => {
    vi.useFakeTimers();
    fired = [];
    trigger = new SelectionSuggestTrigger({ delayMs: 500, onFire: (key) => fired.push(key) });
  });
  afterEach(() => {
    trigger.reset();
    vi.useRealTimers();
  });

  it("builds an order-independent key", () => {
    expect(selectionKey(["b", "a"])).toBe(selectionKey(["a", "b"]));
    expect(selectionKey([])).toBe("");
  });

  it("fires once after the idle delay for a newly selected node", () => {
    trigger.select(["n1"]);
    vi.advanceTimersByTime(499);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["n1"]);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(["n1"]);
  });

  it("does not fire while the canvas is busy (drag, marquee, text edit) and fires once it settles", () => {
    trigger.select(["n1"]);
    trigger.setBusy(true);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual([]);
    trigger.setBusy(false);
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(["n1"]);
  });

  it("never fires for a selection that was moved or edited (those flows show their own predictions)", () => {
    trigger.select(["n1"]);
    trigger.setBusy(true);
    trigger.consume();
    trigger.setBusy(false);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual([]);
  });

  it("a multi-select built during a marquee fires after the marquee ends", () => {
    trigger.setBusy(true);
    trigger.select(["a"]);
    trigger.select(["a", "b"]);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual([]);
    trigger.setBusy(false);
    vi.advanceTimersByTime(500);
    expect(fired).toEqual([selectionKey(["a", "b"])]);
  });

  it("Esc suppresses the current selection until it changes", () => {
    trigger.select(["n1"]);
    vi.advanceTimersByTime(500);
    trigger.dismiss();
    trigger.select(["n1"]);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(["n1"]);
    trigger.select(["n2"]);
    vi.advanceTimersByTime(500);
    trigger.select(["n1"]);
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(["n1", "n2", "n1"]);
  });

  it("Esc before the delay cancels the pending fire", () => {
    trigger.select(["n1"]);
    vi.advanceTimersByTime(200);
    trigger.dismiss();
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual([]);
  });

  it("restarts the delay when the selection changes and cancels on deselect", () => {
    trigger.select(["n1"]);
    vi.advanceTimersByTime(300);
    trigger.select(["n2"]);
    vi.advanceTimersByTime(300);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(fired).toEqual(["n2"]);
    trigger.select(["n3"]);
    trigger.select([]);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(["n2"]);
  });

  it("adopts programmatic selections silently, so clicking the earlier node again still fires", () => {
    trigger.select(["n1"]);
    vi.advanceTimersByTime(500);
    trigger.adopt(["created"]);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(["n1"]);
    trigger.select(["n1"]);
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(["n1", "n1"]);
    trigger.adopt(["n1"]);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(["n1", "n1"]);
  });

  it("exposes an abort signal per fire that aborts when the selection changes", () => {
    const signals: AbortSignal[] = [];
    trigger.reset();
    trigger = new SelectionSuggestTrigger({ delayMs: 500, onFire: (_key, signal) => signals.push(signal) });
    trigger.select(["n1"]);
    vi.advanceTimersByTime(500);
    expect(signals[0].aborted).toBe(false);
    trigger.select(["n2"]);
    expect(signals[0].aborted).toBe(true);
  });
});

describe("additive selection clicks", () => {
  it("Shift, Cmd and Ctrl add to the selection; a plain click does not", () => {
    expect(isAdditiveSelectClick({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(true);
    expect(isAdditiveSelectClick({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(isAdditiveSelectClick({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isAdditiveSelectClick({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("the canvas uses it for click selection", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../components/jev/JevCanvas.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/if \(isAdditiveSelectClick\(e\)\) \{/);
  });
});
