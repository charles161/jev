import { formatCount } from "../sd-estimate";
import { starterBoard, type BoardDef } from "./kit";

const KEY_SPACE = 62 ** 7;

const def: BoardDef = {
  id: "url-shortener",
  title: "URL shortener",
  blurb: "Base62 keys from ID ranges, a read-heavy Redis cache, 302 redirects, async click analytics.",
  functional: [
    "Shorten a long URL to a 7-char code; optional custom alias and expiry",
    "GET /{code} redirects to the long URL",
    "Click counts per link (eventually consistent)",
  ],
  nonFunctional: [
    "Redirect p99 < 50 ms; 99.99% available for reads",
    "Codes are unique and not guessable in sequence",
    "Read-heavy: 100 redirects per new URL",
  ],
  numbers: {
    input: { dau: 100e6, writesPerUser: 0.1, readWriteRatio: 100, payloadBytes: 500, retentionYears: 5, peakFactor: 3 },
    writeName: "new URL",
    readName: "redirect",
    extra: (r) => [
      `URLs in 5 y ≈ ${formatCount(r.writesPerDay * 365 * 5)}; 62^7 ≈ ${formatCount(KEY_SPACE)} codes, so 7 chars is enough`,
    ],
  },
  api: {
    label: "POST /urls",
    lines: [
      "req: {long_url, alias?, expires_at?}",
      "res: 201 {code, short_url}",
      "err: 409 alias taken",
      "err: 400 invalid URL",
      "idem: Idempotency-Key header",
    ],
  },
  tradeoffs: [
    "302 not 301: browsers cache a 301 forever, so clicks stop reaching us (no analytics, no expiry). 301 only for static links to cut load",
    "ID ranges + base62 over hashing: no collision checks; ranges are handed out in blocks so codes are not sequential per user",
    "Cassandra keyed by code: single-key reads, no joins needed",
  ],
  zoneLabel: "VPC · us-east-1",
  nodes: [
    { id: "client", kind: "actor", label: "Client", col: 0, row: 1, outside: true },
    { id: "lb", kind: "lb", label: "LB", sublabel: "L7 · TLS", col: 1, row: 1 },
    { id: "shorten", kind: "node", label: "Shorten Service", col: 2, row: 0 },
    { id: "redirect", kind: "node", label: "Redirect Service", col: 2, row: 2 },
    { id: "kgs", kind: "node", label: "Key Gen Service", sublabel: "ID ranges → base62", col: 3, row: 0 },
    { id: "db", kind: "database", label: "URL DB", sublabel: "Cassandra · key=code", col: 3, row: 1 },
    { id: "redis", kind: "cache", label: "Redis", sublabel: "code → URL · LRU", col: 3, row: 2 },
    { id: "clicks", kind: "queue", label: "Kafka: clicks", col: 2, row: 3 },
    { id: "analytics", kind: "node", label: "Analytics", sublabel: "click counts", col: 1, row: 3 },
  ],
  edges: [
    { from: "client", to: "lb", label: "HTTPS", path: "both" },
    { from: "lb", to: "shorten", label: "POST /urls", path: "write" },
    { from: "lb", to: "redirect", label: "GET /{code}", path: "read" },
    { from: "shorten", to: "kgs", label: "next id · gRPC", path: "write" },
    { from: "shorten", to: "db", label: "INSERT IF NOT EXISTS", path: "write" },
    { from: "redirect", to: "redis", label: "GET · RESP", path: "read" },
    { from: "redirect", to: "db", label: "on miss: SELECT", path: "read" },
    { from: "redirect", to: "clicks", label: "click · async", path: "write", async: true },
    { from: "clicks", to: "analytics", label: "consume", path: "write", async: true },
  ],
  breaks: {
    culprit: "redis",
    side: "below",
    lines: [
      "10× = 350K peak redirects/s; one Redis primary tops out near 100K ops/s and viral codes make hot keys",
      "Fix: Redis Cluster sharded by code + replicas, an in-process LRU for the hottest codes, CDN-cache 302s for 60 s",
    ],
  },
  er: {
    from: ["shorten", "db"],
    caption: "links and clicks",
    entities: [
      { id: "ent_users", name: "users", attributes: ["id bigint PK", "email text UK", "created_at timestamptz"] },
      { id: "ent_urls", name: "urls", attributes: ["id bigint PK", "code char(7) UK", "long_url text", "user_id bigint FK", "expires_at timestamptz"] },
      { id: "ent_clicks", name: "clicks", attributes: ["id bigint PK", "url_id bigint FK", "clicked_at timestamptz", "country char(2)"] },
    ],
    relations: [
      { id: "rel_user_urls", from: "ent_users", to: "ent_urls", cardinality: "1:0..n", label: "creates" },
      { id: "rel_url_clicks", from: "ent_urls", to: "ent_clicks", cardinality: "1:0..n", label: "gets" },
    ],
  },
  sequence: {
    from: ["client", "lb", "redirect", "redis", "db"],
    caption: "redirect, cache-aside",
    summary: "Redirect a short code with a cache-aside lookup",
    messages: [
      { from: "client", to: "lb", label: "GET /{code}" },
      { from: "lb", to: "redirect", label: "GET /{code}" },
      { from: "redirect", to: "redis", label: "GET url:{code}" },
      { from: "redis", to: "redirect", label: "long_url", isReturn: true },
      { from: "redirect", to: "db", label: "SELECT by code" },
      { from: "db", to: "redirect", label: "long_url", isReturn: true },
      { from: "redirect", to: "redis", label: "SET EX 24h", async: true },
      { from: "redirect", to: "lb", label: "302 Location", isReturn: true },
      { from: "lb", to: "client", label: "302 Location", isReturn: true },
    ],
    fragments: [{ operator: "alt", guard: "cache hit", fromOrder: 4, toOrder: 7, elseFromOrder: 5, elseGuard: "miss" }],
  },
};

export const urlShortener = starterBoard(def);
