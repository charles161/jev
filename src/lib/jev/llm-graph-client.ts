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
import {
  validateMorphSemanticSpec,
  type MorphNotation,
  type MorphSemanticSpec,
} from "@/lib/jev/notation-morph";
import {
  validateTalkToDrawLlmResult,
  type TalkToDrawLlmResult,
} from "@/lib/jev/talk-to-draw";

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

function parseJsonBody(content: string): unknown {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;
  return JSON.parse(body);
}

/**
 * Refines a MorphSemanticSpec via structured JSON LLM for reversible Notation Morph.
 * Returns null on any upstream error or Zod validation failure so callers safely fall back.
 */
export async function generateMorphSpecWithLlm(params: {
  targetNotation: MorphNotation;
  selectedIds: string[];
  boardGraph: Record<string, unknown>;
  currentSpec?: MorphSemanticSpec;
}): Promise<{
  spec: MorphSemanticSpec;
  model: string;
  latencyMs: number;
  inputTokens?: number;
} | null> {
  const result = await requestStructuredJsonFromLlm({
    systemPrompt:
      'Return ONLY valid JSON matching {"summary":string,"actors":[{"id":string,"label":string,"kind"?:"node"|"diamond"|"database"|"ellipse"|"text","tone"?:"ink"|"terracotta"|"cobalt"|"teal"|"ochre"|"plum"|"slate"}],"messages":[{"id":string,"from":string,"to":string,"label":string,"order":number,"async"?:boolean,"isReturn"?:boolean}],"steps":[{"id":string,"label":string,"kind":"start"|"process"|"decision"|"end","tone"?:string,"branches"?:[{"to":string,"label"?:string,"fallback"?:boolean}]}],"states":[{"id":string,"label":string,"initial"?:boolean,"terminal"?:boolean,"tone"?:string}],"transitions":[{"id":string,"from":string,"to":string,"event":string,"fallback"?:boolean}],"entities":[{"id":string,"name":string,"attributes":string[],"tone"?:string}],"relations":[{"id":string,"from":string,"to":string,"cardinality":string,"label"?:string}]}. Keep semantic IDs aligned with the selected nodes so round-tripping preserves edits.',
    userPayload: {
      task: "morph_notation",
      targetNotation: params.targetNotation,
      selectedIds: params.selectedIds,
      boardGraph: params.boardGraph,
      ...(params.currentSpec ? { currentSpec: params.currentSpec } : {}),
    },
  });
  if (!result) return null;

  let decoded: unknown;
  try {
    decoded = parseJsonBody(result.content);
  } catch {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "morph_json_parse_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  const validated = validateMorphSemanticSpec(decoded);
  if (!validated.ok) {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "morph_spec_validation_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  return {
    spec: validated.spec,
    model: result.model,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
  };
}

/**
 * Interprets a stroke-synchronized spoken utterance via structured JSON LLM for Talk-to-Draw.
 * Returns null on any error or Zod validation failure so callers fall back cleanly.
 */
export async function generateTalkToDrawSpecWithLlm(params: {
  utterance: string;
  activeStroke?: Record<string, unknown> | null;
  boardGraph: Record<string, unknown>;
}): Promise<{
  result: TalkToDrawLlmResult;
  model: string;
  latencyMs: number;
  inputTokens?: number;
} | null> {
  const result = await requestStructuredJsonFromLlm({
    systemPrompt:
      'Return ONLY valid JSON matching {"strokeLabel":string,"summary":string,"shapeKindHint"?:"node"|"diamond"|"database"|"ellipse","targetNodes":[{"label":string,"kind":"node"|"diamond"|"database"|"ellipse"|"text","tone"?:"ink"|"terracotta"|"cobalt"|"teal"|"ochre"|"plum"|"slate","edgeLabel"?:string,"dashed"?:boolean}]}. Given the stroke just drawn and the spoken phrase, return a concise label for the stroke and 0-3 ghosted target nodes to connect at the stroke head.',
    userPayload: {
      task: "talk_to_draw",
      utterance: params.utterance,
      activeStroke: params.activeStroke ?? null,
      boardGraph: params.boardGraph,
    },
  });
  if (!result) return null;

  let decoded: unknown;
  try {
    decoded = parseJsonBody(result.content);
  } catch {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "talk_to_draw_json_parse_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  const validated = validateTalkToDrawLlmResult(decoded);
  if (!validated.ok) {
    logServerEvent("warn", {
      route: "llm-graph-client",
      event: "talk_to_draw_validation_failed",
      latencyMs: result.latencyMs,
    });
    return null;
  }

  return {
    result: validated.result,
    model: result.model,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
  };
}
