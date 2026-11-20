import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockCallTypeSafeJev = vi.fn();
const mockHasTypeSafeKey = vi.fn();

vi.mock("@/lib/jev/typesafe-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jev/typesafe-client")>();
  return {
    ...actual,
    callTypeSafeJev: (...args: unknown[]) => mockCallTypeSafeJev(...args),
    hasTypeSafeKey: () => mockHasTypeSafeKey(),
  };
});

import { POST } from "@/app/api/jev/decide/route";
import { resetDecideStateForTests } from "@/lib/server/decide-state";

function makeDecideRequest(body: unknown, ip = "198.51.100.50"): NextRequest {
  return new NextRequest("http://localhost/api/jev/decide", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/jev/decide (Blockers 7 & 8 + M1 guardrails)", () => {
  beforeEach(() => {
    mockCallTypeSafeJev.mockReset();
    mockHasTypeSafeKey.mockReset();
    resetDecideStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Blocker 8: labels heuristic fallback honestly and omits fake model probabilities", async () => {
    mockHasTypeSafeKey.mockReturnValue(false);

    // rank_actions
    const rankRes = await POST(
      makeDecideRequest({
        mode: "rank_actions",
        stateSummary: "Nodes: App",
        candidates: [
          {
            id: "c1",
            title: "Add API Gateway",
            subtitle: "Route traffic",
            category: "extend",
          },
          {
            id: "c2",
            title: "Add Postgres",
            subtitle: "Store data",
            category: "extend",
          },
        ],
      })
    );
    expect(rankRes.status).toBe(200);
    expect(rankRes.headers.get("cache-control")).toBe("no-store");
    const rankJson = (await rankRes.json()) as Record<string, unknown>;
    expect(rankJson.source).toBe("heuristic");
    expect(rankJson.isHeuristic).toBe(true);
    expect(rankJson.nextActionProbabilities).toBeNull();
    expect(rankJson.nextActionConfidence).toBeNull();
    expect(rankJson.shouldConnectProb).toBeNull();

    // place_diagram
    const placeRes = await POST(
      makeDecideRequest({
        mode: "place_diagram",
        prompt: "server",
        stateSummary: "Nodes: App",
        classifyPattern: false,
        candidates: [
          {
            id: "viewport_center",
            label: "Center",
            description: "Center slot",
            prior: 0.8,
          },
        ],
        connectTargets: [
          {
            id: "node_app",
            label: "Connect to App",
            description: "Connect App -> server",
            prior: 0.9,
          },
          {
            id: "none",
            label: "Standalone",
            description: "Place independently",
            prior: 0.2,
          },
        ],
      })
    );
    expect(placeRes.status).toBe(200);
    const placeJson = (await placeRes.json()) as Record<string, unknown>;
    expect(placeJson.source).toBe("heuristic");
    expect(placeJson.isHeuristic).toBe(true);
    expect(placeJson.chosenSlotId).toBe("viewport_center");
    expect(placeJson.connectTargetId).toBe("node_app");
    expect(placeJson.slotProbabilities).toBeNull();
    expect(placeJson.slotConfidence).toBeNull();
    expect(placeJson.connectProbabilities).toBeNull();
    expect(placeJson.connectConfidence).toBeNull();
    expect(placeJson.shouldConnectProb).toBeNull();
    expect(placeJson.isFlowIterationProb).toBeNull();

    // classify_prompt
    const classifyRes = await POST(
      makeDecideRequest({
        mode: "classify_prompt",
        prompt: "auth flow",
      })
    );
    expect(classifyRes.status).toBe(200);
    const classifyJson = (await classifyRes.json()) as Record<string, unknown>;
    expect(classifyJson.source).toBe("heuristic");
    expect(classifyJson.isHeuristic).toBe(true);
    expect(classifyJson.confidence).toBeNull();
  });

  it("Blocker 7: caches live TypeSafe responses by normalized request hash to prevent repeat cost burn", async () => {
    mockHasTypeSafeKey.mockReturnValue(true);
    mockCallTypeSafeJev.mockResolvedValue({
      latencyMs: 42,
      response: {
        model: "jev-latest",
        answers: {
          diagram_pattern: {
            type: "choice",
            choice: "auth_flow",
            confidence: 0.91,
            probabilities: { auth_flow: 0.91, custom_flow: 0.09 },
          },
          needs_decision: {
            type: "noul",
            noul: 0.85,
          },
        },
      },
    });

    const res1 = await POST(
      makeDecideRequest(
        { mode: "classify_prompt", prompt: "OAuth   login flow" },
        "198.51.100.60"
      )
    );
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as Record<string, unknown>;
    expect(json1.source).toBe("typesafe-jev");
    expect(json1.isHeuristic).toBe(false);
    expect(json1.pattern).toBe("auth_flow");
    expect(json1.confidence).toBe(0.91);
    expect(mockCallTypeSafeJev).toHaveBeenCalledTimes(1);

    // Equivalent prompt with different spacing/casing hits bounded response cache
    const res2 = await POST(
      makeDecideRequest(
        { mode: "classify_prompt", prompt: "  oauth login   flow " },
        "198.51.100.61"
      )
    );
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as Record<string, unknown>;
    expect(json2.source).toBe("typesafe-jev");
    expect(json2.pattern).toBe("auth_flow");
    expect(json2.cached).toBe(true);
    expect(mockCallTypeSafeJev).toHaveBeenCalledTimes(1);
  });

  it("Blocker 7 + M1: enforces per-IP rate limits (429 + Retry-After) and UTF-8 byte caps (413)", async () => {
    mockHasTypeSafeKey.mockReturnValue(false);

    // Multi-byte UTF-8 > 32 KB (UTF-16 char length < 32768) -> 413
    const hugeUtf8 = JSON.stringify({
      mode: "classify_prompt",
      prompt: "🚀".repeat(10_000),
    });
    const oversizedRes = await POST(
      makeDecideRequest(hugeUtf8, "198.51.100.70")
    );
    expect(oversizedRes.status).toBe(413);
    expect(oversizedRes.headers.get("cache-control")).toBe("no-store");

    // Per-IP burst triggers 429 + Retry-After
    const burstIp = "198.51.100.71";
    let rateLimitedRes: Response | null = null;
    for (let i = 0; i < 35; i++) {
      const res = await POST(
        makeDecideRequest(
          { mode: "classify_prompt", prompt: `flow ${i}` },
          burstIp
        )
      );
      if (res.status === 429) {
        rateLimitedRes = res;
        break;
      }
    }
    expect(rateLimitedRes).not.toBeNull();
    expect(Number(rateLimitedRes?.headers.get("retry-after"))).toBeGreaterThan(
      0
    );
    expect(rateLimitedRes?.headers.get("cache-control")).toBe("no-store");
  });
});
