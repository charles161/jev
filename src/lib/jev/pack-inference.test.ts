import { describe, expect, it } from "vitest";
import { inferPackChips, packChipAction, tableEntityPatch } from "./pack-inference";
import type { JevElement } from "./types";

let n = 0;
function el(partial: Partial<JevElement>): JevElement {
  n += 1;
  return {
    id: partial.id ?? `e${n}`,
    kind: "node",
    x: 0,
    y: 0,
    width: 160,
    height: 64,
    label: "",
    tone: "ink",
    seed: 1,
    createdAt: n,
    updatedAt: n,
    ...partial,
  };
}

const arrow = (partial: Partial<JevElement>) => el({ kind: "arrow", width: 0, height: 0, ...partial });

describe("ER pack: a database that names a table", () => {
  it.each(["users table", "Users", "orders", "order_items table", "payments tbl"])("%s offers the ER chip", (label) => {
    const db = el({ id: "db", kind: "database", label });
    const chips = inferPackChips([db]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ kind: "er-entity", elementId: "db", title: "ER pack: turn into entity with PK/FK" });
  });

  it.each(["Postgres", "Ledger DB", "Primary", "Read replica"])("%s (a database, not a table) offers nothing", (label) => {
    expect(inferPackChips([el({ kind: "database", label })])).toEqual([]);
  });

  it("only a database or box shape counts, and a morphed shape is left alone", () => {
    expect(inferPackChips([el({ kind: "queue", label: "orders" })])).toEqual([]);
    expect(inferPackChips([el({ kind: "node", label: "users table" })])).toHaveLength(1);
    expect(
      inferPackChips([el({ kind: "database", label: "users", morphMeta: { groupId: "g", notation: "er", role: "entity" } })])
    ).toEqual([]);
  });

  it("converts to an entity with an id PK row, named after the table, keeping its centre", () => {
    const db = el({ id: "db", kind: "database", label: "Users table", x: 100, y: 100, width: 156, height: 86 });
    const patch = tableEntityPatch(db);
    expect(patch).toMatchObject({ kind: "entity", label: "users", sublabel: "id uuid PK\ncreated_at timestamptz" });
    expect(patch.x! + patch.width! / 2).toBe(100 + 156 / 2);
    expect(patch.y! + patch.height! / 2).toBe(100 + 86 / 2);
    const action = packChipAction(inferPackChips([db])[0], [db]);
    expect(action).toMatchObject({ type: "patch", id: "db", openPack: "er" });
  });
});

describe("Crow's foot: an arrow labelled with a cardinality", () => {
  const a = el({ id: "a", x: 0, y: 0, label: "users", kind: "entity" });
  const b = el({ id: "b", x: 400, y: 0, label: "orders", kind: "entity" });

  it.each([
    ["1:N", "er_only_one", "er_zero_many"],
    ["1:1", "er_only_one", "er_only_one"],
    ["N:M", "er_zero_many", "er_zero_many"],
    ["one-to-many", "er_only_one", "er_zero_many"],
  ])("%s → crow's-foot ends and the text label is cleared", (label, startEnd, endEnd) => {
    const rel = arrow({ id: "r", fromId: "a", toId: "b", label });
    const chips = inferPackChips([a, b, rel]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ kind: "crows-foot", elementId: "r", title: "Crow's foot" });
    expect(chips[0].anchor).toEqual({ x: 280, y: 32 });
    expect(packChipAction(chips[0], [a, b, rel])).toEqual({ type: "patch", id: "r", patch: { startEnd, endEnd, label: "" } });
  });

  it("ignores ordinary labels and arrows that already have crow's-foot ends", () => {
    expect(inferPackChips([a, b, arrow({ fromId: "a", toId: "b", label: "reads" })])).toEqual([]);
    expect(inferPackChips([a, b, arrow({ fromId: "a", toId: "b", label: "1:N", endEnd: "er_many" })])).toEqual([]);
  });
});

describe("Sequence pack: lifelines in a row with horizontal labelled messages", () => {
  const box = (id: string, x: number) => el({ id, x, y: 0, width: 120, height: 50, label: id });
  const life = (x: number) => arrow({ fromPoint: { x, y: 60 }, toPoint: { x, y: 360 }, dashed: true, label: "" });

  it("two boxes with lifelines and a labelled message between them", () => {
    const els = [box("Client", 0), box("API", 300), life(60), life(360), arrow({ id: "m", fromPoint: { x: 60, y: 120 }, toPoint: { x: 360, y: 120 }, label: "POST /orders" })];
    const chips = inferPackChips(els);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ kind: "sequence", title: "Sequence pack" });
    expect(new Set(chips[0].elementIds)).toEqual(new Set(["Client", "API"]));
    expect(packChipAction(chips[0], els)).toEqual({ type: "open-pack", pack: "sequence" });
  });

  it("a left-to-right HLD flow without lifelines is not a sequence diagram", () => {
    const els = [box("Client", 0), box("API", 300), arrow({ fromId: "Client", toId: "API", label: "POST" })];
    expect(inferPackChips(els)).toEqual([]);
  });

  it("needs a labelled horizontal message, not just lifelines", () => {
    expect(inferPackChips([box("A", 0), box("B", 300), life(60), life(360)])).toEqual([]);
  });
});

describe("State pack", () => {
  it("a label like 'pending → paid' offers the State pack", () => {
    const t = el({ id: "t", kind: "text", label: "pending → paid → shipped" });
    const chips = inferPackChips([t]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ kind: "state", elementId: "t", title: "State pack" });
    expect(packChipAction(chips[0], [t])).toEqual({ type: "open-pack", pack: "state" });
  });

  it("two state-named boxes joined by an arrow morph to a state diagram", () => {
    const p = el({ id: "p", label: "Pending" });
    const q = el({ id: "q", label: "Paid", x: 300 });
    const tr = arrow({ id: "tr", fromId: "p", toId: "q", label: "pay" });
    const chips = inferPackChips([p, q, tr]);
    expect(chips).toHaveLength(1);
    expect(chips[0].kind).toBe("state");
    expect(packChipAction(chips[0], [p, q, tr])).toEqual({ type: "morph", notation: "state", ids: ["p", "q"] });
  });

  it("ordinary flows and arrows between services are not states", () => {
    expect(inferPackChips([el({ kind: "text", label: "client -> api" })])).toEqual([]);
    const a = el({ id: "a", label: "Order Service" });
    const b = el({ id: "b", label: "Payment Service", x: 300 });
    expect(inferPackChips([a, b, arrow({ fromId: "a", toId: "b", label: "pay" })])).toEqual([]);
  });
});

describe("chip hygiene", () => {
  it("a dismissed chip stays gone, and each element gets at most one chip", () => {
    const db = el({ id: "db", kind: "database", label: "users table" });
    const [chip] = inferPackChips([db]);
    expect(inferPackChips([db], { dismissed: new Set([chip.id]) })).toEqual([]);
    const ids = inferPackChips([db, el({ id: "db2", kind: "database", label: "orders" })]).map((c) => c.elementId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("most recently touched element first", () => {
    const old = el({ id: "old", kind: "database", label: "users", updatedAt: 1 });
    const fresh = el({ id: "fresh", kind: "database", label: "orders", updatedAt: 99 });
    expect(inferPackChips([old, fresh]).map((c) => c.elementId)).toEqual(["fresh", "old"]);
  });
});
