import { NextRequest } from "next/server";
import { getClientIp, jsonNoStore } from "@/lib/server/http";
import {
  getIceConfigRateLimiter,
  resolveIceConfigFromEnv,
} from "@/lib/server/ice-config";
import { logServerEvent } from "@/lib/server/logger";
import { buildRateLimitHeaders } from "@/lib/server/rate-limit";

const ROUTE = "/api/ice-config";

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const clientIp = getClientIp(request);
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

  const config = resolveIceConfigFromEnv();
  return jsonNoStore(config, { headers: rateHeaders });
}
