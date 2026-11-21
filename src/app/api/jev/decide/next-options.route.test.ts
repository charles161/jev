// next_options: jev ranks the three tiered options with one `choice`; the Gateway LLM names and shapes the
// cluster and full options. Both are optional: no keys means an honest heuristic answer, never a fake one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockCallTypeSafeJev = vi.fn();
const mockResolveJevTransport = vi.fn();
const LIVE_TRANSPORT = { via: "gateway", url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", token: "t", model: "typesafe-ai/jev" };

vi.mock("@/lib/jev/typesafe-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jev/typesafe-client")>();
  return {
    ...actual,
    callTypeSafeJev: (...args: unknown[]) => mockCallTypeSafeJev(...args),
    resolveJevTransport: (...args: unknown[]) => mockResolveJevTransport(...args),
  };
});

import { POST } from "@/app/api/jev/decide/route";
import { resetDecideStateForTests } from "@/lib/server/decide-state";

const body = {
  mode: "next_options",
  trigger: "type",
  text: "apigateway",
  conceptLabel: "API Gateway",
  anchorLabel: "Client Dashboard",
  selectedLabels: [],
  boardLabels: ["Client Dashboard"],
  options: [
    { id: "minimal", title: "API Gateway", description: "Client Dashboard — HTTPS → API Gateway", nodes: 1 },
    { id: "cluster", title: "API Gateway + Auth Service + Core Service", description: "linked from Client Dashboard", nodes: 3 },
    { id: "full", title: "Full API backend", description: "API Gateway, Auth Service, Core Service…", nodes: 9 },
  ],
};

const request = (b: unknown, ip: string) =>
  new NextRequest("http://localhost/api/jev/decide", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(b),
  });

const llmReply = (content: unknown) =>
  new Response(JSON.stringify({ model: "openai/gpt-4.1-mini", choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const graphs = {
  cluster: {
    nodes: [
      { label: "API Gateway", kind: "lb" },
      { label: "Auth Service", kind: "node" },
      { label: "Dashboard BFF", kind: "node" },
    ],
    edges: [
      { from: "Client Dashboard", to: "API Gateway", label: "HTTPS" },
      { from: "API Gateway", to: "Auth Service" },
      { from: "API Gateway", to: "Dashboard BFF" },
    ],
  },
  full: {
    nodes: [
      { label: "API Gateway", kind: "lb" },
      { label: "Auth Service", kind: "node" },
      { label: "Dashboard BFF", kind: "node" },
      { label: "Metrics DB", kind: "database" },
      { label: "Redis Cache", kind: "cache" },
      { label: "Event Bus", kind: "queue" },
    ],
    edges: [
      { from: "API Gateway", to: "Auth Service" },
      { from: "API Gateway", to: "Dashboard BFF" },
      { from: "Dashboard BFF", to: "Metrics DB" },
      { from: "Dashboard BFF", to: "Redis Cache" },
      { from: "Dashboard BFF", to: "Event Bus" },
    ],
  },
};

describe("/api/jev/decide next_options", () => {
  const origKey = process.env.AI_GATEWAY_API_KEY;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    mockCallTypeSafeJev.mockReset();
    mockResolveJevTransport.mockReset();
    resetDecideStateForTests();
    delete process.env.AI_GATEWAY_API_KEY;
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = origKey;
    globalThis.fetch = origFetch;
  });

  it("answers honestly as heuristic with no probabilities and no graphs when no AI is configured", async () => {
    mockResolveJevTransport.mockReturnValue(null);
    const res = await POST(request(body, "198.51.100.201"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ source: "heuristic", isHeuristic: true, probabilities: null, graphs: null });
    expect(mockCallTypeSafeJev).not.toHaveBeenCalled();
  });

  it("ranks the three options with one jev choice and returns validated LLM graphs for (b) and (c)", async () => {
    process.env.AI_GATEWAY_API_KEY = "dummy-next-options";
    mockResolveJevTransport.mockReturnValue(LIVE_TRANSPORT);
    mockCallTypeSafeJev.mockResolvedValue({
      source: "gateway:typesafe-ai/jev",
      latencyMs: 210,
      response: {
        model: "typesafe-ai/jev",
        answers: { next_option: { type: "choice", choice: "minimal", confidence: 0.84, probabilities: { minimal: 0.84, cluster: 0.12, full: 0.04 } } },
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(llmReply(graphs)) as unknown as typeof fetch;

    const res = await POST(request(body, "198.51.100.202"));
    const json = (await res.json()) as {
      source: string;
      isHeuristic: boolean;
      probabilities: Record<string, number>;
      graphs: { cluster: { nodes: Array<{ label: string }> }; full: { nodes: unknown[] } };
      graphModel: string;
    };
    expect(json.source).toBe("gateway:typesafe-ai/jev");
    expect(json.isHeuristic).toBe(false);
    expect(json.probabilities).toEqual({ minimal: 0.84, cluster: 0.12, full: 0.04 });
    expect(json.graphs.cluster.nodes.map((n) => n.label)).toContain("Dashboard BFF");
    expect(json.graphs.full.nodes).toHaveLength(6);
    expect(json.graphModel).toBe("openai/gpt-4.1-mini");

    const [call] = mockCallTypeSafeJev.mock.calls[0] as [{ questions: Record<string, { type: string; criteria: Record<string, string> }> }];
    expect(call.questions.next_option.type).toBe("choice");
    expect(Object.keys(call.questions.next_option.criteria)).toEqual(["minimal", "cluster", "full"]);
    const llmBody = JSON.parse(((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string }).body);
    expect(JSON.stringify(llmBody)).toContain("Client Dashboard");
  });

  it("drops a malformed LLM answer but still returns the jev ranking", async () => {
    process.env.AI_GATEWAY_API_KEY = "dummy-next-options-bad";
    mockResolveJevTransport.mockReturnValue(LIVE_TRANSPORT);
    mockCallTypeSafeJev.mockResolvedValue({
      source: "gateway:typesafe-ai/jev",
      latencyMs: 90,
      response: { model: "typesafe-ai/jev", answers: { next_option: { type: "choice", choice: "full", confidence: 0.5, probabilities: { minimal: 0.2, cluster: 0.3, full: 0.5 } } } },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(llmReply({ cluster: { nodes: [{ label: "X", kind: "pentagon" }], edges: [] } })) as unknown as typeof fetch;
    const res = await POST(request({ ...body, text: "api gw" }, "198.51.100.203"));
    const json = (await res.json()) as { probabilities: Record<string, number>; graphs: unknown };
    expect(json.probabilities.full).toBe(0.5);
    expect(json.graphs).toBeNull();
  });

  it("requires exactly three options, one per tier", async () => {
    mockResolveJevTransport.mockReturnValue(null);
    const res = await POST(request({ ...body, options: body.options.slice(0, 2) }, "198.51.100.204"));
    expect(res.status).toBe(400);
  });
});
