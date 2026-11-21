import { formatCount } from "../sd-estimate";
import { starterBoard, type BoardDef } from "./kit";

const CHANNEL_SHARE = { push: 0.7, email: 0.25, sms: 0.05 };

const def: BoardDef = {
  id: "notifications",
  title: "Notifications",
  blurb: "A queue and worker per channel, APNs/FCM, SES and Twilio, retries with backoff into a DLQ, user preferences.",
  functional: [
    "Services send push, email and SMS by event",
    "Users set per-channel and per-category preferences, quiet hours",
    "Delivery status per notification",
  ],
  nonFunctional: [
    "At-least-once delivery, deduped by event_id",
    "A slow channel (SMS) never delays the others",
    "Absorb 5× campaign bursts; push p99 < 5 s",
  ],
  cellW: 270,
  numbers: {
    input: { dau: 100e6, writesPerUser: 5, readWriteRatio: 2, payloadBytes: 500, retentionYears: 1, peakFactor: 5 },
    writeName: "send",
    readName: "inbox read",
    extra: (r) => [
      `By channel at peak: push ${formatCount(r.peakWriteQps * CHANNEL_SHARE.push)}/s, email ${formatCount(r.peakWriteQps * CHANNEL_SHARE.email)}/s, SMS ${formatCount(r.peakWriteQps * CHANNEL_SHARE.sms)}/s`,
    ],
  },
  api: {
    label: "POST /notifications",
    lines: [
      "req: {event_id, user_id, template, data}",
      "res: 202 {notification_id}",
      "err: 404 unknown template",
      "idem: event_id (dedupe 24 h)",
    ],
  },
  tradeoffs: [
    "A topic and worker pool per channel: SMS provider limits and email latency cannot back up push",
    "Retry with exponential backoff + jitter via retry topics; after 5 tries a DLQ for inspection, never a hot loop",
    "Preferences checked at send time from a cache, so an opt-out applies to queued campaigns too",
  ],
  zoneLabel: "VPC · us-east-1",
  nodes: [
    { id: "user", kind: "actor", label: "User", col: 0, row: 0, outside: true },
    { id: "caller", kind: "external", label: "Order Service", sublabel: "any producer", col: 0, row: 2, outside: true },
    { id: "lb", kind: "lb", label: "LB", sublabel: "L7", col: 1, row: 1 },
    { id: "prefs", kind: "cache", label: "Redis: prefs", col: 2, row: 0 },
    { id: "prefsdb", kind: "database", label: "Prefs DB", col: 1, row: 0 },
    { id: "notify", kind: "node", label: "Notify API", sublabel: "dedupe, prefs", col: 2, row: 1 },
    { id: "log", kind: "database", label: "Notification log", col: 2, row: 2 },
    { id: "qpush", kind: "queue", label: "push topic", sublabel: "retry → DLQ", col: 3, row: 0 },
    { id: "qemail", kind: "queue", label: "email topic", sublabel: "retry → DLQ", col: 3, row: 1 },
    { id: "qsms", kind: "queue", label: "SMS topic", sublabel: "retry → DLQ", col: 3, row: 2 },
    { id: "wpush", kind: "node", label: "Push workers", col: 4, row: 0 },
    { id: "wemail", kind: "node", label: "Email workers", col: 4, row: 1 },
    { id: "wsms", kind: "node", label: "SMS workers", col: 4, row: 2 },
    { id: "apns", kind: "external", label: "APNs / FCM", col: 5, row: 0, outside: true },
    { id: "ses", kind: "external", label: "SES", col: 5, row: 1, outside: true },
    { id: "twilio", kind: "external", label: "Twilio", col: 5, row: 2, outside: true },
  ],
  edges: [
    { from: "user", to: "lb", label: "PUT /prefs", path: "write" },
    { from: "caller", to: "lb", label: "POST /notify", path: "write" },
    { from: "lb", to: "notify", label: "HTTP", path: "write" },
    { from: "notify", to: "prefs", label: "GET", path: "read" },
    { from: "prefs", to: "prefsdb", label: "miss", path: "read" },
    { from: "notify", to: "log", label: "INSERT", path: "write" },
    { from: "notify", to: "qpush", label: "async", path: "write", async: true },
    { from: "notify", to: "qemail", label: "async", path: "write", async: true },
    { from: "notify", to: "qsms", label: "async", path: "write", async: true },
    { from: "qpush", to: "wpush", label: "pull", path: "write", async: true },
    { from: "qemail", to: "wemail", label: "pull", path: "write", async: true },
    { from: "qsms", to: "wsms", label: "pull", path: "write", async: true },
    { from: "wpush", to: "apns", label: "HTTP/2", path: "write" },
    { from: "wemail", to: "ses", label: "SMTP", path: "write" },
    { from: "wsms", to: "twilio", label: "REST", path: "write" },
  ],
  breaks: {
    culprit: "wpush",
    side: "above",
    lines: [
      "10× = 290K sends/s at peak in a campaign: push workers hit APNs/FCM throttling and dead tokens, and retries pile up",
      "Fix: per-provider token-bucket pacing, HTTP/2 connection pools, prune dead tokens on 410, schedule campaigns by time zone",
    ],
  },
  er: {
    from: ["notify", "log"],
    caption: "users, devices, preferences",
    entities: [
      { id: "ent_devices", name: "devices", attributes: ["id bigint PK", "user_id bigint FK", "platform text", "push_token text UK"] },
      { id: "ent_users", name: "users", attributes: ["id bigint PK", "email text", "phone text", "timezone text"] },
      { id: "ent_prefs", name: "preferences", attributes: ["user_id bigint PK FK", "channel text PK", "category text PK", "enabled bool"] },
      { id: "ent_notifs", name: "notifications", attributes: ["id bigint PK", "user_id bigint FK", "event_id text UK", "channel text", "status text", "attempts int"] },
    ],
    relations: [
      { id: "rel_user_devices", from: "ent_users", to: "ent_devices", cardinality: "1:0..n", label: "has" },
      { id: "rel_user_prefs", from: "ent_users", to: "ent_prefs", cardinality: "1:0..n", label: "sets" },
      { id: "rel_user_notifs", from: "ent_users", to: "ent_notifs", cardinality: "1:0..n", label: "gets" },
    ],
    grid: { ent_devices: [0, 0], ent_users: [1, 0], ent_prefs: [2, 0], ent_notifs: [1, 1] },
  },
  sequence: {
    from: ["caller", "notify", "prefs", "qpush", "wpush", "apns"],
    caption: "push with retries",
    summary: "Send a push notification with preference check, retries and a DLQ",
    messages: [
      { from: "caller", to: "notify", label: "POST (event_id)" },
      { from: "notify", to: "prefs", label: "GET prefs" },
      { from: "prefs", to: "notify", label: "push on", isReturn: true },
      { from: "notify", to: "qpush", label: "publish", async: true },
      { from: "notify", to: "caller", label: "202", isReturn: true },
      { from: "qpush", to: "wpush", label: "consume", async: true },
      { from: "wpush", to: "apns", label: "send(token)" },
      { from: "apns", to: "wpush", label: "200 | 5xx", isReturn: true },
      { from: "wpush", to: "qpush", label: "to DLQ", async: true },
    ],
    fragments: [
      { operator: "loop", guard: "5xx: backoff, ≤5 tries", fromOrder: 7, toOrder: 8 },
      { operator: "opt", guard: "still failing", fromOrder: 9, toOrder: 9 },
    ],
  },
};

export const notifications = starterBoard(def);
