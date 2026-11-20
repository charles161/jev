import { NextRequest } from "next/server";
import { z } from "zod";
import {
  CREATOR_TOKEN_PATTERN,
  PEER_ID_PATTERN,
  PEER_TOKEN_PATTERN,
  ROOM_ID_PATTERN,
  ROOM_SECRET_PATTERN,
} from "@/lib/jev/room-auth";
import {
  jsonNoStore,
  readJsonBodyWithByteLimit,
  resolveClientIpOrMisconfigured,
} from "@/lib/server/http";
import { logServerEvent } from "@/lib/server/logger";
import { buildRateLimitHeaders } from "@/lib/server/rate-limit";
import {
  getDefaultSignalStore,
  getSignalGetRateLimiter,
  getSignalPostRateLimiter,
} from "@/lib/server/signal-store";

const ROUTE = "/api/signal";
const MAX_BODY_BYTES = 24 * 1024;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const SINCE_PATTERN = /^\d{1,10}$/;

const roomIdSchema = z.string().regex(ROOM_ID_PATTERN);
const peerIdSchema = z.string().regex(PEER_ID_PATTERN);

const signalQuerySchema = z.object({
  room: roomIdSchema,
  peerId: peerIdSchema.optional(),
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
    room: roomIdSchema,
    type: z.literal("join"),
    name: z.string().trim().min(1).max(32).optional(),
    color: z.string().regex(HEX_COLOR_PATTERN).optional(),
    creatorToken: z.string().regex(CREATOR_TOKEN_PATTERN).optional(),
  })
  .strict();

const leaveSignalSchema = z
  .object({
    room: roomIdSchema,
    from: peerIdSchema.optional(),
    type: z.literal("leave"),
  })
  .strict();

const offerSignalSchema = z
  .object({
    room: roomIdSchema,
    from: peerIdSchema.optional(),
    to: peerIdSchema,
    type: z.literal("offer"),
    payload: z.object({
      type: z.literal("offer"),
      sdp: sdpStringSchema,
    }),
  })
  .strict();

const answerSignalSchema = z
  .object({
    room: roomIdSchema,
    from: peerIdSchema.optional(),
    to: peerIdSchema,
    type: z.literal("answer"),
    payload: z.object({
      type: z.literal("answer"),
      sdp: sdpStringSchema,
    }),
  })
  .strict();

const iceSignalSchema = z
  .object({
    room: roomIdSchema,
    from: peerIdSchema.optional(),
    to: peerIdSchema,
    type: z.literal("ice"),
    payload: icePayloadSchema,
  })
  .strict();

const signalPostSchema = z.discriminatedUnion("type", [
  joinSignalSchema,
  leaveSignalSchema,
  offerSignalSchema,
  answerSignalSchema,
  iceSignalSchema,
]);

function extractRoomSecret(request: NextRequest): string | null {
  const headerVal = request.headers.get("x-room-secret")?.trim() ?? "";
  return ROOM_SECRET_PATTERN.test(headerVal) ? headerVal : null;
}

function extractPeerToken(request: NextRequest): string | null {
  const direct = request.headers.get("x-peer-token")?.trim();
  if (direct && PEER_TOKEN_PATTERN.test(direct)) {
    return direct;
  }
  const auth = request.headers.get("authorization")?.trim();
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const bearer = auth.slice(7).trim();
    if (PEER_TOKEN_PATTERN.test(bearer)) {
      return bearer;
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const ipResult = resolveClientIpOrMisconfigured(request, {
    route: ROUTE,
    method: "GET",
  });
  if (!ipResult.ok) return ipResult.response;
  const clientIp = ipResult.ip;
  const rateLimit = getSignalGetRateLimiter().check(clientIp);
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
  const rawPeerId = searchParams.get("peerId");
  const parsedQuery = signalQuerySchema.safeParse({
    room: searchParams.get("room") ?? "",
    ...(rawPeerId !== null ? { peerId: rawPeerId } : {}),
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

  const roomSecret = extractRoomSecret(request);
  const peerToken = extractPeerToken(request);
  if (!roomSecret || !peerToken) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "GET",
      event: "missing_credentials",
      status: 401,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      { error: "Missing room secret or peer token" },
      { status: 401, headers: rateHeaders }
    );
  }

  const { room, peerId, since } = parsedQuery.data;
  const result = getDefaultSignalStore().pollRoom({
    room,
    roomSecret,
    peerToken,
    peerIdHint: peerId,
    since,
  });

  if (!result.ok) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "GET",
      event: "poll_rejected",
      status: result.status,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      {
        error: result.error,
        code: result.code,
        ...(result.epoch ? { epoch: result.epoch } : {}),
      },
      { status: result.status, headers: rateHeaders }
    );
  }

  return jsonNoStore(
    {
      messages: result.messages,
      cursor: result.cursor,
      epoch: result.epoch,
      creatorPeerId: result.creatorPeerId,
      roster: result.roster,
    },
    { headers: rateHeaders }
  );
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  const ipResult = resolveClientIpOrMisconfigured(request, {
    route: ROUTE,
    method: "POST",
  });
  if (!ipResult.ok) return ipResult.response;
  const clientIp = ipResult.ip;
  const rateLimit = getSignalPostRateLimiter().check(clientIp);
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

  const roomSecret = extractRoomSecret(request);
  if (!roomSecret) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "missing_room_secret",
      status: 401,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      { error: "Missing or invalid room secret" },
      { status: 401, headers: rateHeaders }
    );
  }

  const signal = parsed.data;
  const store = getDefaultSignalStore();

  if (signal.type === "join") {
    const joinRes = store.joinRoom({
      room: signal.room,
      roomSecret,
      clientIp,
      name: signal.name,
      color: signal.color,
      creatorToken: signal.creatorToken,
    });

    if (!joinRes.ok) {
      logServerEvent("warn", {
        route: ROUTE,
        method: "POST",
        event: "join_rejected",
        status: joinRes.status,
        latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      });
      const headers = new Headers(rateHeaders);
      if (joinRes.retryAfterSeconds) {
        headers.set("Retry-After", String(joinRes.retryAfterSeconds));
      }
      return jsonNoStore(
        {
          error: joinRes.error,
          code: joinRes.code,
          ...(joinRes.retryAfterSeconds
            ? { retryAfterSeconds: joinRes.retryAfterSeconds }
            : {}),
        },
        { status: joinRes.status, headers }
      );
    }

    return jsonNoStore(
      {
        ok: true,
        seq: joinRes.seq,
        peerId: joinRes.peerId,
        peerToken: joinRes.peerToken,
        epoch: joinRes.epoch,
        creatorPeerId: joinRes.creatorPeerId,
        ...(joinRes.creatorToken ? { creatorToken: joinRes.creatorToken } : {}),
        ...(joinRes.reclaimedCreator ? { reclaimedCreator: true } : {}),
        roster: joinRes.roster,
      },
      { headers: rateHeaders }
    );
  }

  const peerToken = extractPeerToken(request);
  if (!peerToken) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "missing_peer_token",
      status: 401,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      { error: "Missing peer token" },
      { status: 401, headers: rateHeaders }
    );
  }

  const postRes = store.postSignal({
    room: signal.room,
    roomSecret,
    peerToken,
    fromHint: signal.from,
    to: "to" in signal ? signal.to : undefined,
    type: signal.type,
    payload: "payload" in signal ? signal.payload : undefined,
  });

  if (!postRes.ok) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "signal_rejected",
      status: postRes.status,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    return jsonNoStore(
      {
        error: postRes.error,
        code: postRes.code,
        ...(postRes.epoch ? { epoch: postRes.epoch } : {}),
      },
      { status: postRes.status, headers: rateHeaders }
    );
  }

  return jsonNoStore(
    {
      ok: true,
      seq: postRes.seq,
      epoch: postRes.epoch,
    },
    { headers: rateHeaders }
  );
}
