import { formatCount } from "../sd-estimate";
import { starterBoard, type BoardDef } from "./kit";

const SOCKETS_PER_GATEWAY = 50_000;
const CONCURRENT_SHARE = 0.2;

const def: BoardDef = {
  id: "chat",
  title: "Chat",
  blurb: "WebSocket gateways, presence with heartbeats, a message store partitioned by conversation, async fan-out.",
  functional: [
    "1:1 and group chats (up to 1 000 members), text messages",
    "Delivery and read receipts; online / last-seen presence",
    "Offline users get a push and fetch history on reconnect",
  ],
  nonFunctional: [
    "Send-to-deliver p99 < 300 ms for online users",
    "No lost messages; per-conversation order preserved",
    "Sending is never blocked by fan-out to large groups",
  ],
  numbers: {
    input: { dau: 50e6, writesPerUser: 40, readWriteRatio: 2, payloadBytes: 200, retentionYears: 5, peakFactor: 3 },
    writeName: "send",
    readName: "delivery",
    extra: (r) => {
      const sockets = r.input.dau * CONCURRENT_SHARE;
      return [
        `Open sockets ≈ 20% of DAU = ${formatCount(sockets)}; at ${formatCount(SOCKETS_PER_GATEWAY)} per host ≈ ${formatCount(sockets / SOCKETS_PER_GATEWAY)} gateways`,
      ];
    },
  },
  api: {
    label: "POST /conversations/{id}/messages",
    lines: [
      "req: {client_msg_id, body}",
      "res: 201 {msg_id, created_at}",
      "err: 403 not a member",
      "err: 413 body too large",
      "idem: client_msg_id dedupes resends",
    ],
  },
  tradeoffs: [
    "WebSocket over long polling: one socket per device, server push without a request per message",
    "Partition messages by conversation_id, cluster by time-ordered msg_id: one partition read returns a page of history in order",
    "Ack after the durable write, fan out async: a 1 000-member group costs the sender nothing",
  ],
  zoneLabel: "Region · eu-west-1",
  nodes: [
    { id: "client", kind: "actor", label: "Client", col: 0, row: 1, outside: true },
    { id: "lb", kind: "lb", label: "LB", sublabel: "L4 · sticky", col: 1, row: 1 },
    { id: "ws", kind: "node", label: "WS Gateway", sublabel: "holds sockets", col: 2, row: 1 },
    { id: "presence", kind: "node", label: "Presence", sublabel: "heartbeat 30 s", col: 2, row: 0 },
    { id: "redis", kind: "cache", label: "Redis", sublabel: "sessions, last_seen", col: 3, row: 0 },
    { id: "chat", kind: "node", label: "Chat Service", col: 3, row: 1 },
    { id: "store", kind: "database", label: "Message Store", sublabel: "Cassandra · PK conv_id", col: 4, row: 1 },
    { id: "kafka", kind: "queue", label: "Kafka: messages", col: 3, row: 2 },
    { id: "fanout", kind: "node", label: "Fan-out Workers", col: 2, row: 2 },
    { id: "push", kind: "external", label: "APNs / FCM", sublabel: "offline push", col: 2, row: 3, outside: true },
  ],
  edges: [
    { from: "client", to: "lb", label: "WSS", path: "both" },
    { from: "lb", to: "ws", label: "WebSocket", path: "both" },
    { from: "ws", to: "presence", label: "heartbeat", path: "write", async: true },
    { from: "presence", to: "redis", label: "SET TTL 60s", path: "write" },
    { from: "ws", to: "chat", label: "send · gRPC", path: "write" },
    { from: "chat", to: "store", label: "append", path: "write" },
    { from: "chat", to: "redis", label: "who is online", path: "read" },
    { from: "chat", to: "kafka", label: "publish · async", path: "write", async: true },
    { from: "kafka", to: "fanout", label: "consume", path: "write", async: true },
    { from: "fanout", to: "ws", label: "deliver · gRPC", path: "read" },
    { from: "fanout", to: "push", label: "offline · async", path: "read", async: true },
  ],
  breaks: {
    culprit: "store",
    side: "above",
    lines: [
      "10× = 690K peak sends/s: a busy group's conv_id partition gets every write and every history read, so it goes hot",
      "Fix: partition key (conv_id, day bucket), cache the last 50 messages per conversation, cap group fan-out with per-gateway pub/sub",
    ],
  },
  er: {
    from: ["chat", "store"],
    caption: "conversations and messages",
    entities: [
      { id: "ent_users", name: "users", attributes: ["id bigint PK", "name text", "last_seen_at timestamptz"] },
      { id: "ent_members", name: "members", attributes: ["conversation_id bigint PK FK", "user_id bigint PK FK", "last_read_msg_id bigint"] },
      { id: "ent_convs", name: "conversations", attributes: ["id bigint PK", "kind text", "created_at timestamptz"] },
      { id: "ent_msgs", name: "messages", attributes: ["conversation_id bigint PK FK", "msg_id bigint PK", "sender_id bigint", "body text"] },
    ],
    relations: [
      { id: "rel_user_members", from: "ent_users", to: "ent_members", cardinality: "1:0..n", label: "joins" },
      { id: "rel_conv_members", from: "ent_convs", to: "ent_members", cardinality: "1:1..n", label: "has" },
      { id: "rel_conv_msgs", from: "ent_convs", to: "ent_msgs", cardinality: "1:0..n", label: "holds" },
    ],
    grid: { ent_users: [0, 0], ent_members: [1, 0], ent_convs: [2, 0], ent_msgs: [2, 1] },
  },
  sequence: {
    from: ["client", "ws", "chat", "store", "kafka", "fanout"],
    caption: "send to a group",
    summary: "Send a message to a group and fan it out",
    messages: [
      { from: "client", to: "ws", label: "send(client_msg_id)" },
      { from: "ws", to: "chat", label: "SendMessage" },
      { from: "chat", to: "store", label: "INSERT msg" },
      { from: "store", to: "chat", label: "msg_id", isReturn: true },
      { from: "chat", to: "kafka", label: "publish", async: true },
      { from: "chat", to: "ws", label: "ack msg_id", isReturn: true },
      { from: "ws", to: "client", label: "sent", isReturn: true },
      { from: "kafka", to: "fanout", label: "consume", async: true },
      { from: "fanout", to: "ws", label: "deliver" },
      { from: "ws", to: "fanout", label: "delivered", isReturn: true },
    ],
    fragments: [{ operator: "loop", guard: "each online member", fromOrder: 9, toOrder: 10 }],
  },
};

export const chat = starterBoard(def);
