import { z } from "zod";
import { logServerEvent } from "@/lib/server/logger";
import {
  parseSemanticGraphJson,
  type SemanticGraph,
} from "@/lib/jev/semantic-graph";
import {
  validateForkTakesPayload,
  type ForkTakeSpec,
} from "@/lib/jev/fork-engine";

const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const LLM_TIMEOUT_MS = 6500;

function resolveStructuredApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.JEV_LLM_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || "";
}

export function hasStructuredLlmKey(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveStructuredApiKey(env).length > 0;
}

function getStructuredLlmConfig(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string;
  url: string;
  model: string;
} | null {
  const apiKey = resolveStructuredApiKey(env);
  if (!apiKey) return null;
  const rawBase = env.JEV_LLM_BASE_URL?.trim();
  const url =
    rawBase && /^https:\/\//i.test(rawBase) ? rawBase : DEFAULT_LLM_BASE_URL;
  const model = env.JEV_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  return { apiKey, url, model };
}

const chatCompletionSchema = z.object({
  model: z.string().min(1).optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().min(1),
        }),
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

async function requestStructuredJsonFromLlm(params: {
  systemPrompt: string;
  userPayload: Record<string, unknown>;
}): Promise<{
  content: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
} | null> {
  const cfg = getStructuredLlmConfig();
  if (!cfg) return null;

  const startedAt = performance.now();
  const elapsed = () => Math.max(1, Math.round(performance.now() - startedAt));

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.25,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: JSON.stringify(params.userPayload) },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err) {
    const errName =
      err && typeof err === "object" && "name" in err
        ? String((err as { name: unknown }).name)
        : "Error";
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "upstream_fetch_failed",
      errorClass: errName,
      latencyMs: elapsed(),
    });
    return null;
  }

  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // ignore stream cancel errors
    }
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "upstream_http_error",
      upstreamStatus: res.status,
      latencyMs: elapsed(),
    });
    return null;
  }

  let rawJson: unknown;
  try {
    rawJson = await res.json();
  } catch {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "upstream_json_parse_failed",
      latencyMs: elapsed(),
    });
    return null;
  }

  const parsed = chatCompletionSchema.safeParse(rawJson);
  if (!parsed.success) {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "upstream_schema_mismatch",
      latencyMs: elapsed(),
    });
    return null;
  }

  return {
    content: parsed.data.choices[0].message.content,
    model: parsed.data.model ?? cfg.model,
    latencyMs: elapsed(),
    inputTokens: parsed.data.usage?.prompt_tokens,
  };
}

/**
 * Generates a Zod-validated SemanticGraph from an upstream JSON-capable LLM when configured.
 * Returns null on any error or schema failure so callers safely fall back.
 */
export async function generateSemanticGraphWithLlm(params: {
  prompt: string;
  boardGraph?: Record<string, unknown>;
  preferenceSummary?: Record<string, unknown> | null;
}): Promise<{
  graph: SemanticGraph;
  model: string;
  latencyMs: number;
  inputTokens?: number;
} | null> {
  const result = await requestStructuredJsonFromLlm({
    systemPrompt:
      'Return ONLY valid JSON matching {"notation":"architecture"|"flowchart"|"sequence"|"state"|"er","summary":string,"nodes":[{"id":string,"label":string,"sublabel"?:string,"kind":"node"|"diamond"|"database"|"ellipse"|"text","tone"?:"ink"|"terracotta"|"cobalt"|"teal"|"ochre"|"plum"|"slate","layer"?:number}],"edges":[{"from":string,"to":string,"label"?:string,"dashed"?:boolean,"bidirectional"?:boolean}],"groups"?:[{"id":string,"label":string,"nodeIds":string[]}]}. Keep graphs crisp (2-10 nodes).',
    userPayload: {
      task: "generate_semantic_graph",
      prompt: params.prompt,
      ...(params.boardGraph ? { boardGraph: params.boardGraph } : {}),
      ...(params.preferenceSummary
        ? { preferenceSummary: params.preferenceSummary }
        : {}),
    },
  });
  if (!result) return null;

  const validated = parseSemanticGraphJson(result.content);
  if (!validated.ok) {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "semantic_graph_validation_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  return {
    graph: validated.graph,
    model: result.model,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
  };
}

/**
 * Generates 3 Zod-validated distinct architectural Fork takes for the selected subgraph via LLM.
 * Returns null on any error or schema failure so callers safely fall back.
 */
export async function generateForkTakesWithLlm(params: {
  selectedIds: string[];
  boardGraph: Record<string, unknown>;
  preferenceSummary?: Record<string, unknown> | null;
}): Promise<{
  takes: ForkTakeSpec[];
  model: string;
  latencyMs: number;
  inputTokens?: number;
} | null> {
  const result = await requestStructuredJsonFromLlm({
    systemPrompt:
      'Return ONLY valid JSON matching {"takes":[{"archetype":"queue_event_driven"|"cache_read_replica"|"gateway_edge_split"|"resilient_mesh","title":string,"rationale":string,"tradeoffTag":string,"graph":{"notation":"architecture","summary":string,"nodes":[{"id":string,"label":string,"sublabel"?:string,"kind":"node"|"diamond"|"database"|"ellipse"|"text","tone"?:"ink"|"terracotta"|"cobalt"|"teal"|"ochre"|"plum"|"slate"}],"edges":[{"from":string,"to":string,"label"?:string,"dashed"?:boolean}],"groups"?:[{"id":string,"label":string,"nodeIds":string[]}]}}]}. Produce EXACTLY 3 genuinely distinct architectural refactors tailored to the selected nodes.',
    userPayload: {
      task: "fork_architecture",
      selectedIds: params.selectedIds,
      boardGraph: params.boardGraph,
      ...(params.preferenceSummary
        ? { preferenceSummary: params.preferenceSummary }
        : {}),
    },
  });
  if (!result) return null;

  let decoded: unknown;
  try {
    const trimmed = result.content.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : trimmed;
    decoded = JSON.parse(body);
  } catch {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "fork_json_parse_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  const validated = validateForkTakesPayload(decoded);
  if (!validated.ok) {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "fork_takes_validation_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  return {
    takes: validated.takes,
    model: result.model,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
  };
}
