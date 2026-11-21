import { formatCount } from "../sd-estimate";
import { starterBoard, type BoardDef } from "./kit";

const AVG_FOLLOWERS = 200;
const CELEBRITY_FOLLOWERS = 10_000;

const def: BoardDef = {
  id: "news-feed",
  title: "News feed",
  blurb: "Fan-out on write into Redis timelines, fan-out on read for celebrities, merged at read time.",
  functional: [
    "Post text + media; follow / unfollow",
    "Home feed of followed accounts, newest first, paginated",
    "Media served from a CDN",
  ],
  nonFunctional: [
    "Feed load p99 < 200 ms; read-heavy",
    "A post shows in followers' feeds within 5 s (eventual)",
    "Accounts with millions of followers do not stall posting",
  ],
  numbers: {
    input: { dau: 200e6, writesPerUser: 0.5, readWriteRatio: 20, payloadBytes: 1000, retentionYears: 5, peakFactor: 3 },
    writeName: "post",
    readName: "feed load",
    extra: (r) => {
      const inserts = r.writesPerDay * AVG_FOLLOWERS;
      return [
        `Fan-out: ${formatCount(r.writesPerDay)} posts × ${AVG_FOLLOWERS} followers ≈ ${formatCount(inserts)} timeline inserts/day ≈ ${formatCount(inserts / 86_400)}/s`,
      ];
    },
  },
  api: {
    label: "GET /feed",
    lines: [
      "req: ?cursor=<post_id>&limit=50",
      "res: 200 {posts[], next_cursor}",
      "err: 401 not signed in",
      "err: 429 too many requests",
    ],
  },
  tradeoffs: [
    `Push (fan-out on write) for normal accounts: reads are one LRANGE. Pull for accounts over ${formatCount(CELEBRITY_FOLLOWERS)} followers, merged at read time`,
    "Timelines hold post ids only (8 B each, last 800); posts are hydrated from a cache, so edits and deletes show everywhere",
    "Cursor (last post_id) pagination, not offsets: stable while new posts arrive",
  ],
  zoneLabel: "VPC · us-east-1",
  nodes: [
    { id: "client", kind: "actor", label: "Client", col: 0, row: 1, outside: true },
    { id: "cdn", kind: "lb", label: "CDN", sublabel: "media", col: 0, row: 2, outside: true },
    { id: "s3", kind: "blob", label: "S3: media", col: 0, row: 3, outside: true },
    { id: "lb", kind: "lb", label: "LB", sublabel: "L7", col: 1, row: 1 },
    { id: "post", kind: "node", label: "Post Service", col: 2, row: 0 },
    { id: "posts", kind: "database", label: "Posts DB", sublabel: "MySQL · shard user_id", col: 2, row: 1 },
    { id: "kafka", kind: "queue", label: "Kafka: posts", col: 3, row: 0 },
    { id: "fanout", kind: "node", label: "Fan-out Workers", col: 4, row: 0 },
    { id: "timeline", kind: "cache", label: "Redis timelines", sublabel: "user → post ids", col: 3, row: 1 },
    { id: "graph", kind: "database", label: "Social Graph", sublabel: "followers", col: 4, row: 1 },
    { id: "feed", kind: "node", label: "Feed Service", col: 2, row: 2 },
  ],
  edges: [
    { from: "client", to: "lb", label: "HTTPS", path: "both" },
    { from: "client", to: "cdn", label: "GET media", path: "read" },
    { from: "cdn", to: "s3", label: "origin", path: "read" },
    { from: "lb", to: "post", label: "POST /posts", path: "write" },
    { from: "lb", to: "feed", label: "GET /feed", path: "read" },
    { from: "post", to: "posts", label: "INSERT", path: "write" },
    { from: "post", to: "kafka", label: "async", path: "write", async: true },
    { from: "kafka", to: "fanout", label: "consume", path: "write", async: true },
    { from: "fanout", to: "graph", label: "followers", path: "write" },
    { from: "fanout", to: "timeline", label: "LPUSH", path: "write" },
    { from: "feed", to: "timeline", label: "LRANGE", path: "read" },
    { from: "feed", to: "posts", label: "hydrate", path: "read" },
  ],
  breaks: {
    culprit: "fanout",
    side: "above",
    lines: [
      "10× = 2.3M timeline inserts/s, and one celebrity post means 50M inserts: fan-out lag goes from seconds to hours",
      `Fix: hybrid. Skip fan-out for accounts over ${formatCount(CELEBRITY_FOLLOWERS)} followers and pull their posts at read time; skip inactive followers`,
    ],
  },
  er: {
    from: ["post", "posts"],
    caption: "posts, follows, timelines",
    entities: [
      { id: "ent_follows", name: "follows", attributes: ["user_id bigint PK FK", "followee_id bigint PK", "created_at timestamptz"] },
      { id: "ent_users", name: "users", attributes: ["id bigint PK", "handle text UK", "follower_count int"] },
      { id: "ent_posts", name: "posts", attributes: ["id bigint PK", "user_id bigint FK", "body text", "media_key text"] },
      { id: "ent_timelines", name: "timelines", attributes: ["user_id bigint PK FK", "post_id bigint PK FK", "score bigint"] },
    ],
    relations: [
      { id: "rel_user_follows", from: "ent_users", to: "ent_follows", cardinality: "1:0..n", label: "follows" },
      { id: "rel_user_posts", from: "ent_users", to: "ent_posts", cardinality: "1:0..n", label: "writes" },
      { id: "rel_user_timeline", from: "ent_users", to: "ent_timelines", cardinality: "1:0..n", label: "sees" },
      { id: "rel_post_timeline", from: "ent_posts", to: "ent_timelines", cardinality: "1:0..n", label: "in" },
    ],
    grid: { ent_follows: [0, 0], ent_users: [1, 0], ent_posts: [2, 0], ent_timelines: [1, 1] },
  },
  sequence: {
    from: ["client", "lb", "feed", "timeline", "posts"],
    caption: "load home feed, hybrid merge",
    summary: "Load the home feed and merge celebrity posts at read time",
    messages: [
      { from: "client", to: "lb", label: "GET /feed" },
      { from: "lb", to: "feed", label: "GET /feed" },
      { from: "feed", to: "timeline", label: "LRANGE 0 49" },
      { from: "timeline", to: "feed", label: "post ids", isReturn: true },
      { from: "feed", to: "posts", label: "celebs' recent posts" },
      { from: "posts", to: "feed", label: "posts", isReturn: true },
      { from: "feed", to: "posts", label: "hydrate by ids" },
      { from: "posts", to: "feed", label: "posts", isReturn: true },
      { from: "feed", to: "lb", label: "200 merged", isReturn: true },
      { from: "lb", to: "client", label: "200 {posts}", isReturn: true },
    ],
    fragments: [{ operator: "opt", guard: "follows a celebrity", fromOrder: 5, toOrder: 6 }],
  },
};

export const newsFeed = starterBoard(def);
