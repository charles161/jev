import { z } from "zod";
import { logServerEvent } from "@/lib/server/logger";
import { SlidingWindowRateLimiter } from "@/lib/server/rate-limit";

export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const ICE_URL_PATTERN = /^(stuns?|turns?):[^\s]{1,512}$/i;

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
}

function serverListHasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => /^turns?:/i.test(u));
  });
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

/**
 * Resolves STUN/TURN ICE servers dynamically from server environment variables:
 * 1. `ICE_SERVERS_JSON`: JSON array of RTCIceServer objects
 * 2. `TURN_URLS` (+ optional `TURN_USERNAME`, `TURN_CREDENTIAL`), combined with default STUN
 * 3. `NEXT_PUBLIC_ICE_SERVERS`: optional JSON array fallback
 * 4. Safe default Google STUN servers if nothing valid is configured
 */
export function resolveIceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ResolvedIceConfig {
  const rawJson = env.ICE_SERVERS_JSON?.trim();
  if (rawJson) {
    const parsed = parseIceServersJson(rawJson);
    if (parsed) {
      return {
        iceServers: parsed,
        hasTurn: serverListHasTurn(parsed),
      };
    }
    logServerEvent("warn", {
      route: "/api/ice-config",
      event: "invalid_ice_servers_json",
      errorClass: "ConfigValidationError",
    });
  }

  const rawTurnUrls = env.TURN_URLS?.trim();
  if (rawTurnUrls) {
    const urls = rawTurnUrls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    const validUrls = urls.filter((u) => ICE_URL_PATTERN.test(u));
    if (validUrls.length > 0) {
      const username = env.TURN_USERNAME?.trim() || undefined;
      const credential = env.TURN_CREDENTIAL?.trim() || undefined;
      const turnEntry: RTCIceServer = {
        urls: validUrls.length === 1 ? validUrls[0] : validUrls,
        ...(username ? { username } : {}),
        ...(credential ? { credential } : {}),
      };
      const servers: RTCIceServer[] = [...DEFAULT_STUN_SERVERS, turnEntry];
      return {
        iceServers: servers,
        hasTurn: serverListHasTurn(servers),
      };
    }
    logServerEvent("warn", {
      route: "/api/ice-config",
      event: "invalid_turn_urls",
      errorClass: "ConfigValidationError",
    });
  }

  const publicJson = env.NEXT_PUBLIC_ICE_SERVERS?.trim();
  if (publicJson) {
    const parsed = parseIceServersJson(publicJson);
    if (parsed) {
      return {
        iceServers: parsed,
        hasTurn: serverListHasTurn(parsed),
      };
    }
  }

  return {
    iceServers: DEFAULT_STUN_SERVERS,
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
