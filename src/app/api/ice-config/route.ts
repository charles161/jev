import { NextRequest } from "next/server";
import {
  PEER_TOKEN_PATTERN,
  ROOM_ID_PATTERN,
  ROOM_SECRET_PATTERN,
} from "@/lib/jev/room-auth";
import {
  jsonNoStore,
  resolveClientIpOrMisconfigured,
} from "@/lib/server/http";
import {
  getIceConfigRateLimiter,
  resolveIceConfigFromEnv,
} from "@/lib/server/ice-config";
import { logServerEvent } from "@/lib/server/logger";
import { buildRateLimitHeaders } from "@/lib/server/rate-limit";
import { getDefaultSignalStore } from "@/lib/server/signal-store";

const ROUTE = "/api/ice-config";

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
  const rateLimit = getIceConfigRateLimiter().check(clientIp);
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

  let authenticatedPeer: { peerId: string } | null = null;
  const { searchParams } = new URL(request.url);
  const rawRoom = searchParams.get("room")?.trim() ?? "";
  const roomSecret = extractRoomSecret(request);
  const peerToken = extractPeerToken(request);

  if (rawRoom && ROOM_ID_PATTERN.test(rawRoom) && roomSecret && peerToken) {
    const authRes = getDefaultSignalStore().authenticateRoomPeer({
      room: rawRoom,
      roomSecret,
      peerToken,
    });
    if (authRes.ok) {
      authenticatedPeer = { peerId: authRes.peerId };
    } else {
      logServerEvent("warn", {
        route: ROUTE,
        method: "GET",
        event: "turn_auth_rejected",
        status: authRes.status,
        latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      });
    }
  }

  const config = resolveIceConfigFromEnv(process.env, authenticatedPeer);
  return jsonNoStore(config, { headers: rateHeaders });
}
