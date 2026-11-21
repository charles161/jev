import type { PracticePrompt, PracticePromptId } from "@/lib/jev/practice-prompts";
import type { JevElement } from "@/lib/jev/types";

export const RUBRIC_KEYS = ["requirements", "numbers", "dataModel", "bottleneck", "tradeoffs"] as const;
export type RubricKey = (typeof RUBRIC_KEYS)[number];

export const RUBRIC_LABELS: Record<RubricKey, string> = {
  requirements: "Requirements",
  numbers: "Numbers",
  dataModel: "Data model",
  bottleneck: "Bottleneck",
  tradeoffs: "Trade-offs",
};

export type RubricScore = 0 | 1 | 2;

export interface RubricLine {
  key: RubricKey;
  score: RubricScore;
  reason: string;
  anchorId: string | null;
}

export interface ReviewComment {
  id: string;
  rubric: RubricKey | null;
  /** Element the comment is pinned to; null = about the whole board (something is missing). */
  anchorId: string | null;
  text: string;
}

export type ReviewSource = "rules" | "ai";

export interface PracticeReview {
  promptId: PracticePromptId;
  total: number;
  max: 10;
  lines: RubricLine[];
  comments: ReviewComment[];
  source: ReviewSource;
}

export const MIN_COMMENTS = 2;
export const MAX_COMMENTS = 6;
export const MAX_COMMENT_CHARS = 240;

export function reviewSourceLabel(source: ReviewSource): string {
  return source === "ai" ? "AI review" : "Rule-based review";
}

const DATASTORE_KINDS = new Set<string>(["database", "blob"]);
const ENTRY_KINDS = new Set<string>(["actor", "ellipse", "lb"]);
const NON_COMPONENT_KINDS = new Set<string>(["arrow", "freedraw", "text", "frame", "zone", "fragment"]);
const GENERIC_FIX_KINDS = new Set<string>(["cache", "queue"]);
const GENERIC_FIX_WORDS = /(cache|redis|queue|kafka|replica|shard|partition|rate limit|cdn)/;
const ENTRY_WORDS = /\b(client|user|browser|app|mobile)\b/;

const textOf = (e: JevElement) => `${e.label}\n${e.sublabel ?? ""}`.toLowerCase();
const isComponent = (e: JevElement) => !NON_COMPONENT_KINDS.has(e.kind);

function sortForReview(elements: JevElement[]): JevElement[] {
  return elements
    .filter((e) => e.kind !== "freedraw")
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

function fmt(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

// ---------------------------------------------------------------- numbers

const MULTIPLIER: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
const RATE_NOUN = "(?:writes?|reads?|requests?|messages?|events?|links?|urls?|posts?|notifications?|payments?|sends?|calls?)";
const NUMBER_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(bn|k|m|b)?\\s*(qps|rps|req/s|${RATE_NOUN}\\s*(?:/|per\\s+)\\s*(?:s|sec|second|day|d)|dau|mau|users?|gb|tb|pb|ms)\\b`,
  "gi"
);

export interface BoardNumbers {
  qps: number[];
  users: number[];
  storage: boolean;
  latency: boolean;
  /** First element carrying any figure, and the elements carrying each QPS value (same order as qps). */
  firstId: string | null;
  qpsIds: string[];
}

export function extractBoardNumbers(elements: JevElement[]): BoardNumbers {
  const out: BoardNumbers = { qps: [], users: [], storage: false, latency: false, firstId: null, qpsIds: [] };
  for (const e of sortForReview(elements)) {
    for (const m of textOf(e).matchAll(NUMBER_RE)) {
      const value = Number(m[1]) * (m[2] ? MULTIPLIER[m[2].toLowerCase()] : 1);
      const unit = m[3].toLowerCase();
      out.firstId ??= e.id;
      if (unit === "gb" || unit === "tb" || unit === "pb") out.storage = true;
      else if (unit === "ms") out.latency = true;
      else if (unit === "dau" || unit === "mau" || unit.startsWith("user")) out.users.push(value);
      else {
        out.qps.push(/(day|d)$/.test(unit) ? value / 86_400 : value);
        out.qpsIds.push(e.id);
      }
    }
  }
  return out;
}

function scoreNumbers(elements: JevElement[], prompt: PracticePrompt): RubricLine {
  const n = extractBoardNumbers(elements);
  const [lo, hi] = prompt.qpsRange;
  const hasLoad = n.qps.length > 0 || n.users.length > 0;
  if (!hasLoad && !n.storage && !n.latency) {
    return { key: "numbers", score: 0, reason: "No DAU, QPS, storage or latency figures on the board", anchorId: null };
  }
  if (n.qps.length > 0 && !n.qps.some((q) => q >= lo && q <= hi)) {
    const worst = n.qps[0];
    return {
      key: "numbers",
      score: 1,
      reason: `${fmt(worst)} QPS is off by an order of magnitude for ${prompt.title.toLowerCase()} (expect ${fmt(lo)} to ${fmt(hi)})`,
      anchorId: n.qpsIds[0],
    };
  }
  if (!hasLoad) {
    return { key: "numbers", score: 1, reason: "Storage or latency written, but no DAU or QPS", anchorId: n.firstId };
  }
  if (!n.storage && !n.latency) {
    return { key: "numbers", score: 1, reason: "Load is there, but no storage or latency figure", anchorId: n.firstId };
  }
  return { key: "numbers", score: 2, reason: "Load plus storage or latency, at a plausible scale", anchorId: n.firstId };
}

// ---------------------------------------------------------------- requirements

const TRADEOFF_PHRASE_RE = /\b(vs\.?|versus|trade-?offs?|instead of|at the cost of|rather than|in exchange for|pros?|cons?)\b/;
const QUALITY_RE = /(consisten|latency|\bcost|availab|durab|throughput|complexit|eventual|stale|\bcap\b|memory|accuracy|amplification|hot (single )?writer)/;


const FUNCTIONAL_RE = /\b(functional requirements?|users? (can|should|must)|must|should)\b/;
const NON_FUNCTIONAL_RE =
  /(non-?functional|latency|\bp9\d|availab|consisten|durab|scalab|throughput|\bsla\b|99\.9|uptime|fault.?toleran|reliab|\d+\s*ms\b)/;

interface RequirementHit {
  el: JevElement;
  functional: boolean;
  nonFunctional: boolean;
}

function requirementHits(sorted: JevElement[], prompt: PracticePrompt): RequirementHit[] {
  return sorted
    .filter((e) => textOf(e).includes("requirement") || (e.kind === "text" && !TRADEOFF_PHRASE_RE.test(textOf(e))))
    .map((el) => {
      const text = textOf(el);
      const forFunctional = text.replace(/non-?functional/g, " ");
      return {
        el,
        functional: FUNCTIONAL_RE.test(forFunctional) || prompt.functionalWords.some((w) => forFunctional.includes(w)),
        nonFunctional: NON_FUNCTIONAL_RE.test(text),
      };
    })
    .filter((h) => h.functional || h.nonFunctional);
}

function scoreRequirements(hits: RequirementHit[]): RubricLine {
  const f = hits.some((h) => h.functional);
  const nf = hits.some((h) => h.nonFunctional);
  const best = [...hits].sort((a, b) => +b.functional + +b.nonFunctional - (+a.functional + +a.nonFunctional))[0];
  if (f && nf) return { key: "requirements", score: 2, reason: "Functional and non-functional requirements written", anchorId: best.el.id };
  if (f) return { key: "requirements", score: 1, reason: "Functional requirements only: no latency, availability or consistency bar", anchorId: best.el.id };
  if (nf) return { key: "requirements", score: 1, reason: "Non-functional bar only: what can users do?", anchorId: best.el.id };
  return { key: "requirements", score: 0, reason: "No requirements note on the board", anchorId: null };
}

// ---------------------------------------------------------------- data model

function scoreDataModel(sorted: JevElement[]): RubricLine {
  const entities = sorted.filter((e) => e.kind === "entity" || e.kind === "class");
  const stores = sorted.filter((e) => DATASTORE_KINDS.has(e.kind));
  const withFields = [
    ...entities.filter((e) => (e.sublabel ?? "").trim().length > 0),
    ...stores.filter((e) => {
      const sub = (e.sublabel ?? "").trim();
      return sub.split("\n").filter(Boolean).length >= 2 || /\b(pk|fk|id)\b/i.test(sub);
    }),
  ];
  const erEdge = sorted.some((e) => e.kind === "arrow" && [e.startEnd, e.endEnd].some((end) => end?.startsWith("er_")));
  if (withFields.length > 0) return { key: "dataModel", score: 2, reason: "Entities with their fields are on the board", anchorId: withFields[0].id };
  if (entities.length > 0 && erEdge) return { key: "dataModel", score: 2, reason: "ER entities with cardinality", anchorId: entities[0].id };
  const named = entities[0] ?? stores[0];
  if (named) return { key: "dataModel", score: 1, reason: "A store is named, but no fields or keys", anchorId: named.id };
  return { key: "dataModel", score: 0, reason: "No entities, tables or data store", anchorId: null };
}

// ---------------------------------------------------------------- bottleneck

function components(sorted: JevElement[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const e of sorted) if (e.kind !== "arrow") adj.set(e.id, new Set());
  for (const a of sorted) {
    if (a.kind !== "arrow" || !a.fromId || !a.toId || !adj.has(a.fromId) || !adj.has(a.toId)) continue;
    adj.get(a.fromId)!.add(a.toId);
    adj.get(a.toId)!.add(a.fromId);
  }
  return adj;
}

function reach(adj: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const next of adj.get(stack.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

interface BottleneckLine extends RubricLine {
  busiestStoreId: string | null;
}

function scoreBottleneck(sorted: JevElement[], prompt: PracticePrompt): BottleneckLine {
  const adj = components(sorted);
  const byId = new Map(sorted.map((e) => [e.id, e]));
  const parts = sorted.filter(isComponent);
  const isSpecific = (e: JevElement) =>
    prompt.bottleneck.kinds.includes(e.kind as never) || prompt.bottleneck.words.some((w) => textOf(e).includes(w));
  const isGeneric = (e: JevElement) => GENERIC_FIX_KINDS.has(e.kind) || GENERIC_FIX_WORDS.test(textOf(e));
  const onHotPath = (e: JevElement) => {
    if ((adj.get(e.id)?.size ?? 0) === 0) return false;
    return [...reach(adj, e.id)].some((id) => {
      if (id === e.id) return false;
      const other = byId.get(id);
      return !!other && (DATASTORE_KINDS.has(other.kind) || ENTRY_KINDS.has(other.kind) || ENTRY_WORDS.test(textOf(other)));
    });
  };
  const stores = parts.filter((e) => DATASTORE_KINDS.has(e.kind));
  const busiestStoreId =
    [...stores].sort((a, b) => (adj.get(b.id)?.size ?? 0) - (adj.get(a.id)?.size ?? 0))[0]?.id ?? null;

  const specific = parts.filter(isSpecific);
  const wired = specific.find(onHotPath);
  if (wired) {
    return { key: "bottleneck", score: 2, reason: `${wired.label || wired.kind} sits on the hot path`, anchorId: wired.id, busiestStoreId };
  }
  if (specific.length > 0) {
    return { key: "bottleneck", score: 1, reason: `${specific[0].label || specific[0].kind} is drawn but not wired into the hot path`, anchorId: specific[0].id, busiestStoreId };
  }
  const generic = parts.filter(isGeneric).find(onHotPath);
  if (generic) {
    return { key: "bottleneck", score: 1, reason: `${generic.label || generic.kind} helps, but not where ${prompt.title.toLowerCase()} breaks first`, anchorId: generic.id, busiestStoreId };
  }
  return { key: "bottleneck", score: 0, reason: "No cache, queue, replica or partition on the hot path", anchorId: busiestStoreId, busiestStoreId };
}

// ---------------------------------------------------------------- trade-offs

function scoreTradeoffs(sorted: JevElement[], requirementIds: Set<string>): RubricLine {
  const phrased = sorted.filter((e) => TRADEOFF_PHRASE_RE.test(textOf(e)));
  const notes = sorted.filter((e) => !requirementIds.has(e.id));
  const full = phrased.find((e) => QUALITY_RE.test(textOf(e)));
  if (full) return { key: "tradeoffs", score: 2, reason: "A choice is named with what it costs", anchorId: full.id };
  if (phrased.length >= 2) return { key: "tradeoffs", score: 2, reason: "Several choices compared", anchorId: phrased[0].id };
  const partial = phrased[0] ?? notes.find((e) => QUALITY_RE.test(textOf(e)));
  if (partial) return { key: "tradeoffs", score: 1, reason: "A choice or a quality is named, but not what it costs", anchorId: partial.id };
  return { key: "tradeoffs", score: 0, reason: "No trade-off written down", anchorId: null };
}

// ---------------------------------------------------------------- comments

function commentFor(line: RubricLine, prompt: PracticePrompt, bottleneck: BottleneckLine): ReviewComment | null {
  if (line.score === 2) return null;
  const id = `c-${line.key}`;
  const base = { id, rubric: line.key };
  switch (line.key) {
    case "requirements":
      if (line.score === 0) {
        return { ...base, anchorId: null, text: `No requirements on the board: write what users do (${prompt.functional[0].toLowerCase()}) and the bar to hit (${prompt.nonFunctional[0].toLowerCase()}).` };
      }
      return line.reason.startsWith("Functional")
        ? { ...base, anchorId: line.anchorId, text: `Add the non-functional bar here: ${prompt.nonFunctional[0].toLowerCase()}, ${prompt.nonFunctional[1].toLowerCase()}.` }
        : { ...base, anchorId: line.anchorId, text: `Add what users can do here: ${prompt.functional[0].toLowerCase()}, ${prompt.functional[1].toLowerCase()}.` };
    case "numbers":
      return line.score === 0
        ? { ...base, anchorId: null, text: "No numbers on the board: write DAU and QPS, then storage and latency." }
        : { ...base, anchorId: line.anchorId, text: `${line.reason}.` };
    case "dataModel":
      return line.score === 0
        ? { ...base, anchorId: null, text: `No data model yet: sketch ${prompt.dataModelHint}.` }
        : { ...base, anchorId: line.anchorId, text: `Which fields does this hold? Sketch ${prompt.dataModelHint}.` };
    case "bottleneck":
      if (line.score === 1 && line.reason.includes("not wired")) {
        return { ...base, anchorId: line.anchorId, text: "This is not wired in yet. Draw the hot path through it." };
      }
      if (line.score === 1) return { ...base, anchorId: line.anchorId, text: `${line.reason}. ${prompt.bottleneck.question}` };
      return bottleneck.busiestStoreId
        ? { ...base, anchorId: bottleneck.busiestStoreId, text: prompt.bottleneck.question }
        : { ...base, anchorId: null, text: "No hot path yet: connect client, service and data store, then say what breaks first." };
    case "tradeoffs":
      return line.score === 0
        ? { ...base, anchorId: null, text: `No trade-offs written down: name one choice and what it costs, e.g. ${prompt.tradeoffHint}.` }
        : { ...base, anchorId: line.anchorId, text: `Say what this choice costs, e.g. ${prompt.tradeoffHint}.` };
  }
}

export function reviewPracticeBoard(elements: JevElement[], prompt: PracticePrompt): PracticeReview {
  const sorted = sortForReview(elements);
  const reqHits = requirementHits(sorted, prompt);
  const bottleneck = scoreBottleneck(sorted, prompt);
  const lines: RubricLine[] = [
    scoreRequirements(reqHits),
    scoreNumbers(sorted, prompt),
    scoreDataModel(sorted),
    { key: bottleneck.key, score: bottleneck.score, reason: bottleneck.reason, anchorId: bottleneck.anchorId },
    scoreTradeoffs(sorted, new Set(reqHits.map((h) => h.el.id))),
  ];

  const comments = lines.map((l) => commentFor(l, prompt, bottleneck)).filter((c): c is ReviewComment => c !== null);
  const followUpAnchor = bottleneck.score === 2 ? bottleneck.anchorId : bottleneck.busiestStoreId;
  const extras: ReviewComment[] = [
    { id: "c-follow-up", rubric: null, anchorId: followUpAnchor, text: prompt.followUp },
    { id: "c-write-path", rubric: null, anchorId: null, text: "Walk the write path end to end and mark where it can fail." },
  ];
  for (const extra of extras) if (comments.length < MIN_COMMENTS) comments.push(extra);

  return {
    promptId: prompt.id,
    total: lines.reduce((sum, l) => sum + l.score, 0),
    max: 10,
    lines,
    comments: comments.slice(0, MAX_COMMENTS),
    source: "rules",
  };
}

export interface AiReviewComment {
  anchorId: string | null;
  text: string;
}

/** AI comments replace the rule comments only; the rubric and total stay the deterministic ones. */
export function mergeAiComments(review: PracticeReview, ai: unknown, elements: JevElement[]): PracticeReview | null {
  if (!Array.isArray(ai)) return null;
  const pinnable = new Set(elements.filter((e) => e.kind !== "arrow" && e.kind !== "freedraw").map((e) => e.id));
  const usable = ai
    .filter((c): c is AiReviewComment => !!c && typeof c.text === "string" && (c.anchorId === null || typeof c.anchorId === "string"))
    .map((c) => ({ anchorId: c.anchorId, text: c.text.trim() }))
    .filter((c) => c.text.length > 0 && (c.anchorId === null || pinnable.has(c.anchorId)))
    .slice(0, MAX_COMMENTS);
  if (usable.length < MIN_COMMENTS) return null;
  return {
    ...review,
    source: "ai",
    comments: usable.map((c, i) => ({
      id: `ai-${i}`,
      rubric: null,
      anchorId: c.anchorId,
      text: c.text.length > MAX_COMMENT_CHARS ? `${c.text.slice(0, MAX_COMMENT_CHARS - 1)}…` : c.text,
    })),
  };
}
