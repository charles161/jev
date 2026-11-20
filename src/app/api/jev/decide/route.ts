import { NextRequest, NextResponse } from "next/server";
import {
  callTypeSafeJev,
  ChoiceAnswer,
  hasTypeSafeKey,
  NoulAnswer,
} from "@/lib/jev/typesafe-client";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_CANDIDATES = 18;

interface CandidateInput {
  id: string;
  title: string;
  subtitle: string;
  category: string;
}

function buildFallbackProbabilities(candidates: CandidateInput[]): Record<string, number> {
  // Decaying calibrated-style prior favoring top geometric candidates
  const weights = candidates.map((_, idx) => Math.exp(-idx * 0.65));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const probs: Record<string, number> = {};
  candidates.forEach((c, idx) => {
    probs[c.id] = Number((weights[idx] / sum).toFixed(3));
  });
  return probs;
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (rawText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mode = typeof body.mode === "string" ? body.mode : "rank_actions";

  // MODE 1: Rank candidate next whiteboard actions & classify drag intent in parallel
  if (mode === "rank_actions") {
    const stateSummary =
      typeof body.stateSummary === "string"
        ? body.stateSummary.slice(0, 6000)
        : "";
    const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    const candidates: CandidateInput[] = rawCandidates
      .slice(0, MAX_CANDIDATES)
      .filter(
        (c): c is CandidateInput =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as CandidateInput).id === "string" &&
          typeof (c as CandidateInput).title === "string"
      )
      .map((c) => ({
        id: c.id.slice(0, 48),
        title: c.title.slice(0, 120),
        subtitle: typeof c.subtitle === "string" ? c.subtitle.slice(0, 140) : "",
        category: typeof c.category === "string" ? c.category.slice(0, 24) : "extend",
      }));

    if (candidates.length === 0) {
      return NextResponse.json({ error: "No candidate actions provided" }, { status: 400 });
    }

    if (!hasTypeSafeKey()) {
      const probs = buildFallbackProbabilities(candidates);
      return NextResponse.json({
        source: "local-fallback",
        model: "local-fallback",
        latencyMs: 2,
        nextActionProbabilities: probs,
        nextActionConfidence: probs[candidates[0].id] ?? 0.65,
        intentChoice: null,
        intentConfidence: null,
        shouldConnectProb: 0.72,
      });
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
              false: "The user is likely grouping, framing, or annotating without adding a new arrow",
            },
          },
        },
      });

      const actionAns = response.answers.next_action as ChoiceAnswer | undefined;
      const intentAns = response.answers.user_intent as ChoiceAnswer | undefined;
      const connectAns = response.answers.should_auto_connect as NoulAnswer | undefined;

      return NextResponse.json({
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
      });
    } catch {
      const probs = buildFallbackProbabilities(candidates);
      return NextResponse.json({
        source: "local-fallback",
        model: "local-fallback",
        latencyMs: 0,
        nextActionProbabilities: probs,
        nextActionConfidence: probs[candidates[0].id] ?? 0.65,
        intentChoice: null,
        intentConfidence: null,
        shouldConnectProb: null,
        degraded: true,
      });
    }
  }

  // MODE 2: Classify natural-language whiteboard prompt using Jev Choice + Noul
  if (mode === "classify_prompt") {
    const prompt =
      typeof body.prompt === "string" ? body.prompt.slice(0, 1200) : "";
    if (!prompt.trim()) {
      return NextResponse.json({ error: "Empty prompt" }, { status: 400 });
    }

    if (!hasTypeSafeKey()) {
      return NextResponse.json({
        source: "local-fallback",
        model: "local-fallback",
        latencyMs: 1,
        pattern: null,
        confidence: null,
        needsDecision: false,
      });
    }

    try {
      const { response, latencyMs } = await callTypeSafeJev({
        model: "jev-latest",
        state: prompt,
        questions: {
          diagram_pattern: {
            type: "choice",
            instructions:
              "Which whiteboard diagram archetype best matches the user's description? Choose custom_flow if the user gave explicit arrows or a custom list of steps.",
            criteria: {
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
            },
          },
          needs_decision: {
            type: "noul",
            instructions:
              "Does this prompt describe a conditional check, approval, retry, or yes/no branch?",
          },
        },
      });

      const patternAns = response.answers.diagram_pattern as ChoiceAnswer | undefined;
      const decisionAns = response.answers.needs_decision as NoulAnswer | undefined;

      return NextResponse.json({
        source: "typesafe-jev",
        model: response.model,
        latencyMs,
        usage: response.usage,
        pattern: patternAns?.choice ?? null,
        confidence: patternAns?.confidence ?? null,
        needsDecision: (decisionAns?.noul ?? 0) >= 0.6,
      });
    } catch {
      return NextResponse.json({
        source: "local-fallback",
        model: "local-fallback",
        latencyMs: 0,
        pattern: null,
        confidence: null,
        needsDecision: false,
        degraded: true,
      });
    }
  }

  return NextResponse.json({ error: "Unsupported mode" }, { status: 400 });
}
