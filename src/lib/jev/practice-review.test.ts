import { describe, expect, it } from "vitest";
import { getPracticePrompt, PRACTICE_PROMPTS, type PracticePrompt } from "@/lib/jev/practice-prompts";
import {
  extractBoardNumbers,
  mergeAiComments,
  reviewPracticeBoard,
  reviewSourceLabel,
  RUBRIC_KEYS,
  type PracticeReview,
} from "@/lib/jev/practice-review";
import type { ArrowEnd, ElementKind, JevElement } from "@/lib/jev/types";

let seq = 0;
function el(kind: ElementKind, label: string, extra: Partial<JevElement> = {}): JevElement {
  seq += 1;
  return {
    id: extra.id ?? `${kind}_${seq}`,
    kind,
    x: seq * 200,
    y: 100,
    width: 160,
    height: 70,
    label,
    tone: "ink",
    seed: seq,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}
function arrow(from: JevElement, to: JevElement, label = "", ends: { startEnd?: ArrowEnd; endEnd?: ArrowEnd } = {}) {
  return el("arrow", label, { fromId: from.id, toId: to.id, ...ends });
}

const url = getPracticePrompt("url-shortener") as PracticePrompt;
const chat = getPracticePrompt("chat") as PracticePrompt;
const score = (r: PracticeReview, key: (typeof RUBRIC_KEYS)[number]) => r.lines.find((l) => l.key === key)!.score;

function decentUrlShortener() {
  const req = el("text", "Requirements", {
    id: "req",
    sublabel: "Users shorten a long URL and get redirected\nCustom alias, expiry\nNon-functional: redirect p99 < 50 ms, 99.99% available",
  });
  const nums = el("text", "Estimates", { id: "nums", sublabel: "100M DAU\n10k QPS writes, 1M QPS reads\n5 TB over 5 years" });
  const user = el("actor", "User", { id: "user" });
  const lb = el("lb", "Load balancer", { id: "lb" });
  const api = el("node", "Redirect service", { id: "api" });
  const cache = el("cache", "Redis cache", { id: "cache" });
  const db = el("database", "Links DB", { id: "db", sublabel: "short_code PK\nlong_url\nexpires_at" });
  const trade = el("text", "Trade-off", { id: "trade", sublabel: "Base62 counter vs random codes: no collisions, but the counter is a hot single writer; cache gives eventual consistency on deletes" });
  return [
    req, nums, user, lb, api, cache, db, trade,
    arrow(user, lb, "GET /abc"), arrow(lb, api), arrow(api, cache, "read"), arrow(cache, db, "miss"),
  ];
}

describe("practice review scoring", () => {
  it("an empty board scores 0/10 with board-level 'missing' comments", () => {
    const r = reviewPracticeBoard([], url);
    expect(r.total).toBe(0);
    expect(r.max).toBe(10);
    expect(r.source).toBe("rules");
    expect(r.lines.map((l) => l.key)).toEqual([...RUBRIC_KEYS]);
    for (const line of r.lines) {
      expect(line.score).toBe(0);
      expect(line.reason.length).toBeGreaterThan(5);
    }
    expect(r.comments.length).toBeGreaterThanOrEqual(2);
    expect(r.comments.length).toBeLessThanOrEqual(6);
    expect(r.comments.every((c) => c.anchorId === null)).toBe(true);
    expect(r.comments.map((c) => c.text).join(" ")).toMatch(/No numbers on the board: write DAU and QPS/);
  });

  it("a decent URL shortener board scores high, 2/2 on every line", () => {
    const r = reviewPracticeBoard(decentUrlShortener(), url);
    expect(r.lines.map((l) => [l.key, l.score])).toEqual(RUBRIC_KEYS.map((k) => [k, 2]));
    expect(r.total).toBe(10);
    expect(r.comments.length).toBeGreaterThanOrEqual(2);
    expect(r.comments.length).toBeLessThanOrEqual(6);
  });

  it("a DB on the read path without a cache gets a comment pinned to that DB", () => {
    const user = el("actor", "Client", { id: "c" });
    const api = el("node", "API", { id: "a" });
    const db = el("database", "Postgres", { id: "pg" });
    const r = reviewPracticeBoard([user, api, db, arrow(user, api), arrow(api, db)], url);
    expect(score(r, "bottleneck")).toBe(0);
    const c = r.comments.find((x) => x.rubric === "bottleneck");
    expect(c?.anchorId).toBe("pg");
    expect(c?.text).toMatch(/where is the cache\?/i);
  });

  it("a cache that is drawn but not wired into the path is only half credit, pinned to the cache", () => {
    const api = el("node", "API", { id: "a" });
    const db = el("database", "Links", { id: "db" });
    const cache = el("cache", "Redis", { id: "rc" });
    const r = reviewPracticeBoard([api, db, cache, arrow(api, db)], url);
    expect(score(r, "bottleneck")).toBe(1);
    expect(r.comments.find((x) => x.rubric === "bottleneck")?.anchorId).toBe("rc");
  });

  it("the bottleneck fix depends on the prompt: a queue is the fix for chat, a cache for the shortener", () => {
    const user = el("actor", "User");
    const gw = el("node", "Chat service");
    const q = el("queue", "Kafka");
    const db = el("database", "Messages");
    const board = [user, gw, q, db, arrow(user, gw), arrow(gw, q), arrow(q, db)];
    expect(score(reviewPracticeBoard(board, chat), "bottleneck")).toBe(2);
    expect(score(reviewPracticeBoard(board, url), "bottleneck")).toBe(1);
  });

  it("requirements need functional and non-functional words in a note; component labels do not count", () => {
    const onlyBoxes = [el("node", "Redirect service"), el("node", "Shorten API")];
    expect(score(reviewPracticeBoard(onlyBoxes, url), "requirements")).toBe(0);
    const fOnly = el("text", "Users shorten links and get redirected", { id: "f" });
    const r1 = reviewPracticeBoard([fOnly], url);
    expect(score(r1, "requirements")).toBe(1);
    expect(r1.comments.find((c) => c.rubric === "requirements")?.anchorId).toBe("f");
    const both = el("text", "Users shorten links; redirect p99 < 50 ms, highly available");
    expect(score(reviewPracticeBoard([both], url), "requirements")).toBe(2);
  });

  it("numbers: needs load plus storage or latency, at a plausible order of magnitude for the prompt", () => {
    expect(score(reviewPracticeBoard([el("text", "10M DAU")], url), "numbers")).toBe(1);
    expect(score(reviewPracticeBoard([el("text", "10M DAU, 2k QPS, 3 TB")], url), "numbers")).toBe(2);
    const tiny = reviewPracticeBoard([el("text", "3 QPS, 1 GB", { id: "t" })], chat);
    expect(score(tiny, "numbers")).toBe(1);
    expect(tiny.lines.find((l) => l.key === "numbers")!.reason).toMatch(/order of magnitude/i);
    expect(tiny.comments.find((c) => c.rubric === "numbers")?.anchorId).toBe("t");
  });

  it("parses magnitudes and per-day rates", () => {
    const n = extractBoardNumbers([el("text", "100M writes/day, 1.5k QPS, p99 < 80ms, 2 TB, 20M DAU")]);
    expect(n.qps.map(Math.round)).toEqual([1157, 1500]);
    expect(n.users).toEqual([20_000_000]);
    expect(n.storage).toBe(true);
    expect(n.latency).toBe(true);
  });

  it("data model: a database with fields or ER entities score 2, a bare database 1", () => {
    expect(score(reviewPracticeBoard([el("database", "DB")], url), "dataModel")).toBe(1);
    expect(score(reviewPracticeBoard([el("database", "links", { sublabel: "short_code PK\nlong_url" })], url), "dataModel")).toBe(2);
    const a = el("entity", "User", { sublabel: "id PK" });
    const b = el("entity", "Link", { sublabel: "code PK\nuser_id FK" });
    expect(score(reviewPracticeBoard([a, b, arrow(a, b, "", { startEnd: "er_only_one", endEnd: "er_zero_many" })], url), "dataModel")).toBe(2);
  });

  it("trade-offs: a named choice with a cost scores 2; a bare quality word in the requirements does not count", () => {
    const req = el("text", "Requirements: users shorten links, low latency");
    expect(score(reviewPracticeBoard([req], url), "tradeoffs")).toBe(0);
    expect(score(reviewPracticeBoard([el("text", "SQL vs NoSQL")], url), "tradeoffs")).toBe(1);
    expect(score(reviewPracticeBoard([el("text", "Cache trade-off: stale reads for lower latency")], url), "tradeoffs")).toBe(2);
  });

  it("every prompt yields 2 to 6 comments on boards from empty to complete, and the review is deterministic", () => {
    const boards = [[], decentUrlShortener(), [el("database", "DB")], [el("text", "10M DAU")]];
    for (const p of PRACTICE_PROMPTS) {
      for (const b of boards) {
        const r = reviewPracticeBoard(b, p);
        expect(r.comments.length).toBeGreaterThanOrEqual(2);
        expect(r.comments.length).toBeLessThanOrEqual(6);
        expect(new Set(r.comments.map((c) => c.id)).size).toBe(r.comments.length);
        expect(reviewPracticeBoard(b, p)).toEqual(r);
        expect(reviewPracticeBoard([...b].reverse(), p).total).toBe(r.total);
      }
    }
  });
});

describe("AI comments on top of the rule-based review", () => {
  const board = decentUrlShortener();
  const base = reviewPracticeBoard(board, url);

  it("keeps the deterministic score, drops comments anchored to unknown ids and labels the source", () => {
    const merged = mergeAiComments(base, [
      { anchorId: "db", text: "Add a read replica plan for the Links DB." },
      { anchorId: "ghost", text: "Points at nothing." },
      { anchorId: null, text: "Walk the write path end to end." },
    ], board);
    expect(merged).not.toBeNull();
    expect(merged!.source).toBe("ai");
    expect(merged!.total).toBe(base.total);
    expect(merged!.lines).toEqual(base.lines);
    expect(merged!.comments.map((c) => c.anchorId)).toEqual(["db", null]);
    expect(reviewSourceLabel(merged!.source)).toBe("AI review");
    expect(reviewSourceLabel(base.source)).toBe("Rule-based review");
  });

  it("returns null (rule-based stays) when fewer than two usable AI comments remain", () => {
    expect(mergeAiComments(base, [{ anchorId: "ghost", text: "x" }, { anchorId: null, text: "  " }], board)).toBeNull();
    expect(mergeAiComments(base, [], board)).toBeNull();
  });

  it("ignores a malformed response from the server", () => {
    expect(mergeAiComments(base, { comments: "x" }, board)).toBeNull();
    expect(mergeAiComments(base, [null, { text: 3 }, { anchorId: 5, text: "a" }, "b"], board)).toBeNull();
  });

  it("caps AI comments at six and trims long text", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ anchorId: null, text: `Point ${i} ${"y".repeat(400)}` }));
    const merged = mergeAiComments(base, many, board)!;
    expect(merged.comments).toHaveLength(6);
    expect(merged.comments.every((c) => c.text.length <= 240)).toBe(true);
  });
});
