import { formatBytes, formatCount } from "../sd-estimate";
import { starterBoard, type BoardDef } from "./kit";

const RULES_PER_USER = 2;
const OPS_PER_SHARD = 100_000;

const def: BoardDef = {
  id: "rate-limiter",
  title: "Rate limiter",
  blurb: "Token bucket in Redis run as one Lua script, rules cached at the gateway, 429 with Retry-After.",
  functional: [
    "Limit requests per API key and per route (e.g. 100/min, burst 20)",
    "Over the limit: 429 with Retry-After and RateLimit headers",
    "Rules change without a deploy",
  ],
  nonFunctional: [
    "Adds < 2 ms p99 to every request",
    "Accurate across all gateway nodes (shared counters)",
    "Fail open if Redis is down: availability over strictness",
  ],
  numbers: {
    input: { dau: 50e6, writesPerUser: 200, readWriteRatio: 1, payloadBytes: 64, retentionYears: 0, peakFactor: 3 },
    writeName: "request",
    readName: "Redis op",
    omit: ["storage", "bandwidth", "cache"],
    extra: (r) => [
      `Redis memory: ${formatCount(r.input.dau)} keys × ${RULES_PER_USER} rules × ${formatBytes(r.input.payloadBytes)} ≈ ${formatBytes(r.input.dau * RULES_PER_USER * r.input.payloadBytes)}`,
      `Shards at ${formatCount(OPS_PER_SHARD)} ops/s each: ${formatCount(r.peakReadQps)} ÷ ${formatCount(OPS_PER_SHARD)} = ${Math.ceil(r.peakReadQps / OPS_PER_SHARD)} primaries`,
    ],
  },
  api: {
    label: "GET /v1/orders",
    lines: [
      "req: Authorization: Bearer <api key>",
      "res: 200 + RateLimit-Remaining",
      "err: 429 Retry-After: <seconds>",
      "err: 401 unknown key",
    ],
  },
  tradeoffs: [
    "Token bucket: allows bursts and costs 2 numbers per key. Sliding-window log is exact but stores every timestamp; sliding-window counter is the cheap middle",
    "Check and decrement in one Lua script (EVALSHA): atomic, no race between gateway nodes",
    "Fail open on Redis timeout: a short over-admit beats a full outage",
  ],
  zoneLabel: "VPC · us-east-1",
  nodes: [
    { id: "client", kind: "actor", label: "Client", col: 0, row: 1, outside: true },
    { id: "rulesdb", kind: "database", label: "Rules DB", sublabel: "Postgres", col: 1, row: 0 },
    { id: "gw", kind: "lb", label: "API Gateway", sublabel: "limit middleware", col: 1, row: 1 },
    { id: "rules", kind: "node", label: "Rules Service", col: 2, row: 0 },
    { id: "limiter", kind: "node", label: "Rate Limiter", sublabel: "token bucket", col: 2, row: 1 },
    { id: "redis", kind: "cache", label: "Redis Cluster", sublabel: "bucket per key", col: 3, row: 1 },
    { id: "orders", kind: "node", label: "Orders API", col: 2, row: 2 },
    { id: "kafka", kind: "queue", label: "Kafka: throttles", col: 3, row: 2 },
  ],
  edges: [
    { from: "client", to: "gw", label: "HTTPS", path: "both" },
    { from: "gw", to: "limiter", label: "allow?", path: "both" },
    { from: "limiter", to: "redis", label: "EVALSHA", path: "write" },
    { from: "limiter", to: "rules", label: "rules · 60s", path: "read" },
    { from: "rules", to: "rulesdb", label: "SELECT", path: "read" },
    { from: "gw", to: "orders", label: "forward", path: "both" },
    { from: "limiter", to: "kafka", label: "429 event · async", path: "write", async: true },
  ],
  breaks: {
    culprit: "redis",
    side: "above",
    lines: [
      "10× = 3.5M checks/s at peak, and one noisy API key pins one shard: Redis CPU and the network hop dominate latency",
      "Fix: shard buckets by key; gateways lease batches of tokens and refill locally (small over-admit); local deny-cache for keys at 0",
    ],
  },
  er: {
    from: ["rules", "rulesdb"],
    caption: "tiers, rules, keys",
    entities: [
      { id: "ent_rules", name: "rules", attributes: ["id bigint PK", "tier_id bigint FK", "route text", "per_min int", "burst int"] },
      { id: "ent_tiers", name: "tiers", attributes: ["id bigint PK", "name text UK"] },
      { id: "ent_clients", name: "clients", attributes: ["id bigint PK", "tier_id bigint FK", "name text"] },
      { id: "ent_keys", name: "api_keys", attributes: ["id bigint PK", "client_id bigint FK", "key_hash text UK", "revoked_at timestamptz"] },
    ],
    relations: [
      { id: "rel_tier_rules", from: "ent_tiers", to: "ent_rules", cardinality: "1:1..n", label: "has" },
      { id: "rel_tier_clients", from: "ent_tiers", to: "ent_clients", cardinality: "1:0..n", label: "has" },
      { id: "rel_client_keys", from: "ent_clients", to: "ent_keys", cardinality: "1:1..n", label: "owns" },
    ],
    grid: { ent_rules: [0, 0], ent_tiers: [1, 0], ent_clients: [2, 0], ent_keys: [2, 1] },
  },
  sequence: {
    from: ["client", "gw", "limiter", "redis", "orders"],
    caption: "check a request",
    summary: "Check a request against its token bucket",
    messages: [
      { from: "client", to: "gw", label: "GET /v1/orders" },
      { from: "gw", to: "limiter", label: "allow(key, route)" },
      { from: "limiter", to: "redis", label: "EVALSHA bucket" },
      { from: "redis", to: "limiter", label: "tokens left", isReturn: true },
      { from: "limiter", to: "gw", label: "allow | deny", isReturn: true },
      { from: "gw", to: "orders", label: "forward" },
      { from: "orders", to: "gw", label: "200", isReturn: true },
      { from: "gw", to: "client", label: "200", isReturn: true },
      { from: "gw", to: "client", label: "429 Retry-After", isReturn: true },
    ],
    fragments: [{ operator: "alt", guard: "token taken", fromOrder: 6, toOrder: 9, elseFromOrder: 9, elseGuard: "bucket empty" }],
  },
};

export const rateLimiter = starterBoard(def);
