import { z } from "zod";
import { logServerEvent } from "@/lib/server/logger";

/**
 * Server-side client for TypeSafe AI's System One model (Jev).
 * Endpoint: POST https://api.typesafe.ai/v1/systemone
 * Docs: https://docs.typesafe.ai/api/system-one
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
  model?: "jev-latest" | "jev-preview" | "jev-1.14.0" | "jev-1.13.0";
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
  | "MISSING_API_KEY"
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

const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_TIMEOUT_MS = 4500;

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

export function hasTypeSafeKey(): boolean {
  const key = process.env.TYPESAFE_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

export async function callTypeSafeJev(
  payload: SystemOneRequest
): Promise<{ response: SystemOneResponse; latencyMs: number }> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new TypeSafeApiError("MISSING_API_KEY", 0);
  }

  const startedAt = performance.now();
  const elapsed = () => Math.max(1, Math.round(performance.now() - startedAt));

  let res: Response;
  try {
    res = await fetch(TYPESAFE_SYSTEM_ONE_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: payload.model ?? "jev-latest",
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
  };
}
