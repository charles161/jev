// Charles (21 Nov 2026): two AI services, no third key. TypeSafe (TYPESAFE_API_KEY) ranks and classifies;
// TypeSafe cannot generate (https://docs.typesafe.ai/introduction/coding-agents), so generation goes through
// the Vercel AI Gateway, authenticated by AI_GATEWAY_API_KEY or the deployment's OIDC token
// (https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc). OPENAI_API_KEY / JEV_LLM_* are gone.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/jev/decide/route";
import { resetDecideStateForTests } from "@/lib/server/decide-state";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const SRC = join(ROOT, "src");
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const GW_KEY = "gw-test-key-91c2";
const KEY = "ts-test-key-7f3a";
const DECOY = "decoy-second-provider-key";
const KEY_ENV = [
  "TYPESAFE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "AI_GATEWAY_MODEL",
  "JEV_LLM_API_KEY",
  "OPENAI_API_KEY",
  "JEV_UPSTREAM_MAX_PER_MINUTE",
]; 

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

let ipCounter = 0;
function req(body: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/jev/decide", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${ipCounter}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function typeSafeOk(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 120, output_tokens: 0 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function gatewayOk(content: unknown): Response {
  return new Response(
    JSON.stringify({ model: "openai/gpt-4.1-mini", choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const urlOf = (call: unknown[]) => String(call[0]);
const authOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>).Authorization;

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

const boardGraph = (hash: string, nodes: Array<[string, string, string]>, edges: Array<[string, string, string]>) => ({
  version: 1 as const,
  notation: "architecture" as const,
  stats: { totalNodes: nodes.length, totalEdges: edges.length, totalGroups: 0, truncated: false },
  nodes: nodes.map(([id, label, kind], i) => ({ id, label, kind, tone: "cobalt", x: 100 + i * 260, y: 100 })),
  edges: edges.map(([from, to, label], i) => ({ id: `e${i}`, from, to, label })),
  groups: [],
  selectedIds: nodes.map(([id]) => id),
  recentDeltas: [],
  canonicalHash: hash,
});

const graphRequest = (prompt: string) => ({ mode: "generate_graph", prompt });

const forkRequest = (hash: string) => ({
  mode: "fork_architecture",
  selectedIds: ["api", "db"],
  boardGraph: boardGraph(hash, [["api", "Billing API", "node"], ["db", "Billing DB", "database"]], [["api", "db", "write"]]),
});

const graphAnswers = {
  diagram_pattern: { type: "choice", choice: "microservices", confidence: 0.9, probabilities: { microservices: 0.9 } },
  needs_decision: { type: "noul", noul: 0.2 },
};
const forkAnswers = {
  best_fork_take: {
    type: "choice",
    choice: "cache_read_replica",
    confidence: 0.8,
    probabilities: { cache_read_replica: 0.8, queue_event_driven: 0.15, gateway_edge_split: 0.05 },
  },
};

describe("AI keys: TypeSafe ranks, the AI Gateway generates, no third key", () => {
  const saved: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of KEY_ENV) saved[k] = process.env[k];
    for (const k of KEY_ENV) delete process.env[k];
    resetDecideStateForTests();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEY_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("has no OPENAI_API_KEY or JEV_LLM_* left in src, README or .env.example", () => {
    const offenders = [...sourceFiles(SRC), join(ROOT, "README.md"), join(ROOT, ".env.example")]
      .filter((f) => /JEV_LLM_|OPENAI_API_KEY/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(ROOT, ""));
    expect(offenders).toEqual([]);
    expect(existsSync(join(SRC, "lib", "jev", "llm-graph-client.ts"))).toBe(true);
  });

  for (const mode of ["generate_graph", "fork_architecture"] as const) {
    const body = (tag: string) => (mode === "generate_graph" ? graphRequest(`checkout service ${tag}`) : forkRequest(`fork-${tag}`));
    const answers = mode === "generate_graph" ? graphAnswers : forkAnswers;

    it(`${mode} without gateway auth calls only TypeSafe, with the key in a server-side Authorization header`, async () => {
      process.env.TYPESAFE_API_KEY = KEY;
      process.env.OPENAI_API_KEY = DECOY;
      process.env.JEV_LLM_API_KEY = DECOY;
      fetchSpy.mockResolvedValue(typeSafeOk(answers));

      const res = await POST(req(body("live")));
      const text = await res.text();
      const json = JSON.parse(text) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(json.source).toBe("typesafe-jev");
      expect(json.isHeuristic).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TYPESAFE_URL);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      expect(String(init.body)).not.toContain(KEY);
      expect(String(init.body)).not.toContain(DECOY);
      expect(text).not.toContain(KEY);
    });

    for (const [label, failure] of [
      ["4xx", () => Promise.resolve(new Response("{}", { status: 401 }))],
      ["5xx", () => Promise.resolve(new Response("{}", { status: 503 }))],
      ["timeout", () => Promise.reject(timeoutError())],
    ] as const) {
      it(`${mode} falls back to the honest heuristic on a TypeSafe ${label}`, async () => {
        process.env.TYPESAFE_API_KEY = KEY;
        fetchSpy.mockImplementation(failure);

        const res = await POST(req(body(label)));
        const text = await res.text();
        const json = JSON.parse(text) as Record<string, unknown>;

        expect(res.status).toBe(200);
        expect(json.source).toBe("heuristic");
        expect(json.isHeuristic).toBe(true);
        expect(json.degraded).toBe(true);
        if (mode === "generate_graph") expect(json.graph).toBeTruthy();
        else expect(json.recommendedArchetype).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe(TYPESAFE_URL);
        expect(text).not.toContain(KEY);
      });
    }
  }

  const graphJson = {
    notation: "architecture",
    summary: "Checkout",
    nodes: [
      { id: "co", label: "Checkout", kind: "node" },
      { id: "pay", label: "Payment Service", kind: "node" },
    ],
    edges: [{ from: "co", to: "pay", label: "charge" }],
  };

  it("generate_graph uses the AI Gateway with AI_GATEWAY_API_KEY and skips TypeSafe", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    fetchSpy.mockResolvedValue(gatewayOk(graphJson));
    const res = await POST(req(graphRequest("gw api key")));
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json.source).toBe("llm-json");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchSpy.mock.calls[0])).toBe(GATEWAY_URL);
    expect(authOf(fetchSpy.mock.calls[0])).toBe(`Bearer ${GW_KEY}`);
    expect(text).not.toContain(GW_KEY);
  });

  it("generate_graph uses the per-request Vercel OIDC token when there is no gateway key", async () => {
    process.env.VERCEL = "1";
    fetchSpy.mockResolvedValue(gatewayOk(graphJson));
    const res = await POST(req(graphRequest("gw oidc"), { "x-vercel-oidc-token": "oidc-req-token" }));
    expect(((await res.json()) as Record<string, unknown>).source).toBe("llm-json");
    expect(authOf(fetchSpy.mock.calls[0])).toBe("Bearer oidc-req-token");
  });

  it("generate_graph ignores an injected OIDC header off Vercel and stays heuristic", async () => {
    const res = await POST(req(graphRequest("gw injected"), { "x-vercel-oidc-token": "attacker" }));
    expect(((await res.json()) as Record<string, unknown>).source).toBe("heuristic");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back from a failing gateway to TypeSafe, then to the heuristic", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(url === GATEWAY_URL ? new Response("{}", { status: 503 }) : typeSafeOk(graphAnswers))
    );
    const viaTypeSafe = (await (await POST(req(graphRequest("gw down ts up")))).json()) as Record<string, unknown>;
    expect(viaTypeSafe.source).toBe("typesafe-jev");
    expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_URL, TYPESAFE_URL]);

    delete process.env.TYPESAFE_API_KEY;
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(timeoutError());
    const heuristic = (await (await POST(req(graphRequest("gw timeout")))).json()) as Record<string, unknown>;
    expect(heuristic.source).toBe("heuristic");
    expect(heuristic.degraded).toBe(true);
  });

  it("caps gateway calls with JEV_UPSTREAM_MAX_PER_MINUTE", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    process.env.JEV_UPSTREAM_MAX_PER_MINUTE = "1";
    fetchSpy.mockImplementation(() => Promise.resolve(gatewayOk(graphJson)));
    await POST(req(graphRequest("cap one")));
    const capped = (await (await POST(req(graphRequest("cap two")))).json()) as Record<string, unknown>;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capped.source).toBe("heuristic");
    expect(capped.degraded).toBe(true);
  });

  const morphBoard = boardGraph(
    "morph-1",
    [["user", "User", "node"], ["order", "Order", "node"]],
    [["user", "order", "places"]]
  );
  const morphBody = { mode: "morph_notation", targetNotation: "er", selectedIds: ["user", "order"], boardGraph: morphBoard };

  it("morph_notation stays local without gateway auth, even with a TypeSafe key", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.OPENAI_API_KEY = DECOY;
    const json = (await (await POST(req(morphBody))).json()) as Record<string, unknown>;
    expect(json.source).toBe("heuristic");
    expect(json.spec).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("morph_notation refines through the gateway when authenticated", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    fetchSpy.mockResolvedValue(
      gatewayOk({
        summary: "Orders",
        actors: [],
        messages: [],
        steps: [],
        states: [],
        transitions: [],
        entities: [
          { id: "user", name: "User", attributes: ["PK id"] },
          { id: "order", name: "Order", attributes: ["PK id", "FK user_id"] },
        ],
        relations: [{ id: "r1", from: "user", to: "order", cardinality: "1:N" }],
      })
    );
    const json = (await (await POST(req(morphBody))).json()) as Record<string, unknown>;
    expect(json.source).toBe("llm-json");
    expect(urlOf(fetchSpy.mock.calls[0])).toBe(GATEWAY_URL);
  });

  it("the removed talk_to_draw mode is rejected and never calls an AI provider", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    const res = await POST(
      req({ mode: "talk_to_draw", utterance: "this caches the reads", boardGraph: boardGraph("talk-1", [["n1", "API", "node"]], []) })
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const rankFixtures = {
    lonely: { context: { subjectLabel: "Widget", neighborLabels: [] as string[] }, proposal: "Widget Renderer" },
    related: { context: { subjectLabel: "Checkout", neighborLabels: [] as string[], boardTitle: "Shop" }, proposal: "Order Ledger" },
    chain: { context: { subjectLabel: "Error Handler", neighborLabels: ["Checkout"], boardTitle: "Shop" }, proposal: "Payment Retry Worker" },
  };

  for (const [name, fx] of Object.entries(rankFixtures)) {
    const body = (tag: string) => ({
      mode: "rank_actions",
      stateSummary: `${name} ${tag}`,
      context: fx.context,
      candidates: [
        { id: "p1", title: `Add → After ${fx.context.subjectLabel}`, subtitle: "Continue", category: "extend" },
        { id: "p2", title: "Add → Data Store", subtitle: "Persist", category: "extend" },
      ],
    });

    it(`rank_actions (${name}, LLM on): gateway proposes context nodes, TypeSafe ranks them with the rest`, async () => {
      process.env.AI_GATEWAY_API_KEY = GW_KEY;
      process.env.TYPESAFE_API_KEY = KEY;
      fetchSpy.mockImplementation((url: string) =>
        Promise.resolve(
          url === GATEWAY_URL
            ? gatewayOk({ suggestions: [{ label: fx.proposal, kind: "node", edgeLabel: "next" }] })
            : typeSafeOk({
                user_intent: { type: "choice", choice: "extend_flow", confidence: 0.7, probabilities: { extend_flow: 0.7 } },
                next_action: { type: "choice", choice: "ctx_0", confidence: 0.6, probabilities: { ctx_0: 0.6, p1: 0.3, p2: 0.1 } },
                should_auto_connect: { type: "noul", noul: 0.8 },
              })
        )
      );
      const json = (await (await POST(req(body("on")))).json()) as Record<string, unknown>;
      expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_URL, TYPESAFE_URL]);
      const sent = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
      expect(Object.keys(sent.questions.next_action.criteria)).toEqual(["p1", "p2", "ctx_0"]);
      expect(sent.questions.next_action.criteria.ctx_0).toContain(fx.proposal);
      expect(json.source).toBe("typesafe-jev");
      expect(json.contextSuggestions).toEqual([{ id: "ctx_0", label: fx.proposal, kind: "node", edgeLabel: "next" }]);
    });

    it(`rank_actions (${name}, LLM off): TypeSafe ranks the client's candidates and no gateway call happens`, async () => {
      process.env.TYPESAFE_API_KEY = KEY;
      fetchSpy.mockResolvedValue(
        typeSafeOk({
          user_intent: { type: "choice", choice: "extend_flow", confidence: 0.7, probabilities: { extend_flow: 0.7 } },
          next_action: { type: "choice", choice: "p1", confidence: 0.6, probabilities: { p1: 0.6, p2: 0.4 } },
          should_auto_connect: { type: "noul", noul: 0.8 },
        })
      );
      const json = (await (await POST(req(body("off")))).json()) as Record<string, unknown>;
      expect(fetchSpy.mock.calls.map(urlOf)).toEqual([TYPESAFE_URL]);
      expect(json.contextSuggestions).toEqual([]);
    });
  }
});
