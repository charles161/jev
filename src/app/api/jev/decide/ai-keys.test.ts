// Charles (21 Nov 2026): one credential. The Vercel AI Gateway, authenticated by AI_GATEWAY_API_KEY or the
// deployment's OIDC token (https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc), serves both
// generation (chat completions) and jev decisions (TypeSafe-compatible API, model typesafe-ai/jev:
// https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). TYPESAFE_API_KEY is an optional direct fallback.
// OPENAI_API_KEY / JEV_LLM_* are gone.
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
const GATEWAY_JEV_URL = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
const GW_KEY = "gw-test-key-91c2";
const KEY = "ts-test-key-7f3a";
const DECOY = "decoy-second-provider-key";
const KEY_ENV = [
  "TYPESAFE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "VERCEL",
  "AI_GATEWAY_MODEL",
  "JEV_MODEL",
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

describe("AI keys: the AI Gateway generates and runs jev, TypeSafe direct is optional", () => {
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

  it("falls back from failing generation to jev on the same Gateway key, then to the heuristic", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(url === GATEWAY_URL ? new Response("{}", { status: 503 }) : typeSafeOk(graphAnswers))
    );
    const viaJev = (await (await POST(req(graphRequest("gw down jev up")))).json()) as Record<string, unknown>;
    expect(viaJev.source).toBe("gateway:typesafe-ai/jev");
    expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_URL, GATEWAY_JEV_URL]);
    expect(authOf(fetchSpy.mock.calls[1])).toBe(`Bearer ${GW_KEY}`);

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

  const reviewBoard = boardGraph(
    "review-1",
    [["api", "Redirect API", "node"], ["db", "Links DB", "database"]],
    [["api", "db", "read"]]
  );
  const reviewBody = (tag: string) => ({
    mode: "practice_review",
    promptId: "url-shortener",
    boardGraph: { ...reviewBoard, canonicalHash: `review-${tag}` },
    rubric: [
      { key: "requirements", score: 0, reason: "No requirements note on the board" },
      { key: "numbers", score: 0, reason: "No figures" },
      { key: "dataModel", score: 1, reason: "A store is named, but no fields or keys" },
      { key: "bottleneck", score: 0, reason: "No cache on the hot path" },
      { key: "tradeoffs", score: 0, reason: "No trade-off written down" },
    ],
    comments: [
      { anchorId: "db", text: "This DB is on every redirect. Where is the cache?" },
      { anchorId: null, text: "No numbers on the board: write DAU and QPS." },
    ],
  });

  it("practice_review stays rule-based without gateway auth, even with a TypeSafe key", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.OPENAI_API_KEY = DECOY;
    const res = await POST(req(reviewBody("local")));
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json.source).toBe("heuristic");
    expect(json.comments).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("practice_review asks the AI Gateway with the key only in the Authorization header", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    fetchSpy.mockResolvedValue(
      gatewayOk({
        comments: [
          { anchorId: "db", text: "Every redirect reads Links DB. Put a cache in front of it." },
          { anchorId: null, text: "Write DAU and peak redirect QPS before drawing more boxes." },
        ],
      })
    );
    const res = await POST(req(reviewBody("gw")));
    const text = await res.text();
    const json = JSON.parse(text) as { source: string; comments: Array<{ anchorId: string | null }> };
    expect(json.source).toBe("llm-json");
    expect(json.comments.map((c) => c.anchorId)).toEqual(["db", null]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchSpy.mock.calls[0])).toBe(GATEWAY_URL);
    expect(authOf(fetchSpy.mock.calls[0])).toBe(`Bearer ${GW_KEY}`);
    const sent = String((fetchSpy.mock.calls[0][1] as RequestInit).body);
    expect(sent).not.toContain(GW_KEY);
    expect(sent).not.toContain(KEY);
    expect(text).not.toContain(GW_KEY);
  });

  it("practice_review drops AI comments pinned to ids not on the board and degrades when too few remain", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    fetchSpy.mockResolvedValue(
      gatewayOk({ comments: [{ anchorId: "made-up", text: "Invented shape." }, { anchorId: "db", text: "Cache it." }] })
    );
    const json = (await (await POST(req(reviewBody("bad-anchor")))).json()) as Record<string, unknown>;
    expect(json.source).toBe("heuristic");
    expect(json.degraded).toBe(true);
    expect(json.comments).toBeNull();
  });

  it("practice_review falls back to the rule-based review on a gateway timeout", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    fetchSpy.mockRejectedValue(timeoutError());
    const json = (await (await POST(req(reviewBody("timeout")))).json()) as Record<string, unknown>;
    expect(json.source).toBe("heuristic");
    expect(json.degraded).toBe(true);
    expect(json.comments).toBeNull();
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

    it(`rank_actions (${name}, LLM on): gateway proposes context nodes, gateway jev ranks them with the rest`, async () => {
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
      expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_URL, GATEWAY_JEV_URL]);
      const sent = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
      expect(sent.model).toBe("typesafe-ai/jev");
      expect(Object.keys(sent.questions.next_action.criteria)).toEqual(["p1", "p2", "ctx_0"]);
      expect(sent.questions.next_action.criteria.ctx_0).toContain(fx.proposal);
      expect(json.source).toBe("gateway:typesafe-ai/jev");
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
  const rankBody = (tag: string) => ({
    mode: "rank_actions",
    stateSummary: `Nodes: Checkout -> Error Handler ${tag}`,
    candidates: [
      { id: "c1", title: "Add Retry Queue", subtitle: "Retry failed payments", category: "extend" },
      { id: "c2", title: "Add Postgres", subtitle: "Store data", category: "extend" },
    ],
  });
  const rankAnswers = {
    user_intent: { type: "choice", choice: "extend_flow", confidence: 0.7, probabilities: { extend_flow: 0.7 } },
    next_action: { type: "choice", choice: "c1", confidence: 0.8, probabilities: { c1: 0.8, c2: 0.2 } },
    should_auto_connect: { type: "noul", noul: 0.9 },
  };
  const gatewayJevOk = (answers: Record<string, unknown>) =>
    new Response(JSON.stringify({ model: "typesafe-ai/jev", answers, usage: { input_tokens: 90, output_tokens: 0 } }), {
      status: 200,
    });

  it("rank_actions with only AI_GATEWAY_API_KEY runs jev through the Gateway and reports source gateway:typesafe-ai/jev", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    fetchSpy.mockResolvedValue(gatewayJevOk(rankAnswers));
    const res = await POST(req(rankBody("gw key")));
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json.source).toBe("gateway:typesafe-ai/jev");
    expect(json.model).toBe("typesafe-ai/jev");
    expect(json.isHeuristic).toBe(false);
    expect(json.nextActionProbabilities).toEqual({ c1: 0.8, c2: 0.2 });
    expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_JEV_URL]);
    expect(authOf(fetchSpy.mock.calls[0])).toBe(`Bearer ${GW_KEY}`);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent.model).toBe("typesafe-ai/jev");
    expect(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).not.toContain(GW_KEY);
    expect(text).not.toContain(GW_KEY);
  });

  it("rank_actions on Vercel with no key uses the per-request OIDC token for jev", async () => {
    process.env.VERCEL = "1";
    fetchSpy.mockResolvedValue(gatewayJevOk(rankAnswers));
    const json = (await (await POST(req(rankBody("oidc"), { "x-vercel-oidc-token": "oidc-req-token" }))).json()) as Record<
      string,
      unknown
    >;
    expect(json.source).toBe("gateway:typesafe-ai/jev");
    expect(urlOf(fetchSpy.mock.calls[0])).toBe(GATEWAY_JEV_URL);
    expect(authOf(fetchSpy.mock.calls[0])).toBe("Bearer oidc-req-token");
  });

  it("JEV_MODEL pins the Gateway jev model and the source says so", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    process.env.JEV_MODEL = "typesafe-ai/jev-1.14.0";
    fetchSpy.mockResolvedValue(gatewayJevOk(rankAnswers));
    const json = (await (await POST(req(rankBody("pinned")))).json()) as Record<string, unknown>;
    expect(json.source).toBe("gateway:typesafe-ai/jev-1.14.0");
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).model).toBe("typesafe-ai/jev-1.14.0");
  });

  it("rank_actions with only TYPESAFE_API_KEY still calls TypeSafe directly", async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    fetchSpy.mockResolvedValue(typeSafeOk(rankAnswers));
    const json = (await (await POST(req(rankBody("direct")))).json()) as Record<string, unknown>;
    expect(json.source).toBe("typesafe-jev");
    expect(fetchSpy.mock.calls.map(urlOf)).toEqual([TYPESAFE_URL]);
    expect(authOf(fetchSpy.mock.calls[0])).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).model).toBe("jev-latest");
  });

  it("rank_actions with no credential stays heuristic and calls nothing", async () => {
    const json = (await (await POST(req(rankBody("none")))).json()) as Record<string, unknown>;
    expect(json.source).toBe("heuristic");
    expect(json.isHeuristic).toBe(true);
    expect(json.nextActionProbabilities).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  for (const [label, failure, reason] of [
    ["401", () => Promise.resolve(new Response("{}", { status: 401 })), "gateway:UPSTREAM_HTTP_ERROR:401"],
    ["5xx", () => Promise.resolve(new Response("{}", { status: 502 })), "gateway:UPSTREAM_HTTP_ERROR:502"],
    ["timeout", () => Promise.reject(timeoutError()), "gateway:TIMEOUT"],
  ] as const) {
    it(`rank_actions falls back to the honest heuristic on a Gateway jev ${label} and says why (${reason})`, async () => {
      process.env.AI_GATEWAY_API_KEY = GW_KEY;
      fetchSpy.mockImplementation(failure);
      const res = await POST(req(rankBody(`fail ${label}`)));
      const text = await res.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(json.source).toBe("heuristic");
      expect(json.isHeuristic).toBe(true);
      expect(json.degraded).toBe(true);
      expect(json.degradedReason).toBe(reason);
      expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_JEV_URL]);
      expect(text).not.toContain(GW_KEY);
    });
  }

  it("classify_prompt runs jev through the Gateway", async () => {
    process.env.AI_GATEWAY_API_KEY = GW_KEY;
    fetchSpy.mockResolvedValue(gatewayJevOk(graphAnswers));
    const json = (await (await POST(req({ mode: "classify_prompt", prompt: "OAuth login flow" }))).json()) as Record<
      string,
      unknown
    >;
    expect(json.source).toBe("gateway:typesafe-ai/jev");
    expect(fetchSpy.mock.calls.map(urlOf)).toEqual([GATEWAY_JEV_URL]);
  });
});
