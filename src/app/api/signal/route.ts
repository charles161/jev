import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getClientIp,
  jsonNoStore,
  readJsonBodyWithByteLimit,
} from "@/lib/server/http";
import { logServerEvent } from "@/lib/server/logger";
import {
  buildRateLimitHeaders,
  SlidingWindowRateLimiter,
} from "@/lib/server/rate-limit";

const ROUTE = "/api/signal";
const MAX_ROOMS = 150;
const MAX_MESSAGES_PER_ROOM = 80;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 24 * 1024;

const ID_PATTERN = /^[a-zA-Z0-9_-]{3,40}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const SINCE_PATTERN = /^\d{1,10}$/;

const signalGetRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 240,
  maxEntries: 2000,
});

const signalPostRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  maxEntries: 2000,
});

const idSchema = z.string().regex(ID_PATTERN);

const signalQuerySchema = z.object({
  room: idSchema,
  peerId: idSchema,
  since: z
    .string()
    .regex(SINCE_PATTERN)
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000),
});

const sdpStringSchema = z
  .string()
  .min(10)
  .max(20_000)
  .refine((sdp) => sdp.startsWith("v=0"), "Invalid SDP session description");

const icePayloadSchema = z.object({
  candidate: z.string().max(2048),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

const joinSignalSchema = z
  .object({
    room: idSchema,
    from: idSchema,
    type: z.literal("join"),
    name: z.string().trim().min(1).max(32).optional(),
    color: z.string().regex(HEX_COLOR_PATTERN).optional(),
  })
  .strict();

const leaveSignalSchema = z
  .object({
    room: idSchema,
    from: idSchema,
    type: z.literal("leave"),
  })
  .strict();

const offerSignalSchema = z
  .object({
    room: idSchema,
    from: idSchema,
    to: idSchema,
    type: z.literal("offer"),
    payload: z.object({
      type: z.literal("offer"),
      sdp: sdpStringSchema,
    }),
  })
  .strict()
  .refine((d) => d.to !== d.from, "Sender and target peer must differ");

const answerSignalSchema = z
  .object({
    room: idSchema,
    from: idSchema,
    to: idSchema,
    type: z.literal("answer"),
    payload: z.object({
      type: z.literal("answer"),
      sdp: sdpStringSchema,
    }),
  })
  .strict()
  .refine((d) => d.to !== d.from, "Sender and target peer must differ");

const iceSignalSchema = z
  .object({
    room: idSchema,
    from: idSchema,
    to: idSchema,
    type: z.literal("ice"),
    payload: icePayloadSchema,
  })
  .strict()
  .refine((d) => d.to !== d.from, "Sender and target peer must differ");

const signalPostSchema = z.discriminatedUnion("type", [
  joinSignalSchema,
  leaveSignalSchema,
  offerSignalSchema,
  answerSignalSchema,
  iceSignalSchema,
]);

type ValidSignalPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | z.infer<typeof icePayloadSchema>;

interface SignalMessage {
  seq: number;
  from: string;
  to?: string;
  type: "join" | "offer" | "answer" | "ice" | "leave";
  payload?: ValidSignalPayload;
  name?: string;
  color?: string;
  ts: number;
}

interface RoomBucket {
  messages: SignalMessage[];
  lastActive: number;
  nextSeq: number;
}

// Ephemeral in-memory relay for lightweight WebRTC SDP/ICE handshake.
const rooms = new Map<string, RoomBucket>();

function pruneRooms(now: number) {
  for (const [key, bucket] of rooms.entries()) {
    if (now - bucket.lastActive > ROOM_TTL_MS) {
      rooms.delete(key);
    }
  }
  while (rooms.size > MAX_ROOMS) {
    const oldestKey = rooms.keys().next().value;
    if (!oldestKey) break;
    rooms.delete(oldestKey);
  }
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const clientIp = getClientIp(request);
  const rateLimit = signalGetRateLimiter.check(clientIp);
  const rateHeaders = buildRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "GET",
      event: "rate_limit_exceeded",
      status: 429,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      {
        error: "Too many requests",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      { status: 429, headers: rateHeaders }
    );
  }

  const { searchParams } = new URL(request.url);
  const parsedQuery = signalQuerySchema.safeParse({
    room: searchParams.get("room") ?? "",
    peerId: searchParams.get("peerId") ?? "",
    since: searchParams.get("since") ?? "0",
  });

  if (!parsedQuery.success) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "GET",
      event: "query_validation_failed",
      status: 400,
      errorClass: "ZodError",
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      { error: "Invalid room, peerId, or cursor" },
      { status: 400, headers: rateHeaders }
    );
  }

  const { room, peerId, since } = parsedQuery.data;
  const now = Date.now();
  pruneRooms(now);

  const bucket = rooms.get(room);
  if (!bucket) {
    return jsonNoStore({ messages: [], cursor: since }, { headers: rateHeaders });
  }

  bucket.lastActive = now;
  const messages = bucket.messages.filter(
    (m) => m.seq > since && m.from !== peerId && (!m.to || m.to === peerId)
  );
  const cursor =
    bucket.messages.length > 0
      ? bucket.messages[bucket.messages.length - 1].seq
      : since;

  return jsonNoStore({ messages, cursor }, { headers: rateHeaders });
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  const clientIp = getClientIp(request);
  const rateLimit = signalPostRateLimiter.check(clientIp);
  const rateHeaders = buildRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "rate_limit_exceeded",
      status: 429,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      {
        error: "Too many requests",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      { status: 429, headers: rateHeaders }
    );
  }

  const bodyResult = await readJsonBodyWithByteLimit(request, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: bodyResult.status === 413 ? "payload_too_large" : "invalid_body",
      status: bodyResult.status,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      { error: bodyResult.error },
      { status: bodyResult.status, headers: rateHeaders }
    );
  }

  const parsed = signalPostSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "schema_validation_failed",
      status: 400,
      errorClass: "ZodError",
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      { error: "Invalid signal payload" },
      { status: 400, headers: rateHeaders }
    );
  }

  const signal = parsed.data;
  const now = Date.now();
  pruneRooms(now);

  let bucket = rooms.get(signal.room);
  if (!bucket) {
    bucket = { messages: [], lastActive: now, nextSeq: 1 };
    rooms.set(signal.room, bucket);
  }

  const msg: SignalMessage = {
    seq: bucket.nextSeq++,
    from: signal.from,
    to: "to" in signal ? signal.to : undefined,
    type: signal.type,
    payload: "payload" in signal ? signal.payload : undefined,
    name: signal.type === "join" ? signal.name : undefined,
    color: signal.type === "join" ? signal.color : undefined,
    ts: now,
  };

  bucket.messages.push(msg);
  if (bucket.messages.length > MAX_MESSAGES_PER_ROOM) {
    bucket.messages.splice(0, bucket.messages.length - MAX_MESSAGES_PER_ROOM);
  }
  bucket.lastActive = now;

  return jsonNoStore({ ok: true, seq: msg.seq }, { headers: rateHeaders });
}
