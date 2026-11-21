import { describe, expect, it } from "vitest";
import { board } from "./__fixtures__/boards";
import { boardDigest, mergeEnriched, type MoveFinding } from "./enrich";

const RULE: MoveFinding[] = [
  { id: "break", title: "Orders DB takes every read and write", lines: ["Why: one primary", "Fix: add a cache"] },
  { id: "a7", title: "Timeout", lines: ["No timeout: set one"] },
];

describe("mergeEnriched: AI text replaces rule text only when it validates", () => {
  it("takes valid rewrites by id and keeps the rule text for findings the AI skipped", () => {
    const merged = mergeEnriched(RULE, {
      findings: [{ id: "break", title: "Orders DB is the 10× wall", lines: ["Why: 30K QPS on one Postgres", "Fix: Redis read-through for /orders"] }],
    });
    expect(merged).toEqual([
      { id: "break", title: "Orders DB is the 10× wall", lines: ["Why: 30K QPS on one Postgres", "Fix: Redis read-through for /orders"] },
      RULE[1],
    ]);
  });

  it("drops findings the AI invented and returns null when nothing valid is left", () => {
    expect(mergeEnriched(RULE, { findings: [{ id: "made-up", title: "Kafka will melt", lines: ["x"] }] })).toBeNull();
    expect(mergeEnriched(RULE, { findings: [{ id: "break", title: "", lines: [] }] })).toBeNull();
    expect(mergeEnriched(RULE, "not json")).toBeNull();
    expect(mergeEnriched(RULE, { findings: [{ id: "break", title: "t", lines: ["x".repeat(400)] }] })).toBeNull();
  });
});

describe("boardDigest", () => {
  it("is the component labels, kinds and arrows, nothing else", () => {
    const b = board().shape("node", "API").shape("database", "DB").shape("card", "Notes").arrow("API", "DB", "write");
    expect(boardDigest(b.els)).toEqual({
      nodes: [
        { id: b.id("API"), label: "API", kind: "node" },
        { id: b.id("DB"), label: "DB", kind: "database" },
      ],
      edges: [{ from: b.id("API"), to: b.id("DB"), label: "write" }],
    });
  });
});
