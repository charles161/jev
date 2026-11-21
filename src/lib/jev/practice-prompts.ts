import type { ShapeKind } from "@/lib/jev/types";

export const PRACTICE_PROMPT_IDS = ["url-shortener", "chat", "feed", "rate-limiter", "payments", "notifications"] as const;
export type PracticePromptId = (typeof PRACTICE_PROMPT_IDS)[number];

export interface PracticePrompt {
  id: PracticePromptId;
  title: string;
  brief: string;
  functional: string[];
  nonFunctional: string[];
  minutes: 35 | 45;
  /** Words that, in a text note, state a functional requirement for this problem. */
  functionalWords: string[];
  /** Plausible peak requests per second, an order-of-magnitude band. */
  qpsRange: [number, number];
  /** The fix for this problem's hot path: shape kinds and label words that count. */
  bottleneck: { kinds: ShapeKind[]; words: string[]; question: string };
  dataModelHint: string;
  tradeoffHint: string;
  followUp: string;
}

export const PRACTICE_PROMPTS: PracticePrompt[] = [
  {
    id: "url-shortener",
    title: "URL shortener",
    brief: "Design a service like bit.ly: turn a long URL into a short link and redirect every visitor fast.",
    functional: ["Create a short link for a long URL", "Redirect a short link to its URL", "Custom alias and expiry"],
    nonFunctional: ["Redirect p99 under 50 ms", "Reads outnumber writes about 100 to 1", "Links never collide or vanish"],
    minutes: 35,
    functionalWords: ["shorten", "short link", "short url", "redirect", "alias", "expir"],
    qpsRange: [100, 1_000_000],
    bottleneck: {
      kinds: ["cache"],
      words: ["cache", "redis", "memcache", "cdn", "replica"],
      question: "This DB is on every redirect. Where is the cache?",
    },
    dataModelHint: "a links table: short_code PK, long_url, created_at, expires_at",
    tradeoffHint: "random codes vs a counter: collisions against a hot single writer",
    followUp: "What happens at 10x redirects: which box falls over first?",
  },
  {
    id: "chat",
    title: "Chat",
    brief: "Design one-to-one and group chat like WhatsApp: messages arrive in real time and in order, even after a reconnect.",
    functional: ["Send and receive messages in real time", "Group chats", "Delivery and read receipts", "History on a new device"],
    nonFunctional: ["Delivery under 200 ms", "Messages never lost, ordered per chat", "Millions of open connections"],
    minutes: 45,
    functionalWords: ["send", "message", "group", "receipt", "deliver", "history", "online"],
    qpsRange: [1_000, 10_000_000],
    bottleneck: {
      kinds: ["queue"],
      words: ["queue", "kafka", "pub/sub", "pubsub", "websocket", "partition", "shard"],
      question: "Every message goes through this store. How do messages fan out to online devices?",
    },
    dataModelHint: "messages: chat_id + seq PK, sender_id, body, sent_at; members: chat_id, user_id",
    tradeoffHint: "push over WebSockets vs polling: open connections against latency",
    followUp: "A user reconnects after an hour offline. Walk the path that fills the gap.",
  },
  {
    id: "feed",
    title: "News feed",
    brief: "Design a home feed like Twitter or Instagram: people follow others and see recent posts ranked, fast.",
    functional: ["Publish a post", "Follow users", "See a ranked home feed", "Paginate older posts"],
    nonFunctional: ["Feed loads in under 300 ms", "Eventual consistency is fine", "Celebrities with 50M followers"],
    minutes: 45,
    functionalWords: ["post", "follow", "feed", "timeline", "rank", "paginat"],
    qpsRange: [1_000, 10_000_000],
    bottleneck: {
      kinds: ["cache", "queue"],
      words: ["cache", "redis", "fan-out", "fanout", "fan out", "queue", "precompute"],
      question: "Building every feed from this DB on read will not scale. Fan out on write, or cache feeds?",
    },
    dataModelHint: "posts: post_id PK, author_id, created_at; follows: follower_id, followee_id",
    tradeoffHint: "fan-out on write vs on read: write amplification for celebrities against slow reads",
    followUp: "A celebrity with 50M followers posts. What does your design do?",
  },
  {
    id: "rate-limiter",
    title: "Rate limiter",
    brief: "Design a distributed rate limiter for a public API: cap each client to N requests per window across many servers.",
    functional: ["Limit requests per client per window", "Return 429 with retry-after", "Configurable rules per endpoint"],
    nonFunctional: ["Adds under 5 ms per request", "Works across many API servers", "Fails open if the store is down"],
    minutes: 35,
    functionalWords: ["limit", "429", "retry", "rule", "quota", "throttl", "window"],
    qpsRange: [1_000, 10_000_000],
    bottleneck: {
      kinds: ["cache"],
      words: ["redis", "cache", "token bucket", "sliding window", "counter", "shard"],
      question: "Every API call checks a counter. Where do the counters live so the check stays under 5 ms?",
    },
    dataModelHint: "counters keyed by client_id + window: count, expires_at; rules: endpoint, limit, window",
    tradeoffHint: "token bucket vs sliding window log: memory against accuracy at the edges",
    followUp: "The counter store goes down. Do you fail open or closed, and why?",
  },
  {
    id: "payments",
    title: "Payments",
    brief: "Design a payment system for a marketplace: charge a buyer through a provider and pay out the seller, exactly once.",
    functional: ["Charge a card through a provider", "Refunds", "Pay out sellers", "Payment status for the user"],
    nonFunctional: ["Never charge twice", "Strong consistency on balances", "Auditable ledger"],
    minutes: 45,
    functionalWords: ["charge", "pay", "refund", "payout", "checkout", "status"],
    qpsRange: [10, 100_000],
    bottleneck: {
      kinds: ["queue"],
      words: ["queue", "idempotency", "idempotent", "outbox", "ledger", "retry", "kafka"],
      question: "The provider call can time out after charging. Where is the idempotency key and the retry queue?",
    },
    dataModelHint: "payments: payment_id PK, idempotency_key UK, amount, status; ledger_entries: entry_id, account_id, amount",
    tradeoffHint: "synchronous charge vs async with webhooks: user wait against consistency",
    followUp: "The provider times out after charging the card. Walk what happens on retry.",
  },
  {
    id: "notifications",
    title: "Notifications",
    brief: "Design a notification service that sends push, email and SMS for many product teams, reliably and without spamming.",
    functional: ["Send push, email and SMS", "User preferences and opt-out", "Templates", "Scheduled sends"],
    nonFunctional: ["At-least-once delivery", "Spikes of 1M sends in a minute", "Per-user rate caps"],
    minutes: 35,
    functionalWords: ["send", "push", "email", "sms", "preference", "opt", "template", "schedul"],
    qpsRange: [100, 1_000_000],
    bottleneck: {
      kinds: ["queue"],
      words: ["queue", "kafka", "worker", "retry", "rate limit", "batch"],
      question: "A 1M-send spike hits this path directly. Where is the queue that absorbs it?",
    },
    dataModelHint: "notifications: id PK, user_id, channel, status, sent_at; preferences: user_id, channel, opted_in",
    tradeoffHint: "at-least-once vs exactly-once: duplicate pushes against a dedup store",
    followUp: "The SMS provider is down for ten minutes. What happens to queued sends?",
  },
];

export function getPracticePrompt(id: string): PracticePrompt | null {
  return PRACTICE_PROMPTS.find((p) => p.id === id) ?? null;
}
