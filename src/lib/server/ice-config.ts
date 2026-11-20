import { createHmac } from "node:crypto";
import { z } from "zod";
import { logServerEvent } from "@/lib/server/logger";
import { SlidingWindowRateLimiter } from "@/lib/server/rate-limit";

export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export const TURN_CREDENTIAL_TTL_SECONDS = 600;

const ICE_URL_PATTERN = /^(stuns?|turns?):[^\s]{1,512}$/i;
const STUN_URL_PATTERN = /^stuns?:[^\s]{1,512}$/i;
const TURN_URL_PATTERN = /^turns?:[^\s]{1,512}$/i;

const iceUrlSchema = z.string().trim().regex(ICE_URL_PATTERN);

const iceServerSchema = z.object({
  urls: z.union([iceUrlSchema, z.array(iceUrlSchema).min(1).max(8)]),
  username: z.string().min(1).max(256).optional(),
  credential: z.string().min(1).max(512).optional(),
});

const iceServersArraySchema = z.array(iceServerSchema).min(1).max(16);

export interface ResolvedIceConfig {
  iceServers: RTCIceServer[];
  hasTurn: boolean;
  ttlSeconds?: number;
  expiresAt?: number;
}

export interface CoturnCredentials {
  username: string;
  credential: string;
  expiresAt: number;
}

/**
 * Mints short-lived coturn REST API credentials (RFC/coturn use-auth-secret):
 *   username   = "<unixExpiry>:<peerId>"
 *   credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))
 */
export function mintCoturnCredentials(params: {
  sharedSecret: string;
  peerId: string;
  ttlSeconds?: number;
  nowMs?: number;
}): CoturnCredentials {
  const ttlSeconds = params.ttlSeconds ?? TURN_CREDENTIAL_TTL_SECONDS;
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const expiresAt = nowSec + ttlSeconds;
  const username = `${expiresAt}:${params.peerId}`;
  const credential = createHmac("sha1", params.sharedSecret)
    .update(username, "utf8")
    .digest("base64");
  return { username, credential, expiresAt };
}

function extractStunOnlyEntries(servers: RTCIceServer[]): {
  stunServers: RTCIceServer[];
  droppedTurn: boolean;
} {
  const stunServers: RTCIceServer[] = [];
  let droppedTurn = false;

  for (const entry of servers) {
    const rawUrls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    const stunUrls = rawUrls.filter((u) => STUN_URL_PATTERN.test(u));
    if (stunUrls.length < rawUrls.length) {
      droppedTurn = true;
    }
    if (stunUrls.length > 0) {
      stunServers.push({
        urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls,
      });
    }
  }

  return { stunServers, droppedTurn };
}

function parseIceServersJson(raw: string): RTCIceServer[] | null {
  try {
    const decoded: unknown = JSON.parse(raw);
    const parsed = iceServersArraySchema.safeParse(decoded);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function resolveBaseStunServers(env: NodeJS.ProcessEnv): RTCIceServer[] {
  const rawJson = env.ICE_SERVERS_JSON?.trim();
  if (rawJson) {
    const parsed = parseIceServersJson(rawJson);
    if (parsed) {
      const { stunServers, droppedTurn } = extractStunOnlyEntries(parsed);
      if (droppedTurn) {
        logServerEvent("warn", {
          route: "/api/ice-config",
          event: "static_turn_ignored",
          errorClass: "ConfigValidationError",
        });
      }
      if (stunServers.length > 0) {
        return stunServers;
      }
    } else {
      logServerEvent("warn", {
        route: "/api/ice-config",
        event: "invalid_ice_servers_json",
        errorClass: "ConfigValidationError",
      });
    }
  }

  const publicJson = env.NEXT_PUBLIC_ICE_SERVERS?.trim();
  if (publicJson) {
    const parsed = parseIceServersJson(publicJson);
    if (parsed) {
      const { stunServers } = extractStunOnlyEntries(parsed);
      if (stunServers.length > 0) {
        return stunServers;
      }
    }
  }

  return DEFAULT_STUN_SERVERS;
}

/**
 * Resolves STUN/TURN ICE servers from server environment variables:
 * - Public / unauthenticated callers ALWAYS receive STUN-only servers.
 * - Static TURN_USERNAME / TURN_CREDENTIAL exposure is intentionally disallowed.
 * - Authenticated signaling peers (`auth.peerId` verified against SignalStore)
 *   receive short-lived (~10 min TTL) coturn HMAC-SHA1 credentials when both
 *   `TURN_URLS` (containing turn:/turns: URLs) and `TURN_SHARED_SECRET` are set.
 */
export function resolveIceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  auth?: { peerId: string } | null,
  nowMs?: number
): ResolvedIceConfig {
  const baseStun = resolveBaseStunServers(env);
  const rawTurnUrls = env.TURN_URLS?.trim();

  if (!rawTurnUrls) {
    return {
      iceServers: baseStun,
      hasTurn: false,
    };
  }

  const urls = rawTurnUrls
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const validUrls = urls.filter((u) => ICE_URL_PATTERN.test(u));

  if (validUrls.length === 0) {
    logServerEvent("warn", {
      route: "/api/ice-config",
      event: "invalid_turn_urls",
      errorClass: "ConfigValidationError",
    });
    return {
      iceServers: baseStun,
      hasTurn: false,
    };
  }

  const stunFromTurnEnv = validUrls.filter((u) => STUN_URL_PATTERN.test(u));
  const turnUrls = validUrls.filter((u) => TURN_URL_PATTERN.test(u));

  const servers: RTCIceServer[] = [...baseStun];
  if (stunFromTurnEnv.length > 0) {
    servers.push({
      urls:
        stunFromTurnEnv.length === 1 ? stunFromTurnEnv[0] : stunFromTurnEnv,
    });
  }

  const sharedSecret = env.TURN_SHARED_SECRET?.trim() ?? "";
  if (auth?.peerId && sharedSecret.length > 0 && turnUrls.length > 0) {
    const minted = mintCoturnCredentials({
      sharedSecret,
      peerId: auth.peerId,
      ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS,
      nowMs,
    });
    servers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: minted.username,
      credential: minted.credential,
    });
    return {
      iceServers: servers,
      hasTurn: true,
      ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS,
      expiresAt: minted.expiresAt,
    };
  }

  return {
    iceServers: servers,
    hasTurn: false,
  };
}

let iceConfigLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  maxEntries: 2000,
});

export function getIceConfigRateLimiter(): SlidingWindowRateLimiter {
  return iceConfigLimiter;
}

export function resetIceConfigRateLimiterForTests(): void {
  iceConfigLimiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    maxEntries: 2000,
  });
}
