// Charles (21 Nov 2026): context-named suggestions must not move where ghost nodes land.
// This pins the geometry of every suggestion (new node positions, arrow wiring, patches, removals)
// with labels and shape kinds stripped, because only naming may change.
import { describe, expect, it } from "vitest";
import { generateCandidatePool, generatePredictions } from "@/lib/jev/prediction-engine";
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
const arrow = (id: string, fromId: string, toId: string, label = ""): JevElement =>
  el({ id, kind: "arrow", label, fromId, toId, x: 0, y: 0, width: 0, height: 0 });
const intent = (kind: SpatialIntent["kind"], subjectId: string, relatedIds: string[] = []): SpatialIntent => ({
  kind,
  headline: "h",
  detail: "d",
  subjectId,
  relatedIds,
  timestamp: 1,
});

const lonely = [el({ id: "a", label: "Widget", x: 200, y: 200 })];
const related = [
  el({ id: "co", label: "Checkout", x: 100, y: 100 }),
  el({ id: "pay", label: "Payment Service", x: 520, y: 340 }),
];
const chain = [
  el({ id: "co", label: "Checkout", x: 100, y: 100 }),
  el({ id: "eh", label: "Error Handler", x: 420, y: 100 }),
  arrow("ar1", "co", "eh"),
];
const spliceBoard = [
  el({ id: "u", label: "User", x: 0, y: 0 }),
  el({ id: "db", label: "Postgres", kind: "database", x: 600, y: 0 }),
  el({ id: "mid", label: "Cache", x: 300, y: 10 }),
  arrow("e1", "u", "db"),
];
const diamond = [el({ id: "d", label: "Valid?", kind: "diamond", x: 300, y: 200, width: 148, height: 96 })];

const cases: Array<[string, SpatialIntent, JevElement[]]> = [
  ["lonely domain_continue", intent("domain_continue", "a"), lonely],
  ["lonely branch_out", intent("branch_out", "a"), lonely],
  ["related domain_continue", intent("domain_continue", "pay"), related],
  ["related connect_nearby", intent("connect_nearby", "pay", ["co"]), related],
  ["related align_pipeline", intent("align_pipeline", "pay", ["co"]), related],
  ["chain domain_continue", intent("domain_continue", "eh"), chain],
  ["chain align_pipeline linked", intent("align_pipeline", "eh", ["co"]), chain],
  ["chain branch_out", intent("branch_out", "eh", ["co"]), chain],
  ["chain open_pipeline_gap", intent("open_pipeline_gap", "eh", ["co", "ar1"]), chain],
  ["splice", intent("splice_into_edge", "mid", ["e1", "u", "db"]), spliceBoard],
  ["decision_branch", intent("decision_branch", "d"), diamond],
];

function geometry(actions: PredictedAction[], board: JevElement[]) {
  const known = new Set(board.map((e) => e.id));
  return actions.map((a) => {
    const names = new Map<string, string>();
    a.addElements.filter((e) => e.kind !== "arrow").forEach((e, i) => names.set(e.id, `new${i}`));
    const ref = (id?: string) => (id && known.has(id) ? id : id ? names.get(id) ?? "?" : null);
    return {
      category: a.category,
      nodes: a.addElements.filter((e) => e.kind !== "arrow").map((e) => ({ frame: e.kind === "frame", x: e.x, y: e.y })),
      arrows: a.addElements.filter((e) => e.kind === "arrow").map((e) => [ref(e.fromId), ref(e.toId)]),
      patch: a.patchElements ?? [],
      remove: a.removeIds ?? [],
      focus: ref(a.focusId),
    };
  });
}

describe("suggestion placement is pinned", () => {
  for (const [name, i, board] of cases) {
    it(`generatePredictions geometry: ${name}`, () => {
      expect(geometry(generatePredictions(i, board), board)).toMatchSnapshot();
    });
    it(`candidate pool new-node geometry: ${name}`, () => {
      const pool = generateCandidatePool(i, board).filter((a) => a.addElements.some((e) => e.kind !== "arrow"));
      expect(geometry(pool, board)).toMatchSnapshot();
    });
  }
});
