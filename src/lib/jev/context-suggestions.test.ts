// Charles (21 Nov 2026): "Mostly everything should be context based." Suggestions are named from
// what is on the board (selected node, its neighbours, the board title), never a bare "Next Step".
import { describe, expect, it } from "vitest";
import {
  buildRankingContext,
  GENERIC_SUGGESTION_LABELS,
  generateCandidatePool,
  isContextNamed,
  mergeContextSuggestions,
  selectTopSuggestions,
  type ContextSuggestion,
} from "@/lib/jev/prediction-engine";
import type { JevElement, PredictedAction, SpatialIntent } from "@/lib/jev/types";

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
const intent = (kind: SpatialIntent["kind"], subjectId: string, relatedIds: string[] = []): SpatialIntent => ({
  kind,
  headline: "h",
  detail: "d",
  subjectId,
  relatedIds,
  timestamp: 1,
});

const newLabel = (a: PredictedAction) => a.addElements.find((e) => e.kind !== "arrow")?.label ?? null;
const links = (a: PredictedAction[]) =>
  a.filter((x) => x.addElements.length === 1 && x.addElements[0].kind === "arrow").map((x) => {
    const e = x.addElements[0];
    return `${e.fromId}->${e.toId}`;
  });

const fixtures = {
  lonely: { board: [el({ id: "a", label: "Widget", x: 200, y: 200 })], intent: intent("domain_continue", "a") },
  related: {
    board: [el({ id: "co", label: "Checkout", x: 100, y: 100 }), el({ id: "pay", label: "Payment Service", x: 520, y: 340 })],
    intent: intent("domain_continue", "co"),
  },
  chain: {
    board: [el({ id: "co", label: "Checkout", x: 100, y: 100 }), el({ id: "eh", label: "Error Handler", x: 420, y: 100 }), arrow("ar1", "co", "eh")],
    intent: intent("domain_continue", "eh"),
  },
};

const llmProposals: Record<keyof typeof fixtures, ContextSuggestion[]> = {
  lonely: [{ id: "ctx_0", label: "Widget Renderer", sublabel: "Draw widget", kind: "node", edgeLabel: "render" }],
  related: [{ id: "ctx_0", label: "Order Ledger", sublabel: "Record order", kind: "database", edgeLabel: "record" }],
  chain: [
    { id: "ctx_0", label: "Payment Retry Worker", sublabel: "Backoff retries", kind: "node", edgeLabel: "retry" },
    { id: "ctx_1", label: "Refund Check?", sublabel: "Reverse charge", kind: "diamond", edgeLabel: "check" },
  ],
};

function top3(name: keyof typeof fixtures, llm: boolean) {
  const { board, intent: i } = fixtures[name];
  const pool = generateCandidatePool(i, board, { boardTitle: "Shop" });
  const merged = llm ? mergeContextSuggestions(pool, llmProposals[name], i, board) : pool;
  return selectTopSuggestions(merged);
}

describe("context-named suggestions", () => {
  for (const llm of [false, true]) {
    const tag = llm ? "LLM on" : "LLM off";

    it(`Checkout → Error Handler suggests failure-handling components, not "Next Step" (${tag})`, () => {
      const top = top3("chain", llm);
      expect(top).toHaveLength(3);
      const labels = top.map(newLabel).filter(Boolean) as string[];
      expect(labels.some((l) => !GENERIC_SUGGESTION_LABELS.has(l))).toBe(true);
      expect(top.filter(isContextNamed).length).toBeGreaterThanOrEqual(2);
      expect(top.filter((a) => !isContextNamed(a)).length).toBeLessThanOrEqual(1);
      expect(labels).not.toContain("Next Step");
      if (llm) expect(labels).toContain("Payment Retry Worker");
      else expect(labels.some((l) => /retry|dead.?letter|failed alert/i.test(l))).toBe(true);
    });

    it(`a lonely node gets label-derived names, never a bare "Next Step" (${tag})`, () => {
      const top = top3("lonely", llm);
      expect(top).toHaveLength(3);
      const labels = top.map(newLabel);
      expect(labels).not.toContain("Next Step");
      expect(top.filter((a) => !isContextNamed(a)).length).toBeLessThanOrEqual(1);
      if (llm) expect(labels).toContain("Widget Renderer");
      else expect(labels.some((l) => l?.includes("Widget"))).toBe(true);
    });

    it(`two unconnected related nodes get a link option and a connected new node (${tag})`, () => {
      const top = top3("related", llm);
      expect(top).toHaveLength(3);
      expect(links(top)).toEqual(expect.arrayContaining([expect.stringMatching(/^(co->pay|pay->co)$/)]));
      expect(top.some((a) => a.category === "extend" && newLabel(a) !== null && isContextNamed(a))).toBe(true);
      expect(top.filter((a) => !isContextNamed(a)).length).toBeLessThanOrEqual(1);
    });
  }

  it("links by meaning before proximity", () => {
    const board = [
      el({ id: "co", label: "Checkout", x: 100, y: 100 }),
      el({ id: "logo", label: "Logo", x: 300, y: 100 }),
      el({ id: "pay", label: "Payment Service", x: 900, y: 600 }),
    ];
    const pool = generateCandidatePool(intent("domain_continue", "co"), board);
    expect(links(pool)[0]).toMatch(/^(co->pay|pay->co)$/);
  });

  it("also offers a proximity link when nothing is related by meaning", () => {
    const board = [el({ id: "a", label: "Widget", x: 100, y: 100 }), el({ id: "b", label: "Gizmo", x: 400, y: 100 })];
    const pool = generateCandidatePool(intent("domain_continue", "a"), board);
    expect(links(pool)).toEqual(expect.arrayContaining([expect.stringMatching(/^(a->b|b->a)$/)]));
  });

  it("keeps at most one generic option even when the ranker prefers generic ones", () => {
    const { board, intent: i } = fixtures.chain;
    const pool = generateCandidatePool(i, board);
    const genericFirst = [...pool].sort((a, b) => Number(isContextNamed(a)) - Number(isContextNamed(b)));
    const top = selectTopSuggestions(genericFirst);
    expect(top.filter((a) => !isContextNamed(a)).length).toBeLessThanOrEqual(1);
  });

  it("builds a compact ranking context from the subject, its neighbours and the board title", () => {
    const { board, intent: i } = fixtures.chain;
    expect(buildRankingContext(i, board, "Shop")).toEqual({
      subjectLabel: "Error Handler",
      neighborLabels: ["Checkout"],
      boardTitle: "Shop",
    });
    expect(buildRankingContext(null, board, "Shop")).toBeNull();
  });

  it("places LLM-proposed nodes with the existing pool placement and drops generic or duplicate names", () => {
    const { board, intent: i } = fixtures.chain;
    const pool = generateCandidatePool(i, board);
    const merged = mergeContextSuggestions(
      pool,
      [
        { id: "ctx_0", label: "Payment Retry Worker", kind: "node" },
        { id: "ctx_1", label: "Next Step", kind: "node" },
        { id: "ctx_2", label: "Checkout", kind: "node" },
      ],
      i,
      board
    );
    const added = merged.filter((a) => a.id.startsWith("ctx_"));
    expect(added.map((a) => a.id)).toEqual(["ctx_0"]);
    const node = added[0].addElements.find((e) => e.kind !== "arrow")!;
    const subject = board[1];
    expect(node.x).toBeGreaterThanOrEqual(subject.x + subject.width + 96);
    expect(added[0].addElements.find((e) => e.kind === "arrow")?.fromId).toBe("eh");
  });
});
