import { z } from "zod";
import type { GatewayAuth } from "@/lib/jev/llm-graph-client";
import type { JevModelSource } from "@/lib/jev/types";
import { logServerEvent } from "@/lib/server/logger";

/**
 * Server-side client for TypeSafe AI's System One model (Jev), reached one of two ways:
 * - Vercel AI Gateway, TypeSafe-compatible API (same request/response shape, model "typesafe-ai/jev"):
 *   POST https://ai-gateway.vercel.sh/typesafe/v1/systemone
 *   Docs: https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
 * - TypeSafe directly: POST https://api.typesafe.ai/v1/systemone
 *   Docs: https://docs.typesafe.ai/api/system-one
 */

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  state: string | Record<string, unknown>;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export type TypeSafeErrorCode =
  | "TIMEOUT"
  | "UPSTREAM_HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR";

export class TypeSafeApiError extends Error {
  readonly code: TypeSafeErrorCode;
  readonly status?: number;
  readonly latencyMs: number;

  constructor(code: TypeSafeErrorCode, latencyMs: number, status?: number) {
    super(`TypeSafe upstream error: ${code}`);
    this.name = "TypeSafeApiError";
    this.code = code;
    this.status = status;
    this.latencyMs = latencyMs;
  }
}

export const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const GATEWAY_SYSTEM_ONE_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
export const DEFAULT_GATEWAY_JEV_MODEL = "typesafe-ai/jev";
const DIRECT_JEV_MODEL = "jev-latest";
const TYPESAFE_TIMEOUT_MS = 4500;

export type JevTransport =
  | { via: "gateway"; url: string; token: string; model: string; authMethod: GatewayAuth["method"] }
  | { via: "direct"; url: string; token: string; model: string };

/** The Gateway credential wins so one key covers generation and jev; TYPESAFE_API_KEY is the fallback. */
export function resolveJevTransport(
  gatewayAuth: GatewayAuth | null,
  env: Record<string, string | undefined> = process.env
): JevTransport | null {
  if (gatewayAuth) {
    return {
      via: "gateway",
      url: GATEWAY_SYSTEM_ONE_URL,
      token: gatewayAuth.token,
      model: env.JEV_MODEL?.trim() || DEFAULT_GATEWAY_JEV_MODEL,
      authMethod: gatewayAuth.method,
    };
  }
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (apiKey) return { via: "direct", url: TYPESAFE_SYSTEM_ONE_URL, token: apiKey, model: DIRECT_JEV_MODEL };
  return null;
}

const systemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .optional(),
});

export async function callTypeSafeJev(
  payload: SystemOneRequest,
  transport: JevTransport
): Promise<{ response: SystemOneResponse; latencyMs: number; source: JevModelSource }> {
  const upstream = transport.via;
  const startedAt = performance.now();
  const elapsed = () => Math.max(1, Math.round(performance.now() - startedAt));

  let res: Response;
  try {
    res = await fetch(transport.url, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${transport.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: transport.model,
        state: payload.state,
        questions: payload.questions,
      }),
      signal: AbortSignal.timeout(TYPESAFE_TIMEOUT_MS),
    });
  } catch (err) {
    const latencyMs = elapsed();
    const errName =
      err && typeof err === "object" && "name" in err
        ? String((err as { name: unknown }).name)
        : "Error";
    const isTimeout = errName === "TimeoutError" || errName === "AbortError";
    const code: TypeSafeErrorCode = isTimeout ? "TIMEOUT" : "NETWORK_ERROR";

    logServerEvent("warn", {
      route: "typesafe-client",
      upstream,
      event: "upstream_fetch_failed",
      errorClass: errName,
      errorCode: code,
      latencyMs,
    });
    throw new TypeSafeApiError(code, latencyMs);
  }

  if (!res.ok) {
    const latencyMs = elapsed();
    // Drain body safely without reading/logging potentially sensitive upstream payloads
    try {
      await res.body?.cancel();
    } catch {
      // ignore stream cancel errors
    }
    logServerEvent("warn", {
      route: "typesafe-client",
      upstream,
      event: "upstream_http_error",
      upstreamStatus: res.status,
      errorClass: "TypeSafeApiError",
      errorCode: "UPSTREAM_HTTP_ERROR",
      latencyMs,
    });
    throw new TypeSafeApiError("UPSTREAM_HTTP_ERROR", latencyMs, res.status);
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch (err) {
    const latencyMs = elapsed();
    const errName =
      err && typeof err === "object" && "name" in err
        ? String((err as { name: unknown }).name)
        : "Error";
    const isTimeout = errName === "TimeoutError" || errName === "AbortError";
    const code: TypeSafeErrorCode = isTimeout ? "TIMEOUT" : "INVALID_RESPONSE";

    logServerEvent("warn", {
      route: "typesafe-client",
      upstream,
      event: "upstream_json_parse_failed",
      errorClass: errName,
      errorCode: code,
      latencyMs,
    });
    throw new TypeSafeApiError(code, latencyMs);
  }

  const parsed = systemOneResponseSchema.safeParse(rawJson);
  const latencyMs = elapsed();

  if (!parsed.success) {
    logServerEvent("warn", {
      route: "typesafe-client",
      upstream,
      event: "upstream_schema_mismatch",
      errorClass: "TypeSafeApiError",
      errorCode: "INVALID_RESPONSE",
      latencyMs,
    });
    throw new TypeSafeApiError("INVALID_RESPONSE", latencyMs);
  }

  return {
    response: parsed.data as SystemOneResponse,
    latencyMs,
    source: transport.via === "gateway" ? `gateway:${transport.model}` : "typesafe-jev",
  };
}
