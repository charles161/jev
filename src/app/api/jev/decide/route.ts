import { NextRequest } from "next/server";
import { z } from "zod";
import {
  callTypeSafeJev,
  ChoiceAnswer,
  hasTypeSafeKey,
  NoulAnswer,
  SystemOneQuestion,
  TypeSafeApiError,
} from "@/lib/jev/typesafe-client";
import {
  getClientIp,
  jsonNoStore,
  readJsonBodyWithByteLimit,
} from "@/lib/server/http";
import { classifyServerError, logServerEvent } from "@/lib/server/logger";
import {
  buildRateLimitHeaders,
  SlidingWindowRateLimiter,
} from "@/lib/server/rate-limit";

const ROUTE = "/api/jev/decide";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CANDIDATES = 18;
const MAX_STATE_SUMMARY_FOR_UPSTREAM = 6000;

const decideRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  maxEntries: 2000,
});

const DIAGRAM_PATTERN_CRITERIA: Record<string, string> = {
  webrtc_p2p:
    "Peer-to-peer WebRTC, signaling, STUN/TURN, collaborative whiteboard, or DataChannel sync",
  auth_flow:
    "Authentication, login, OAuth, SSO, JWT, session, or credential verification",
  microservices:
    "Distributed backend, microservices, API gateway, caches, queues, and databases",
  ai_rag:
    "AI agent, LLM pipeline, RAG retrieval, embeddings, vector database, or tool calling",
  ci_cd:
    "CI/CD build, test, staging, deployment, or DevOps release pipeline",
  onboarding_funnel:
    "User onboarding, checkout, conversion funnel, or product journey with drop-offs",
  comparison:
    "Comparing two options, architectures, or trade-offs side by side (X vs Y)",
  custom_flow:
    "Explicit arrow notation or custom list of arbitrary steps/entities",
};

const rankCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(48),
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().max(140).optional().default(""),
    category: z.string().max(24).optional().default("extend"),
  })
  .strict();

const rankActionsSchema = z
  .object({
    mode: z.literal("rank_actions"),
    stateSummary: z.string().max(8000).optional().default(""),
    candidates: z.array(rankCandidateSchema).min(1).max(MAX_CANDIDATES),
  })
  .strict();

const classifyPromptSchema = z
  .object({
    mode: z.literal("classify_prompt"),
    prompt: z.string().trim().min(1).max(1200),
  })
  .strict();

const placementSlotSchema = z
  .object({
    id: z.string().trim().min(1).max(48),
    label: z.string().max(80).optional(),
    description: z.string().trim().min(1).max(280),
    prior: z.number().finite().min(0).max(1).optional().default(0.4),
  })
  .strict();

const connectTargetSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().max(80).optional(),
    description: z.string().trim().min(1).max(280),
    prior: z.number().finite().min(0).max(1).optional().default(0.4),
  })
  .strict();

const placeDiagramSchema = z
  .object({
    mode: z.literal("place_diagram"),
    prompt: z.string().max(1200).optional(),
    stateSummary: z.string().max(8000).optional().default(""),
    classifyPattern: z.boolean().optional().default(false),
    candidates: z.array(placementSlotSchema).min(1).max(10),
    connectTargets: z.array(connectTargetSchema).max(8).optional().default([]),
  })
  .strict();

const decideRequestSchema = z.discriminatedUnion("mode", [
  rankActionsSchema,
  classifyPromptSchema,
  placeDiagramSchema,
]);

type RankCandidate = z.infer<typeof rankCandidateSchema>;

function buildFallbackProbabilities(
  candidates: RankCandidate[]
): Record<string, number> {
  // Decaying calibrated-style prior favoring top geometric candidates
  const weights = candidates.map((_, idx) => Math.exp(-idx * 0.65));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const probs: Record<string, number> = {};
  candidates.forEach((c, idx) => {
    probs[c.id] = Number((weights[idx] / sum).toFixed(3));
  });
  return probs;
}

function buildPriorProbs<T extends { id: string; prior: number }>(
  list: T[]
): Record<string, number> {
  const weights = list.map((s) => Math.exp(s.prior * 3.2));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const probs: Record<string, number> = {};
  list.forEach((s, i) => {
    probs[s.id] = Number((weights[i] / total).toFixed(3));
  });
  return probs;
}

export async function POST(request: NextRequest) {
  const requestStartedAt = performance.now();
  const clientIp = getClientIp(request);
  const rateLimit = decideRateLimiter.check(clientIp);
  const rateHeaders = buildRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "rate_limit_exceeded",
      status: 429,
      latencyMs: Math.max(1, Math.round(performance.now() - requestStartedAt)),
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
      latencyMs: Math.max(1, Math.round(performance.now() - requestStartedAt)),
    });
    return jsonNoStore(
      { error: bodyResult.error },
      { status: bodyResult.status, headers: rateHeaders }
    );
  }

  const parsed = decideRequestSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    logServerEvent("warn", {
      route: ROUTE,
      method: "POST",
      event: "schema_validation_failed",
      status: 400,
      errorClass: "ZodError",
      latencyMs: Math.max(1, Math.round(performance.now() - requestStartedAt)),
    });
    return jsonNoStore(
      { error: "Invalid request payload" },
      { status: 400, headers: rateHeaders }
    );
  }

  const input = parsed.data;

  // MODE 1: Rank candidate next whiteboard actions & classify drag intent in parallel
  if (input.mode === "rank_actions") {
    const stateSummary = input.stateSummary.slice(0, MAX_STATE_SUMMARY_FOR_UPSTREAM);
    const candidates = input.candidates;

    if (!hasTypeSafeKey()) {
      const probs = buildFallbackProbabilities(candidates);
      return jsonNoStore(
        {
          source: "local-fallback",
          model: "local-fallback",
          latencyMs: 2,
          nextActionProbabilities: probs,
          nextActionConfidence: probs[candidates[0].id] ?? 0.65,
          intentChoice: null,
          intentConfidence: null,
          shouldConnectProb: 0.72,
        },
        { headers: rateHeaders }
      );
    }

    try {
      const actionCriteria: Record<string, string> = {};
      for (const c of candidates) {
        actionCriteria[c.id] = `${c.title} — ${c.subtitle}`;
      }

      const { response, latencyMs } = await callTypeSafeJev({
        model: "jev-latest",
        state: stateSummary,
        questions: {
          user_intent: {
            type: "choice",
            instructions:
              "Based on the whiteboard canvas state and the user's most recent move or edit, what structural editing intent best describes what the user is trying to do?",
            criteria: {
              splice_into_edge:
                "Inserting a node directly into the middle of an existing arrow between two nodes",
              open_pipeline_gap:
                "Pulling a connected node away to open room for an intermediate service, cache, or check",
              align_pipeline:
                "Aligning nodes into a horizontal flow or sequential pipeline",
              branch_out:
                "Pulling a node off the main axis to create a parallel branch or decoupled subsystem",
              connect_nearby:
                "Placing a node right next to another unconnected node to link or sync them",
              decision_branch:
                "Splitting a conditional diamond or check into Yes/No or failure outcomes",
              extend_flow:
                "Continuing a system diagram by adding the next logical downstream component",
            },
          },
          next_action: {
            type: "choice",
            instructions:
              "Which concrete next whiteboard action is most helpful and natural for the user to take immediately with Tab + Enter?",
            criteria: actionCriteria,
          },
          should_auto_connect: {
            type: "noul",
            instructions:
              "Does the user's latest canvas action imply connecting or rewiring an arrow right now?",
            criteria: {
              true: "The moved or newly added node should be wired with an arrow to adjacent nodes",
              false:
                "The user is likely grouping, framing, or annotating without adding a new arrow",
            },
          },
        },
      });

      const actionAns = response.answers.next_action as ChoiceAnswer | undefined;
      const intentAns = response.answers.user_intent as ChoiceAnswer | undefined;
      const connectAns = response.answers.should_auto_connect as
        | NoulAnswer
        | undefined;

      return jsonNoStore(
        {
          source: "typesafe-jev",
          model: response.model,
          latencyMs,
          usage: response.usage,
          nextActionProbabilities:
            actionAns?.probabilities ?? buildFallbackProbabilities(candidates),
          nextActionConfidence: actionAns?.confidence ?? 0.5,
          intentChoice: intentAns?.choice ?? null,
          intentConfidence: intentAns?.confidence ?? null,
          shouldConnectProb:
            typeof connectAns?.noul === "number" ? connectAns.noul : null,
        },
        { headers: rateHeaders }
      );
    } catch (err) {
      const classified = classifyServerError(err);
      const latencyMs =
        err instanceof TypeSafeApiError
          ? err.latencyMs
          : Math.max(1, Math.round(performance.now() - requestStartedAt));

      logServerEvent("error", {
        route: ROUTE,
        method: "POST",
        mode: input.mode,
        event: "upstream_fallback",
        status: 200,
        degraded: true,
        latencyMs,
        ...classified,
      });

      const probs = buildFallbackProbabilities(candidates);
      return jsonNoStore(
        {
          source: "local-fallback",
          model: "local-fallback",
          latencyMs: 0,
          nextActionProbabilities: probs,
          nextActionConfidence: probs[candidates[0].id] ?? 0.65,
          intentChoice: null,
          intentConfidence: null,
          shouldConnectProb: null,
          degraded: true,
        },
        { headers: rateHeaders }
      );
    }
  }

  // MODE 2: Classify natural-language whiteboard prompt using Jev Choice + Noul
  if (input.mode === "classify_prompt") {
    if (!hasTypeSafeKey()) {
      return jsonNoStore(
        {
          source: "local-fallback",
          model: "local-fallback",
          latencyMs: 1,
          pattern: null,
          confidence: null,
          needsDecision: false,
        },
        { headers: rateHeaders }
      );
    }

    try {
      const { response, latencyMs } = await callTypeSafeJev({
        model: "jev-latest",
        state: input.prompt,
        questions: {
          diagram_pattern: {
            type: "choice",
            instructions:
              "Which whiteboard diagram archetype best matches the user's description? Choose custom_flow if the user gave explicit arrows or a custom list of steps.",
            criteria: DIAGRAM_PATTERN_CRITERIA,
          },
          needs_decision: {
            type: "noul",
            instructions:
              "Does this prompt describe a conditional check, approval, retry, or yes/no branch?",
          },
        },
      });

      const patternAns = response.answers.diagram_pattern as
        | ChoiceAnswer
        | undefined;
      const decisionAns = response.answers.needs_decision as
        | NoulAnswer
        | undefined;

      return jsonNoStore(
        {
          source: "typesafe-jev",
          model: response.model,
          latencyMs,
          usage: response.usage,
          pattern: patternAns?.choice ?? null,
          confidence: patternAns?.confidence ?? null,
          needsDecision: (decisionAns?.noul ?? 0) >= 0.6,
        },
        { headers: rateHeaders }
      );
    } catch (err) {
      const classified = classifyServerError(err);
      const latencyMs =
        err instanceof TypeSafeApiError
          ? err.latencyMs
          : Math.max(1, Math.round(performance.now() - requestStartedAt));

      logServerEvent("error", {
        route: ROUTE,
        method: "POST",
        mode: input.mode,
        event: "upstream_fallback",
        status: 200,
        degraded: true,
        latencyMs,
        ...classified,
      });

      return jsonNoStore(
        {
          source: "local-fallback",
          model: "local-fallback",
          latencyMs: 0,
          pattern: null,
          confidence: null,
          needsDecision: false,
          degraded: true,
        },
        { headers: rateHeaders }
      );
    }
  }

  // MODE 3: Predict the most probable spatial placement on the whiteboard via Jev
  const stateSummary = input.stateSummary.slice(0, MAX_STATE_SUMMARY_FOR_UPSTREAM);
  const { classifyPattern, candidates: slots, connectTargets } = input;

  const pickFallbackConnect = () => {
    if (connectTargets.length === 0) {
      return {
        connectTargetId: null as string | null,
        connectProbabilities: null as Record<string, number> | null,
        connectConfidence: null as number | null,
        shouldConnectProb: null as number | null,
      };
    }
    const cProbs = buildPriorProbs(connectTargets);
    const sortedC = [...connectTargets].sort(
      (a, b) => (cProbs[b.id] ?? 0) - (cProbs[a.id] ?? 0)
    );
    const bestC = sortedC[0];
    return {
      connectTargetId: bestC.id,
      connectProbabilities: cProbs,
      connectConfidence: cProbs[bestC.id] ?? 0.78,
      shouldConnectProb: bestC.id !== "none" ? 0.88 : 0.2,
    };
  };

  if (!hasTypeSafeKey()) {
    const probs = buildPriorProbs(slots);
    const sorted = [...slots].sort(
      (a, b) => (probs[b.id] ?? 0) - (probs[a.id] ?? 0)
    );
    const best = sorted[0];
    const conn = pickFallbackConnect();
    return jsonNoStore(
      {
        source: "local-fallback",
        model: "local-fallback",
        latencyMs: 2,
        chosenSlotId: best.id,
        slotProbabilities: probs,
        slotConfidence: probs[best.id] ?? 0.72,
        isFlowIterationProb: best.id === "below_previous" ? 0.86 : 0.28,
        ...conn,
        pattern: null,
        needsDecision: false,
      },
      { headers: rateHeaders }
    );
  }

  try {
    const slotCriteria: Record<string, string> = {};
    for (const s of slots) {
      slotCriteria[s.id] = s.description;
    }

    const questions: Record<string, SystemOneQuestion> = {
      placement_slot: {
        type: "choice",
        instructions:
          "Choose the single most probable, predictable, non-overlapping placement slot on the whiteboard for this new diagram. When the user types sequential flows or refines an earlier flow (e.g. 'app -> server' followed by 'app -> gateway -> server'), strongly prefer stacking cleanly below the previous flow so rows align and stay easy to compare. When the visible area is empty, prefer viewport_center.",
        criteria: slotCriteria,
      },
      is_flow_iteration: {
        type: "noul",
        instructions:
          "Is the new prompt a variation, refinement, or next sequential row of the previous flow in view (making vertical stacking below the previous flow the most predictable placement)?",
        criteria: {
          true: "New flow repeats/refines components from the previous flow or is the next sequential row to compare vertically",
          false:
            "New flow is unrelated, or directly continues horizontally from the right end of an existing node",
        },
      },
    };

    if (connectTargets.length > 0) {
      const connectCriteria: Record<string, string> = {};
      for (const ct of connectTargets) {
        connectCriteria[ct.id] = ct.description;
      }
      questions.connect_target = {
        type: "choice",
        instructions:
          "The user is adding a single new component to the whiteboard (e.g. added 'app', then pressed Enter and typed 'server'). Which existing node should it automatically connect from with a thin, cleanly spaced arrow? Strongly prefer the CURRENTLY FOCUSED node when it makes architectural sense, or the most probable upstream node on canvas. Choose 'none' only if the new component is clearly unrelated.",
        criteria: connectCriteria,
      };
      questions.should_connect = {
        type: "noul",
        instructions:
          "Should this newly typed single component automatically connect with an arrow to an existing node on the board right when the user presses Enter?",
        criteria: {
          true: "The component naturally connects downstream from the focused or most probable node on the canvas",
          false: "The component is completely unrelated and should float standalone",
        },
      };
    }

    if (classifyPattern) {
      questions.diagram_pattern = {
        type: "choice",
        instructions:
          "Which whiteboard diagram archetype best matches the user's description? Choose custom_flow if the user gave explicit arrows or a custom list of steps.",
        criteria: DIAGRAM_PATTERN_CRITERIA,
      };
      questions.needs_decision = {
        type: "noul",
        instructions:
          "Does this prompt describe a conditional check, approval, retry, or yes/no branch?",
      };
    }

    const { response, latencyMs } = await callTypeSafeJev({
      model: "jev-latest",
      state: stateSummary,
      questions,
    });

    const slotAns = response.answers.placement_slot as ChoiceAnswer | undefined;
    const iterAns = response.answers.is_flow_iteration as NoulAnswer | undefined;
    const connectAns = response.answers.connect_target as
      | ChoiceAnswer
      | undefined;
    const shouldConnAns = response.answers.should_connect as
      | NoulAnswer
      | undefined;
    const patternAns = response.answers.diagram_pattern as
      | ChoiceAnswer
      | undefined;
    const decisionAns = response.answers.needs_decision as
      | NoulAnswer
      | undefined;

    const probs = slotAns?.probabilities ?? buildPriorProbs(slots);
    let chosenSlotId =
      slotAns?.choice && slots.some((s) => s.id === slotAns.choice)
        ? slotAns.choice
        : slots[0].id;

    // Reinforce vertical predictability when Jev strongly detects a flow iteration
    // and below_previous is available with meaningful probability
    const isIterProb = typeof iterAns?.noul === "number" ? iterAns.noul : null;
    if (
      isIterProb !== null &&
      isIterProb >= 0.72 &&
      slots.some((s) => s.id === "below_previous") &&
      (probs.below_previous ?? 0) >= 0.22
    ) {
      chosenSlotId = "below_previous";
    }

    let connectTargetId: string | null = null;
    let connectProbabilities: Record<string, number> | null = null;
    let connectConfidence: number | null = null;
    const shouldConnectProb =
      typeof shouldConnAns?.noul === "number" ? shouldConnAns.noul : null;

    if (connectTargets.length > 0) {
      connectProbabilities =
        connectAns?.probabilities ?? buildPriorProbs(connectTargets);
      connectTargetId =
        connectAns?.choice &&
        connectTargets.some((c) => c.id === connectAns.choice)
          ? connectAns.choice
          : connectTargets[0].id;

      if (shouldConnectProb !== null && shouldConnectProb < 0.35) {
        connectTargetId = "none";
      }
      connectConfidence =
        connectProbabilities[connectTargetId] ?? connectAns?.confidence ?? 0.68;
    }

    return jsonNoStore(
      {
        source: "typesafe-jev",
        model: response.model,
        latencyMs,
        usage: response.usage,
        chosenSlotId,
        slotProbabilities: probs,
        slotConfidence: probs[chosenSlotId] ?? slotAns?.confidence ?? 0.6,
        isFlowIterationProb: isIterProb,
        connectTargetId,
        connectProbabilities,
        connectConfidence,
        shouldConnectProb,
        pattern: patternAns?.choice ?? null,
        needsDecision: (decisionAns?.noul ?? 0) >= 0.6,
      },
      { headers: rateHeaders }
    );
  } catch (err) {
    const classified = classifyServerError(err);
    const latencyMs =
      err instanceof TypeSafeApiError
        ? err.latencyMs
        : Math.max(1, Math.round(performance.now() - requestStartedAt));

    logServerEvent("error", {
      route: ROUTE,
      method: "POST",
      mode: input.mode,
      event: "upstream_fallback",
      status: 200,
      degraded: true,
      latencyMs,
      ...classified,
    });

    const probs = buildPriorProbs(slots);
    const sorted = [...slots].sort(
      (a, b) => (probs[b.id] ?? 0) - (probs[a.id] ?? 0)
    );
    const best = sorted[0];
    const conn = pickFallbackConnect();
    return jsonNoStore(
      {
        source: "local-fallback",
        model: "local-fallback",
        latencyMs: 0,
        chosenSlotId: best.id,
        slotProbabilities: probs,
        slotConfidence: probs[best.id] ?? 0.7,
        isFlowIterationProb: null,
        ...conn,
        pattern: null,
        needsDecision: false,
        degraded: true,
      },
      { headers: rateHeaders }
    );
  }
}
