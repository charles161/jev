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

const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

export function hasTypeSafeKey(): boolean {
  const key = process.env.TYPESAFE_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

export async function callTypeSafeJev(
  payload: SystemOneRequest
): Promise<{ response: SystemOneResponse; latencyMs: number }> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is not configured");
  }

  const startedAt = performance.now();
  const res = await fetch(TYPESAFE_SYSTEM_ONE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: payload.model ?? "jev-latest",
      state: payload.state,
      questions: payload.questions,
    }),
    signal: AbortSignal.timeout(4500),
  });

  if (!res.ok) {
    throw new Error(`TypeSafe Jev API responded with HTTP ${res.status}`);
  }

  const data = (await res.json()) as SystemOneResponse;
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  return { response: data, latencyMs };
}
