import {
  baseNodesAndEdges,
  deriveDomainSubject,
  extractSelectedSubgraph,
  materializeForkTake,
  type ForkGenerationResult,
  type ForkTakeSpec,
  type SelectedSubgraph,
} from "./fork-engine";
import {
  targetPerSecond,
  type ForkConstraint,
  type ForkCostLine,
  type ForkPatternId,
  type ForkPressure,
  type ForkTarget,
} from "./fork-constraint";
import type { SemanticEdge, SemanticGraph, SemanticGroup, SemanticNode } from "./semantic-graph";
import type { JevElement } from "./types";

interface PatternContext {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  entry: SemanticNode;
  store: SemanticNode;
  storeEdgeIdx: number;
  domain: string | null;
  focus: string;
}

interface PatternDrawing {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  groups?: SemanticGroup[];
  groupsAsZones?: boolean;
}

type ConsistencyLevel = NonNullable<ForkTarget["level"]>;

export interface ForkPattern {
  id: ForkPatternId;
  title: string;
  tag: string;
  serves: Partial<Record<ForkPressure, 1 | 2 | 3>>;
  /** Typical gain, stated as a range. */
  buys: string;
  costs: ForkCostLine[];
  failureMode: string;
  /** Upper end of the typical fast-path latency, used to judge a latency target. */
  fastPathMs?: number;
  /** Typical monthly cost range in USD, used to judge a budget. */
  monthlyUsd?: [number, number];
  /** Typical availability this pattern reaches, used to judge an uptime target. */
  availabilityPct?: number;
  consistency?: ConsistencyLevel;
  fit?: (c: ForkConstraint) => number;
  rationale: (ctx: PatternContext) => string;
  draw: (ctx: PatternContext) => PatternDrawing;
}

function costs(
  latency: [string, 1 | 2 | 3],
  money: [string, 1 | 2 | 3],
  consistency: [string, 1 | 2 | 3],
  complexity: [string, 1 | 2 | 3],
  ops: [string, 1 | 2 | 3]
): ForkCostLine[] {
  return [
    { axis: "latency", text: latency[0], severity: latency[1] },
    { axis: "money", text: money[0], severity: money[1] },
    { axis: "consistency", text: consistency[0], severity: consistency[1] },
    { axis: "complexity", text: complexity[0], severity: complexity[1] },
    { axis: "ops", text: ops[0], severity: ops[1] },
  ];
}

function named(ctx: PatternContext, role: string): string {
  return ctx.domain ? `${ctx.domain} ${role}` : role;
}

/** The original edges with the entry→store hop replaced by `replacement` (appended when there was no such hop). */
function withStoreHop(ctx: PatternContext, replacement: SemanticEdge[]): SemanticEdge[] {
  if (ctx.storeEdgeIdx < 0) return [...ctx.edges, ...replacement];
  return ctx.edges.flatMap((e, idx) => (idx === ctx.storeEdgeIdx ? replacement : [e]));
}

function writesHeavy(c: ForkConstraint): boolean {
  return c.target?.metric === "writes";
}

function readsHeavy(c: ForkConstraint): boolean {
  return c.target?.metric === "reads";
}

export const FORK_PATTERN_CATALOGUE: ForkPattern[] = [
  {
    id: "cache_aside",
    title: "Cache-aside / read-through",
    tag: "Stale reads",
    serves: { latency: 3, scale: 2, cost: 1 },
    buys: "p99 read ≈ 5-20 ms on cache hit vs 50-150 ms from the DB (typical)",
    fastPathMs: 20,
    consistency: "eventual",
    costs: costs(
      ["Misses add a hop (~1 ms)", 1],
      ["Cache ≈ $50-500/mo", 1],
      ["Stale until TTL or invalidation", 2],
      ["Invalidate on every write", 2],
      ["Sizing, eviction, warm-up", 2]
    ),
    failureMode: "Cache stampede: hot keys expire together and every miss hits the DB at once.",
    fit: (c) => (c.target?.value !== undefined && c.target.unit === "ms" && c.target.value <= 50 ? 0.5 : 0),
    rationale: (ctx) => `Serves hot ${ctx.focus} reads from a cache; misses read ${ctx.store.label} and fill it.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_cache", label: named(ctx, "Cache"), sublabel: "Redis · TTL", kind: "cache", tone: "teal" },
      ],
      edges: withStoreHop(ctx, [
        { from: ctx.entry.id, to: "fk_cache", label: "get", kind: "sync" },
        { from: ctx.entry.id, to: ctx.store.id, label: "miss: read + set", dashed: true, kind: "fallback" },
      ]),
    }),
  },
  {
    id: "cdn_edge",
    title: "CDN edge cache",
    tag: "Purge lag",
    serves: { latency: 3, cost: 2, scale: 2, availability: 1 },
    buys: "edge hit ≈ 10-40 ms vs 100-300 ms to a far origin (typical)",
    fastPathMs: 40,
    consistency: "eventual",
    costs: costs(
      ["Misses still go to origin", 1],
      ["Egress ≈ $0.02-0.09/GB", 1],
      ["Stale until purge or max-age", 2],
      ["Cache keys, headers, purges", 2],
      ["Edge config rollouts", 1]
    ),
    failureMode: "A wrong cache key serves one user's private response to others, or a mass purge floods the origin.",
    rationale: (ctx) => `Answers cacheable ${ctx.focus} responses and assets at the edge, close to users.`,
    draw: (ctx) => ({
      nodes: [
        { id: "fk_cdn", label: "CDN Edge", sublabel: "CloudFront / Fastly", kind: "lb", tone: "cobalt", layer: 0 },
        ...ctx.nodes,
        { id: "fk_assets", label: named(ctx, "Assets"), sublabel: "S3 origin", kind: "blob", tone: "ochre" },
      ],
      edges: [
        { from: "fk_cdn", to: ctx.entry.id, label: "miss: origin", kind: "flow" },
        { from: "fk_cdn", to: "fk_assets", label: "static + media", dashed: true, kind: "sync" },
        ...ctx.edges,
      ],
    }),
  },
  {
    id: "read_replicas",
    title: "Read replicas",
    tag: "Replica lag",
    serves: { latency: 3, scale: 2, availability: 1 },
    buys: "p99 read ≈ 10-50 ms once the primary is not saturated (typical)",
    fastPathMs: 50,
    consistency: "eventual",
    costs: costs(
      ["Reads one hop; writes unchanged", 1],
      ["Each replica ≈ one DB instance", 2],
      ["Lag: may miss own writes", 2],
      ["Route reads vs writes", 2],
      ["Watch lag; promote on failover", 2]
    ),
    failureMode: "Replica lag spikes under write load and users read stale data right after they write.",
    rationale: (ctx) => `Sends ${ctx.focus} reads to a replica of ${ctx.store.label}; writes stay on the primary.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_replica", label: `${ctx.store.label} Replica`, sublabel: "async, read-only", kind: "database", tone: "teal" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: ctx.store.id, label: "writes", kind: "sync" },
          { from: ctx.entry.id, to: "fk_replica", label: "reads", kind: "flow" },
        ]),
        { from: ctx.store.id, to: "fk_replica", label: "replicate", dashed: true, kind: "async" },
      ],
    }),
  },
  {
    id: "fanout_on_write",
    title: "Precompute: fan-out on write",
    tag: "Write amplification",
    serves: { latency: 3, scale: 3 },
    buys: "a read is one key lookup ≈ 1-10 ms; work moves to writes (typical)",
    fastPathMs: 10,
    consistency: "eventual",
    costs: costs(
      ["Writes propagate in seconds", 2],
      ["Storage × fan-out", 3],
      ["Readers see new items late", 2],
      ["Hybrid path for huge accounts", 3],
      ["Backfills, fan-out backlog", 2]
    ),
    failureMode: "One write from a huge account fans out to millions of rows and the queue backs up for minutes.",
    fit: (c) => (readsHeavy(c) ? 0.35 : c.target?.unit === "ms" && (c.target.value ?? 999) <= 30 ? 0.25 : 0),
    rationale: (ctx) => `Precomputes ${ctx.focus} results when data is written, so reads are a single lookup.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_fan_q", label: "Fan-out Queue", sublabel: "Kafka topic", kind: "queue", tone: "ochre" },
        { id: "fk_fan_w", label: named(ctx, "Fan-out Worker"), sublabel: "writes per reader", kind: "node", tone: "cobalt" },
        { id: "fk_feed", label: "Precomputed Views", sublabel: "Redis, one key per reader", kind: "cache", tone: "teal" },
      ],
      edges: [
        ...ctx.edges,
        { from: ctx.entry.id, to: "fk_fan_q", label: "on write", dashed: true, kind: "async" },
        { from: "fk_fan_q", to: "fk_fan_w", label: "consume", kind: "async" },
        { from: "fk_fan_w", to: "fk_feed", label: "push", kind: "sync" },
        { from: ctx.entry.id, to: "fk_feed", label: "read: 1 lookup", kind: "flow" },
      ],
    }),
  },
  {
    id: "regional_deploy",
    title: "Regional deploys",
    tag: "Cross-region writes",
    serves: { latency: 3, availability: 2 },
    buys: "RTT ≈ 20-60 ms in-region vs 150-300 ms cross-ocean (typical)",
    fastPathMs: 60,
    consistency: "eventual",
    costs: costs(
      ["Cross-region writes 70-150 ms", 2],
      ["≈ 2x infrastructure", 3],
      ["Lag between regions", 3],
      ["Residency, write conflicts", 3],
      ["Two regions to run", 3]
    ),
    failureMode: "Split brain: both regions take writes during a partition and disagree afterwards.",
    rationale: (ctx) => `Runs ${ctx.focus} in two regions behind geo DNS; each region reads locally.`,
    draw: (ctx) => ({
      nodes: [
        { id: "fk_gslb", label: "Geo DNS", sublabel: "latency-based routing", kind: "lb", tone: "cobalt", layer: 0 },
        ...ctx.nodes,
        { id: "fk_entry_b", label: ctx.entry.label, sublabel: "eu-west", kind: ctx.entry.kind, tone: ctx.entry.tone },
        { id: "fk_store_b", label: `${ctx.store.label} (eu)`, sublabel: "regional replica", kind: "database", tone: "teal" },
      ],
      edges: [
        { from: "fk_gslb", to: ctx.entry.id, label: "nearest", kind: "flow" },
        { from: "fk_gslb", to: "fk_entry_b", label: "nearest", kind: "flow" },
        ...ctx.edges,
        { from: "fk_entry_b", to: "fk_store_b", label: "local reads", kind: "sync" },
        { from: ctx.store.id, to: "fk_store_b", label: "async replicate", dashed: true, kind: "async" },
      ],
      groups: [
        { id: "grp_region_a", label: "Region us-east", nodeIds: [ctx.entry.id, ctx.store.id], tone: "slate" },
        { id: "grp_region_b", label: "Region eu-west", nodeIds: ["fk_entry_b", "fk_store_b"], tone: "slate" },
      ],
      groupsAsZones: true,
    }),
  },
  {
    id: "sharding",
    title: "Shard / partition the data",
    tag: "Hot shards",
    serves: { scale: 3, latency: 1 },
    buys: "≈ 5-10k writes/s per Postgres primary, times N shards (typical)",
    consistency: "strong",
    costs: costs(
      ["Cross-shard reads are slow", 1],
      ["One DB per shard", 2],
      ["No cross-shard tx or joins", 3],
      ["Shard key is hard to change", 3],
      ["Rebalancing, hot shards", 3]
    ),
    failureMode: "A hot key (one huge tenant) overloads a single shard while the others sit idle.",
    fit: (c) => {
      const perSec = c.target ? targetPerSecond(c.target) : null;
      return (writesHeavy(c) ? 0.5 : 0) + (perSec !== null && perSec > 10_000 ? 0.2 : 0);
    },
    rationale: (ctx) => `Splits ${ctx.store.label} by key so each shard carries a slice of ${ctx.focus} traffic.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes.map((n) => (n.id === ctx.store.id ? { ...n, sublabel: "shard 1" } : n)),
        { id: "fk_router", label: named(ctx, "Shard Router"), sublabel: "hash(key) mod N", kind: "node", tone: "plum" },
        { id: "fk_shard_2", label: `${ctx.store.label}`, sublabel: "shard 2", kind: "database", tone: "teal" },
        { id: "fk_shard_n", label: `${ctx.store.label}`, sublabel: "shard N", kind: "database", tone: "teal" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: "fk_router", label: "by key", kind: "flow" },
          { from: "fk_router", to: ctx.store.id, label: "keys 0..k", kind: "sync" },
        ]),
        { from: "fk_router", to: "fk_shard_2", label: "keys k..2k", kind: "sync" },
        { from: "fk_router", to: "fk_shard_n", label: "…", kind: "sync" },
      ],
    }),
  },
  {
    id: "queue_workers",
    title: "Queue + worker pool",
    tag: "Eventual consistency",
    serves: { scale: 3, availability: 2, cost: 1 },
    buys: "ack in ≈ 5-20 ms; drain ≈ 1-10k msgs/s per partition (typical)",
    fastPathMs: 20,
    consistency: "eventual",
    costs: costs(
      ["Work lands seconds later", 2],
      ["Broker + worker fleet", 1],
      ["At-least-once, eventual", 2],
      ["Idempotency, ordering", 2],
      ["Lag, DLQ triage", 2]
    ),
    failureMode: "Consumer lag grows unnoticed until the backlog is hours old; a poison message retries forever.",
    rationale: (ctx) => `Puts a queue in front of ${ctx.store.label} so ${ctx.focus} bursts drain at a steady rate.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_q", label: named(ctx, "Queue"), sublabel: "SQS / Kafka", kind: "queue", tone: "ochre" },
        { id: "fk_workers", label: named(ctx, "Workers"), sublabel: "autoscaled pool", kind: "node", tone: "cobalt" },
        { id: "fk_dlq", label: "Dead-letter Queue", sublabel: "after N retries", kind: "queue", tone: "terracotta" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: "fk_q", label: "enqueue", dashed: true, kind: "async" },
          { from: "fk_q", to: "fk_workers", label: "consume", kind: "async" },
          { from: "fk_workers", to: ctx.store.id, label: "write", kind: "sync" },
        ]),
        { from: "fk_workers", to: "fk_dlq", label: "failed", dashed: true, kind: "fallback" },
      ],
    }),
  },
  {
    id: "fanout_on_read",
    title: "Fan-out on read",
    tag: "Slow wide reads",
    serves: { scale: 3, consistency: 1 },
    buys: "writes stay O(1); reads merge 100-1,000 sources in ≈ 50-200 ms (typical)",
    fastPathMs: 200,
    consistency: "read-your-writes",
    costs: costs(
      ["Reads do the work: higher p99", 2],
      ["Read CPU grows with fan-in", 2],
      ["Fresh: reads see latest", 1],
      ["Merge + pagination logic", 2],
      ["Hot spots on popular sources", 2]
    ),
    failureMode: "Readers who follow thousands of sources turn every read into a slow scatter-gather.",
    fit: (c) => (writesHeavy(c) ? 0.2 : 0),
    rationale: (ctx) => `Keeps ${ctx.focus} writes cheap and merges per-source data at read time.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_agg", label: named(ctx, "Aggregator"), sublabel: "k-way merge at read", kind: "node", tone: "plum" },
        { id: "fk_hot", label: "Hot Source Cache", sublabel: "recent items per source", kind: "cache", tone: "teal" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: ctx.store.id, label: "write once", kind: "sync" },
          { from: ctx.entry.id, to: "fk_agg", label: "read", kind: "flow" },
          { from: "fk_agg", to: ctx.store.id, label: "per-source scan", dashed: true, kind: "sync" },
        ]),
        { from: "fk_agg", to: "fk_hot", label: "merge", kind: "sync" },
      ],
    }),
  },
  {
    id: "single_leader_sync",
    title: "Single leader + sync replica",
    tag: "Slower commits",
    serves: { consistency: 3, availability: 2 },
    buys: "linearizable writes, zero loss on failover; +1-5 ms per commit (typical)",
    consistency: "strong",
    availabilityPct: 99.95,
    costs: costs(
      ["Commit waits for replica (+1-5 ms)", 2],
      ["Extra replica instance", 2],
      ["Strong: leader reads current", 1],
      ["Writes go to the leader only", 1],
      ["Replica outage stalls writes", 2]
    ),
    failureMode: "When the sync replica is slow or down, every write stalls, or the DB quietly drops to async.",
    fit: (c) => (c.target?.level === "strong" ? 0.3 : 0),
    rationale: (ctx) => `All ${ctx.focus} writes go to one leader that waits for a synchronous replica.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes.map((n) => (n.id === ctx.store.id ? { ...n, sublabel: "leader" } : n)),
        { id: "fk_sync", label: `${ctx.store.label} Sync Replica`, sublabel: "commit waits, other AZ", kind: "database", tone: "teal" },
        { id: "fk_async", label: `${ctx.store.label} Read Replica`, sublabel: "async", kind: "database", tone: "slate" },
      ],
      edges: [
        ...withStoreHop(ctx, [{ from: ctx.entry.id, to: ctx.store.id, label: "all writes", kind: "sync" }]),
        { from: ctx.store.id, to: "fk_sync", label: "sync replicate", kind: "sync" },
        { from: ctx.store.id, to: "fk_async", label: "async", dashed: true, kind: "async" },
      ],
    }),
  },
  {
    id: "outbox_cdc",
    title: "Transactional outbox + CDC",
    tag: "Connector lag",
    serves: { consistency: 3, scale: 1 },
    buys: "event published iff its row commits; consumers see it ≈ 0.1-1 s later (typical)",
    consistency: "strong",
    costs: costs(
      ["Consumers lag 0.1 s to seconds", 2],
      ["Kafka + Debezium cluster", 2],
      ["Atomic row+event; eventual reads", 1],
      ["Event schemas, dedupe", 2],
      ["Connector offsets, WAL size", 3]
    ),
    failureMode: "The CDC connector stalls, the WAL grows until the DB disk fills, and events arrive hours late.",
    fit: (c) => (c.target?.level === "eventual" ? 0.3 : 0),
    rationale: (ctx) => `Writes ${ctx.focus} rows and their events in one transaction; CDC publishes the outbox.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_outbox", label: "Outbox Table", sublabel: "same transaction", kind: "database", tone: "slate" },
        { id: "fk_cdc", label: "CDC Relay", sublabel: "Debezium tails WAL", kind: "node", tone: "plum" },
        { id: "fk_topic", label: named(ctx, "Events"), sublabel: "Kafka topic", kind: "queue", tone: "ochre" },
      ],
      edges: [
        ...withStoreHop(ctx, [{ from: ctx.entry.id, to: ctx.store.id, label: "tx: row", kind: "sync" }]),
        { from: ctx.entry.id, to: "fk_outbox", label: "tx: event", kind: "sync" },
        { from: "fk_outbox", to: "fk_cdc", label: "tail", dashed: true, kind: "async" },
        { from: "fk_cdc", to: "fk_topic", label: "publish", kind: "async" },
      ],
    }),
  },
  {
    id: "idempotency_saga",
    title: "Idempotency keys + saga",
    tag: "Compensations",
    serves: { consistency: 3, availability: 1 },
    buys: "retries never apply twice; each step commits in ≈ 10-50 ms (typical)",
    consistency: "eventual",
    costs: costs(
      ["Key check + orchestration hops", 1],
      ["Small: one key table", 1],
      ["Eventual across steps", 2],
      ["Every step needs an undo", 3],
      ["Tooling for stuck sagas", 2]
    ),
    failureMode: "A compensation fails halfway and leaves the customer charged for a cancelled order.",
    rationale: (ctx) => `Dedupes ${ctx.focus} requests by key and runs multi-step work as a saga with undo steps.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_idem", label: "Idempotency Keys", sublabel: "key → result, 24 h", kind: "database", tone: "slate" },
        { id: "fk_saga", label: named(ctx, "Saga"), sublabel: "steps + compensations", kind: "node", tone: "plum" },
        { id: "fk_ext", label: "Payment Provider", sublabel: "Stripe", kind: "external", tone: "terracotta" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: "fk_idem", label: "check key", kind: "sync" },
          { from: ctx.entry.id, to: "fk_saga", label: "start", kind: "flow" },
          { from: "fk_saga", to: ctx.store.id, label: "1: reserve", kind: "sync" },
        ]),
        { from: "fk_saga", to: "fk_ext", label: "2: charge / refund", kind: "sync" },
      ],
    }),
  },
  {
    id: "serverless_batch",
    title: "Serverless + batch",
    tag: "Cold starts",
    serves: { cost: 3, scale: 2 },
    buys: "idle ≈ $0; ≈ $5-50/mo per 1M requests vs $150-400/mo for 2 servers (typical)",
    monthlyUsd: [5, 150],
    consistency: "eventual",
    costs: costs(
      ["Cold starts 0.1-1 s", 2],
      ["Cheapest at low/spiky load", 1],
      ["Batch results lag hours", 2],
      ["Timeouts, stateless code", 2],
      ["Concurrency caps, lock-in", 1]
    ),
    failureMode: "A spike hits the concurrency limit and requests throttle, or steady load makes per-call pricing dearer than servers.",
    rationale: (ctx) => `Runs ${ctx.focus} work as functions that scale to zero, and heavy jobs as a nightly batch.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_jobs", label: "Job Queue", sublabel: "SQS", kind: "queue", tone: "ochre" },
        { id: "fk_fn", label: named(ctx, "Function"), sublabel: "Lambda · scale to zero", kind: "node", tone: "cobalt" },
        { id: "fk_batch", label: "Nightly Batch", sublabel: "scheduled, spot", kind: "node", tone: "slate" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: "fk_jobs", label: "enqueue", dashed: true, kind: "async" },
          { from: "fk_jobs", to: "fk_fn", label: "invoke", kind: "async" },
          { from: "fk_fn", to: ctx.store.id, label: "write", kind: "sync" },
        ]),
        { from: "fk_batch", to: ctx.store.id, label: "bulk job", dashed: true, kind: "async" },
      ],
    }),
  },
  {
    id: "tiered_storage",
    title: "Tiered storage (hot / cold)",
    tag: "Slow cold reads",
    serves: { cost: 3 },
    buys: "cold data ≈ $0.004-0.0125/GB-mo vs $0.10-0.25 on DB SSD (typical)",
    monthlyUsd: [20, 300],
    consistency: "strong",
    costs: costs(
      ["Cold reads 100 ms to hours", 2],
      ["Storage bill ≈ 10-25x lower", 1],
      ["Tier moves are async", 1],
      ["Lifecycle rules, two tiers", 2],
      ["Retrieval fees, restores", 2]
    ),
    failureMode: "A hot path starts reading archived data and pays restore latency and fees on every request.",
    rationale: (ctx) => `Keeps recent ${ctx.focus} data in ${ctx.store.label} and ages the rest into cheap object storage.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes.map((n) => (n.id === ctx.store.id ? { ...n, sublabel: "hot: last 30 days" } : n)),
        { id: "fk_cold", label: named(ctx, "Archive"), sublabel: "S3 IA / Glacier", kind: "blob", tone: "ochre" },
      ],
      edges: [
        ...withStoreHop(ctx, [{ from: ctx.entry.id, to: ctx.store.id, label: "hot reads/writes", kind: "sync" }]),
        { from: ctx.store.id, to: "fk_cold", label: "age out > 30 d", dashed: true, kind: "async" },
        { from: ctx.entry.id, to: "fk_cold", label: "rare reads", dashed: true, kind: "fallback" },
      ],
    }),
  },
  {
    id: "autoscale",
    title: "Autoscale behind a load balancer",
    tag: "Scale-up lag",
    serves: { cost: 3, scale: 2, availability: 1 },
    buys: "pay for average load, not peak: ≈ 30-60% less compute (typical)",
    monthlyUsd: [60, 400],
    consistency: "strong",
    costs: costs(
      ["Scale-out takes 1-5 min", 2],
      ["Saves off-peak; LB ≈ $20/mo", 1],
      ["Needs stateless instances", 1],
      ["Health checks, warm-up", 1],
      ["Threshold tuning, flapping", 2]
    ),
    failureMode: "A sudden spike outruns scale-out and the fleet overloads before new instances pass health checks.",
    rationale: (ctx) => `Runs ${ctx.entry.label} as a fleet that grows and shrinks with load behind a load balancer.`,
    draw: (ctx) => ({
      nodes: [
        { id: "fk_lb", label: "Load Balancer", sublabel: "ALB", kind: "lb", tone: "cobalt", layer: 0 },
        ...ctx.nodes.map((n) => (n.id === ctx.entry.id ? { ...n, sublabel: "min 2 · target CPU 60%" } : n)),
        { id: "fk_asg", label: "Autoscaler", sublabel: "scale on CPU / queue depth", kind: "node", tone: "slate" },
      ],
      edges: [
        { from: "fk_lb", to: ctx.entry.id, label: "route", kind: "flow" },
        { from: "fk_asg", to: ctx.entry.id, label: "scale in/out", dashed: true, kind: "async" },
        ...ctx.edges,
      ],
    }),
  },
  {
    id: "multi_az_lb",
    title: "Multi-AZ behind a load balancer",
    tag: "2x footprint",
    serves: { availability: 3, scale: 1 },
    buys: "survives losing a zone: ≈ 99.95-99.99% vs 99.5-99.9% single-AZ (typical)",
    availabilityPct: 99.99,
    consistency: "strong",
    costs: costs(
      ["Cross-AZ hop ≈ 1-2 ms", 1],
      ["≈ 2x app + standby DB", 2],
      ["Sync standby: no data loss", 1],
      ["App tier must be stateless", 2],
      ["Failover drills, health checks", 2]
    ),
    failureMode: "An untested failover takes minutes, or a bad health check drains both zones at once.",
    fit: (c) => (c.target?.value !== undefined && c.target.unit === "%" && c.target.value >= 99.95 ? 0.2 : 0),
    rationale: (ctx) => `Runs ${ctx.entry.label} in two zones behind a load balancer with a standby ${ctx.store.label}.`,
    draw: (ctx) => ({
      nodes: [
        { id: "fk_lb", label: "Load Balancer", sublabel: "health-checked", kind: "lb", tone: "cobalt", layer: 0 },
        ...ctx.nodes,
        { id: "fk_entry_b", label: ctx.entry.label, sublabel: "replica instance", kind: ctx.entry.kind, tone: ctx.entry.tone },
        { id: "fk_standby", label: `${ctx.store.label} Standby`, sublabel: "sync, auto-failover", kind: "database", tone: "teal" },
      ],
      edges: [
        { from: "fk_lb", to: ctx.entry.id, label: "healthy", kind: "flow" },
        { from: "fk_lb", to: "fk_entry_b", label: "healthy", kind: "flow" },
        ...ctx.edges,
        { from: "fk_entry_b", to: ctx.store.id, label: "writes", kind: "sync" },
        { from: ctx.store.id, to: "fk_standby", label: "sync replicate", dashed: true, kind: "sync" },
      ],
      groups: [
        { id: "grp_az_a", label: "AZ a", nodeIds: [ctx.entry.id, ctx.store.id], tone: "slate" },
        { id: "grp_az_b", label: "AZ b", nodeIds: ["fk_entry_b", "fk_standby"], tone: "slate" },
      ],
      groupsAsZones: true,
    }),
  },
  {
    id: "circuit_breaker_fallback",
    title: "Circuit breaker + fallback",
    tag: "Degraded answers",
    serves: { availability: 3, latency: 1 },
    buys: "fail fast in ≈ 1 ms, not a 10-30 s timeout; degraded, not down (typical)",
    availabilityPct: 99.9,
    consistency: "eventual",
    costs: costs(
      ["Fails fast when open (~1 ms)", 1],
      ["Negligible: a library", 1],
      ["Fallback serves stale data", 2],
      ["Thresholds, half-open probes", 2],
      ["Alert on open breakers", 1]
    ),
    failureMode: "Thresholds set too tight make the breaker flap open on a blip and shed healthy traffic.",
    rationale: (ctx) => `Guards ${ctx.focus} calls to ${ctx.store.label} with a breaker that falls back to the last good answer.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_breaker", label: "Breaker closed?", sublabel: "opens at 50% errors", kind: "diamond", tone: "plum" },
        { id: "fk_fallback", label: "Last-good Cache", sublabel: "stale fallback", kind: "cache", tone: "terracotta" },
      ],
      edges: [
        ...withStoreHop(ctx, [
          { from: ctx.entry.id, to: "fk_breaker", label: "call", kind: "flow" },
          { from: "fk_breaker", to: ctx.store.id, label: "closed", kind: "sync" },
        ]),
        { from: "fk_breaker", to: "fk_fallback", label: "open", dashed: true, kind: "fallback" },
      ],
    }),
  },
  {
    id: "queue_buffering",
    title: "Queue buffering for writes",
    tag: "Async writes",
    serves: { availability: 3, scale: 2 },
    buys: "writes succeed while the DB is down; the queue keeps 1-14 days (typical)",
    availabilityPct: 99.95,
    consistency: "eventual",
    costs: costs(
      ["Writes land seconds later", 2],
      ["Broker ≈ $20-200/mo", 1],
      ["Reads miss queued writes", 2],
      ["Idempotent replay, ordering", 2],
      ["Backlog alarms, replay tools", 2]
    ),
    failureMode: "After a long outage the backlog replays faster than the DB can take and knocks it over again.",
    rationale: (ctx) => `Accepts ${ctx.focus} writes into a durable queue and drains them into ${ctx.store.label} when it is healthy.`,
    draw: (ctx) => ({
      nodes: [
        ...ctx.nodes,
        { id: "fk_buf", label: named(ctx, "Write Buffer"), sublabel: "durable queue", kind: "queue", tone: "ochre" },
        { id: "fk_drain", label: "Drain Worker", sublabel: "retry with backoff", kind: "node", tone: "cobalt" },
      ],
      edges: withStoreHop(ctx, [
        { from: ctx.entry.id, to: "fk_buf", label: "accept + ack", dashed: true, kind: "async" },
        { from: "fk_buf", to: "fk_drain", label: "drain", kind: "async" },
        { from: "fk_drain", to: ctx.store.id, label: "write when healthy", kind: "sync" },
      ]),
    }),
  },
];

const PRESSURE_SHORTLIST: Record<ForkPressure, ForkPatternId[]> = {
  latency: ["cache_aside", "cdn_edge", "read_replicas", "fanout_on_write", "regional_deploy"],
  scale: ["sharding", "queue_workers", "fanout_on_read", "fanout_on_write"],
  consistency: ["single_leader_sync", "outbox_cdc", "idempotency_saga"],
  cost: ["serverless_batch", "tiered_storage", "autoscale"],
  availability: ["multi_az_lb", "circuit_breaker_fallback", "queue_buffering"],
};

const BY_ID = new Map(FORK_PATTERN_CATALOGUE.map((p) => [p.id, p]));

/** The three patterns that best answer the constraint, best first. */
export function rankForkPatterns(constraint: ForkConstraint): ForkPattern[] {
  return PRESSURE_SHORTLIST[constraint.pressure]
    .map((id, idx) => {
      const pattern = BY_ID.get(id)!;
      return { pattern, score: 1 - idx * 0.1 + (pattern.fit?.(constraint) ?? 0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.pattern);
}

const CONSISTENCY_RANK: Record<ConsistencyLevel, number> = {
  eventual: 0,
  causal: 1,
  "read-your-writes": 2,
  strong: 3,
};

function formatRate(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : String(Number(n.toFixed(1)));
}

function formatDowntime(pct: number): string {
  const minutes = ((100 - pct) / 100) * 525_960;
  return minutes < 120 ? `${Number(minutes.toFixed(1))} min` : `${Number((minutes / 60).toFixed(1))} h`;
}

/** How the pattern's typical numbers compare with the stated target, or null without a target. */
function targetVerdict(pattern: ForkPattern, c: ForkConstraint): string | null {
  const t = c.target;
  if (!t) return null;
  if (c.pressure === "latency" && t.value !== undefined) {
    if (pattern.fastPathMs === undefined) return `vs ${t.text}`;
    return pattern.fastPathMs <= t.value ? `fits ${t.text} on hits` : `fast path over ${t.text}`;
  }
  if (c.pressure === "scale") {
    const perSec = targetPerSecond(t);
    if (perSec === null) return `for ${t.text}`;
    return `${t.text} ≈ ${formatRate(perSec)}/s avg, ${formatRate(perSec * 3)}/s peak`;
  }
  if (c.pressure === "cost" && t.value !== undefined) {
    if (!pattern.monthlyUsd) return `vs ${t.text}`;
    const [lo, hi] = pattern.monthlyUsd;
    if (hi <= t.value) return `fits ${t.text}`;
    return lo > t.value ? `likely over ${t.text}` : `can fit ${t.text} at moderate traffic`;
  }
  if (c.pressure === "availability" && t.value !== undefined) {
    const budget = `${t.text} ≈ ${formatDowntime(t.value)} down/yr`;
    if (pattern.availabilityPct === undefined) return budget;
    return `${budget}; ${pattern.availabilityPct >= t.value ? "reachable" : "short alone"}`;
  }
  if (c.pressure === "consistency" && t.level && pattern.consistency) {
    return CONSISTENCY_RANK[pattern.consistency] >= CONSISTENCY_RANK[t.level]
      ? `meets ${t.text}`
      : `only ${pattern.consistency}, not ${t.text}`;
  }
  return null;
}

export function buysLine(pattern: ForkPattern, c: ForkConstraint): string {
  const verdict = targetVerdict(pattern, c);
  return verdict ? `${pattern.buys} · ${verdict}` : pattern.buys;
}

function buildContext(subgraph: SelectedSubgraph): PatternContext {
  const base = baseNodesAndEdges(subgraph);
  const domain = deriveDomainSubject(subgraph.selectedShapes);
  const nodes = base.nodes.map((n) => ({ ...n }));
  const edges = base.edges.map((e) => ({ ...e }));
  const semId = (el: JevElement) => base.idToSemId.get(el.id)!;
  const storeKinds = new Set(["database", "cache", "blob"]);

  let entry = nodes.find((n) => n.id === semId(subgraph.entryNode)) ?? nodes[0];
  let store =
    nodes.find((n) => n.id !== entry.id && storeKinds.has(n.kind)) ??
    nodes.find((n) => n.id === semId(subgraph.exitNode) && n.id !== entry.id) ??
    nodes.find((n) => n.id !== entry.id);

  if (!store) {
    if (storeKinds.has(entry.kind)) {
      store = entry;
      entry = { id: "fk_service", label: domain ? `${domain} Service` : "App Service", kind: "node", tone: "cobalt" };
      nodes.unshift(entry);
    } else {
      store = { id: "fk_store", label: domain ? `${domain} DB` : "Primary DB", kind: "database", tone: "teal" };
      nodes.push(store);
    }
    edges.push({ from: entry.id, to: store.id, kind: "sync" });
  }

  const storeEdgeIdx = edges.findIndex((e) => e.from === entry.id && e.to === store.id);
  const focusNode = subgraph.selectedShapes.find((s) => s.kind !== "actor" && s.label.trim());
  return {
    nodes,
    edges,
    entry,
    store,
    storeEdgeIdx: storeEdgeIdx >= 0 ? storeEdgeIdx : edges.findIndex((e) => e.to === store.id),
    domain,
    focus: domain ?? focusNode?.label.trim() ?? "this flow",
  };
}

export function buildPatternTakeSpec(
  pattern: ForkPattern,
  subgraph: SelectedSubgraph,
  constraint: ForkConstraint
): ForkTakeSpec {
  const ctx = buildContext(subgraph);
  const drawing = pattern.draw(ctx);
  const graph: SemanticGraph = {
    notation: "architecture",
    summary: ctx.domain ? `${ctx.domain}: ${pattern.title}` : pattern.title,
    nodes: drawing.nodes,
    edges: drawing.edges,
    ...(drawing.groups ? { groups: drawing.groups } : {}),
  };
  return {
    archetype: pattern.id,
    title: pattern.title,
    rationale: pattern.rationale(ctx).slice(0, 200),
    tradeoffTag: pattern.tag,
    graph,
    ...(drawing.groupsAsZones ? { groupsAsZones: true } : {}),
    tradeoffs: {
      pressure: constraint.pressure,
      buys: buysLine(pattern, constraint),
      costs: pattern.costs,
      failureMode: pattern.failureMode,
    },
  };
}

/** Three takes from the pattern catalogue, ranked for the stated constraint. */
export function buildConstraintForkTakes(
  selectedIds: string[],
  allElements: JevElement[],
  constraint: ForkConstraint,
  now = Date.now()
): ForkGenerationResult | null {
  const subgraph = extractSelectedSubgraph(selectedIds, allElements);
  if (!subgraph) return null;
  const takes = rankForkPatterns(constraint).map((pattern) =>
    materializeForkTake(buildPatternTakeSpec(pattern, subgraph, constraint), subgraph, now)
  );
  return {
    subgraph,
    replacedIds: subgraph.replacedIds,
    takes,
    source: "heuristic",
    model: "pattern-catalogue",
    isHeuristic: true,
    confidence: null,
    constraint,
  };
}
