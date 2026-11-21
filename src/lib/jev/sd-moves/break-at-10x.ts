import { buildHldGraph, neighbours, type MoveGraph, type MoveNode } from "./board";
import type { JevElement } from "../types";

export type BreakRule = "hot-key" | "single-db" | "sync-fan-out" | "third-party" | "no-lb" | "one-consumer" | "no-consumer";

export interface BreakFinding {
  rule: BreakRule;
  culpritId: string;
  headline: string;
  why: string;
  fixes: string[];
  score: number;
}

export interface BreakResult {
  status: "found" | "clean" | "empty";
  findings: BreakFinding[];
  /** What the rule set looked for, so a clean result can say so. */
  checked: string[];
}

export const BREAK_CHECKS = [
  "one database on every read/write path",
  "synchronous fan-out",
  "third party on the request path",
  "no load balancer in front of a service",
  "queue consumers",
  "hot keys and global counters",
];

const HOT_RE =
  /\b(global|single)\s+(counter|lock|sequence|key)\b|\bauto[- ]?increment\b|\bcelebrit(?:y|ies)\b|\bhot\s?(?:key|partition|shard|row)s?\b|\bleaderboard\b|\bid\s?generator\b|\bticket\s?counter\b/i;
const SHARDED_RE = /\b(shard|shards|sharded|partition|partitioned|cluster)\b/i;
const DLQ_RE = /\b(dlq|dead[- ]letter)\b/i;

const isCaller = (n: MoveNode) => n.role === "service" || n.role === "client" || n.role === "lb";

function hotKey(g: MoveGraph): BreakFinding[] {
  const out: BreakFinding[] = [];
  for (const n of g.nodes.values()) {
    if (!HOT_RE.test(n.label)) continue;
    const idGen = /\b(id\s?generator|auto[- ]?increment|sequence)\b/i.test(n.label);
    out.push({
      rule: "hot-key",
      culpritId: n.id,
      headline: `${n.label}: one hot key takes every write`,
      why: "One key lives on one partition, so 10× writes queue behind a single lock or shard.",
      fixes: idGen
        ? ["Hand out ID ranges per server, or use Snowflake-style IDs", "Drop the global sequence from the write path"]
        : ["Shard the key into N sub-counters and sum on read", "Batch increments in memory and flush every second"],
      score: 90,
    });
  }
  for (const e of g.edges) {
    if (!HOT_RE.test(e.label) || out.some((f) => f.culpritId === e.to)) continue;
    const target = g.nodes.get(e.to)!;
    out.push({
      rule: "hot-key",
      culpritId: target.id,
      headline: `${target.label}: "${e.label}" funnels writes to one key`,
      why: "One key lives on one partition, so 10× writes queue behind a single lock or shard.",
      fixes: ["Shard the key into N sub-counters and sum on read", "Batch increments in memory and flush every second"],
      score: 88,
    });
  }
  return out;
}

function singleDb(g: MoveGraph): BreakFinding[] {
  const out: BreakFinding[] = [];
  for (const db of g.nodes.values()) {
    if (db.role !== "db") continue;
    const callers = neighbours(g, db.id).filter(isCaller);
    if (callers.length === 0) continue;
    const near = [db, ...callers].flatMap((n) => neighbours(g, n.id));
    const hasCache = near.some((n) => n.role === "cache");
    const hasReplica = SHARDED_RE.test(db.label) || neighbours(g, db.id).some((n) => n.role === "replica");
    if (hasCache && hasReplica) continue;
    if (!hasCache && !hasReplica) {
      out.push({
        rule: "single-db",
        culpritId: db.id,
        headline: `${db.label} takes every read and write`,
        why: "One primary: at 10× its connections and IOPS run out before anything else does.",
        fixes: [
          "Put a read-through cache (Redis) in front of hot reads",
          "Add read replicas and send reads there",
          "Shard by a key (user_id, order_id) once writes outgrow one primary",
        ],
        score: 80 + callers.length,
      });
    } else if (hasCache) {
      out.push({
        rule: "single-db",
        culpritId: db.id,
        headline: `${db.label}: every write still lands on one primary`,
        why: "The cache absorbs reads, not writes; at 10× writes one primary is the ceiling.",
        fixes: ["Shard writes by a key (user_id, order_id)", "Queue non-urgent writes and apply them in batches"],
        score: 55 + callers.length,
      });
    } else {
      out.push({
        rule: "single-db",
        culpritId: db.id,
        headline: `${db.label}: hot reads still hit the database`,
        why: "Replicas lag and each one still pays full query cost for the same hot rows.",
        fixes: ["Add a read-through cache for hot keys", "Cache whole responses at the edge where they are public"],
        score: 50 + callers.length,
      });
    }
  }
  return out;
}

function syncFanOut(g: MoveGraph): BreakFinding[] {
  const out: BreakFinding[] = [];
  for (const n of g.nodes.values()) {
    if (n.role !== "service" && n.role !== "lb") continue;
    const targets = new Map<string, MoveNode>();
    for (const e of g.out(n.id)) {
      const t = g.nodes.get(e.to)!;
      if (!e.async && (t.role === "service" || t.role === "external")) targets.set(t.id, t);
    }
    if (targets.size < 3) continue;
    const names = [...targets.values()].map((t) => t.label);
    out.push({
      rule: "sync-fan-out",
      culpritId: n.id,
      headline: `${n.label} calls ${targets.size} services synchronously per request`,
      why: "Latency is the slowest of them, and any one failing fails the request.",
      fixes: [
        `Move non-critical calls (${names.slice(-2).join(", ")}) behind a queue`,
        "Call the rest in parallel, each with a timeout and a fallback",
        "Precompute or cache the aggregate",
      ],
      score: 70 + targets.size,
    });
  }
  return out;
}

/** Nodes a client can reach over synchronous arrows; every node when the board has no client. */
function requestPath(g: MoveGraph): Set<string> {
  const clients = [...g.nodes.values()].filter((n) => n.role === "client");
  if (clients.length === 0) return new Set(g.nodes.keys());
  const seen = new Set(clients.map((c) => c.id));
  const stack = [...seen];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of g.out(id)) {
      if (e.async || seen.has(e.to)) continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  return seen;
}

function thirdParty(g: MoveGraph): BreakFinding[] {
  const path = requestPath(g);
  const out: BreakFinding[] = [];
  for (const n of g.nodes.values()) {
    if (n.role !== "external") continue;
    const caller = g.in(n.id).find((e) => !e.async && path.has(e.from) && g.nodes.get(e.from)!.role !== "client");
    if (!caller) continue;
    out.push({
      rule: "third-party",
      culpritId: n.id,
      headline: `${n.label} is on the request path`,
      why: "Its p99, rate limits and outages become yours, and 10× traffic hits their quota.",
      fixes: [
        "Call it async: enqueue, return 202, confirm by webhook",
        "Timeout + retry with an idempotency key behind a circuit breaker",
      ],
      score: 65,
    });
  }
  return out;
}

function noLb(g: MoveGraph): BreakFinding[] {
  if ([...g.nodes.values()].some((n) => n.role === "lb")) return [];
  const out: BreakFinding[] = [];
  for (const n of g.nodes.values()) {
    if (n.role !== "service") continue;
    if (!g.in(n.id).some((e) => g.nodes.get(e.from)!.role === "client")) continue;
    out.push({
      rule: "no-lb",
      culpritId: n.id,
      headline: `${n.label} is one instance with no load balancer in front`,
      why: "One box caps throughput and is a single point of failure.",
      fixes: [
        "Put a load balancer in front and run 2+ stateless replicas",
        "Autoscale on CPU or QPS; keep sessions out of process memory",
      ],
      score: 60,
    });
  }
  return out;
}

function queues(g: MoveGraph): BreakFinding[] {
  const out: BreakFinding[] = [];
  for (const q of g.nodes.values()) {
    if (q.role !== "queue" || DLQ_RE.test(q.label)) continue;
    const consumers = new Set(g.out(q.id).map((e) => e.to));
    if (consumers.size === 0 && g.in(q.id).length > 0) {
      out.push({
        rule: "no-consumer",
        culpritId: q.id,
        headline: `Nothing consumes ${q.label}`,
        why: "Producers keep writing; the backlog grows until retention drops messages.",
        fixes: ["Draw the consumer that drains it", "Alert on queue depth and consumer lag"],
        score: 40,
      });
    } else if (consumers.size === 1) {
      out.push({
        rule: "one-consumer",
        culpritId: q.id,
        headline: `${q.label} has a single consumer`,
        why: "At 10× producers one worker falls behind and the backlog grows without bound.",
        fixes: [
          "Partition it and run a consumer group; scale workers on lag",
          "Add a DLQ and backpressure, and alert on queue depth",
        ],
        score: 45,
      });
    }
  }
  return out;
}

export function findBreakAt10x(elements: JevElement[]): BreakResult {
  const g = buildHldGraph(elements);
  if (g.nodes.size < 2 || g.edges.length === 0) return { status: "empty", findings: [], checked: BREAK_CHECKS };
  const all = [...hotKey(g), ...singleDb(g), ...syncFanOut(g), ...thirdParty(g), ...noLb(g), ...queues(g)];
  const findings = all.sort((a, b) => b.score - a.score);
  return { status: findings.length > 0 ? "found" : "clean", findings, checked: BREAK_CHECKS };
}
