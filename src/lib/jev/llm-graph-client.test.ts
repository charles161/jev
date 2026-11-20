import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateForkTakesWithLlm,
  generateSemanticGraphWithLlm,
  hasStructuredLlmKey,
} from "@/lib/jev/llm-graph-client";

describe("llm-graph-client: structured JSON graph generation & safe fallback", () => {
  const originalLlmKey = process.env.JEV_LLM_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.JEV_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalLlmKey === undefined) delete process.env.JEV_LLM_API_KEY;
    else process.env.JEV_LLM_API_KEY = originalLlmKey;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("detects JEV_LLM_API_KEY or OPENAI_API_KEY cleanly", () => {
    expect(hasStructuredLlmKey()).toBe(false);
    process.env.JEV_LLM_API_KEY = "   ";
    expect(hasStructuredLlmKey()).toBe(false);
    process.env.OPENAI_API_KEY = "dummy-key";
    expect(hasStructuredLlmKey()).toBe(true);
  });

  it("validates structured SemanticGraph JSON from upstream LLM and falls back to null on invalid/poisoned JSON", async () => {
    process.env.JEV_LLM_API_KEY = "dummy-graph";

    const validGraphJson = JSON.stringify({
      notation: "architecture",
      summary: "Search Indexing Pipeline",
      nodes: [
        { id: "doc", label: "Doc API", kind: "node" },
        { id: "q", label: "Index Queue", kind: "node" },
        { id: "es", label: "Search Index", kind: "database" },
      ],
      edges: [
        { from: "doc", to: "q", label: "enqueue", dashed: true },
        { from: "q", to: "es", label: "index" },
      ],
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o-mini",
          choices: [{ message: { content: validGraphJson } }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const okRes = await generateSemanticGraphWithLlm({
      prompt: "search indexing pipeline",
    });
    expect(okRes).not.toBeNull();
    expect(okRes!.graph.nodes).toHaveLength(3);
    expect(okRes!.model).toBe("gpt-4o-mini");

    // Malformed / invalid schema JSON -> returns null safely without throwing
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o-mini",
          choices: [{ message: { content: '{"nodes": "not-an-array"}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const badRes = await generateSemanticGraphWithLlm({
      prompt: "bad response",
    });
    expect(badRes).toBeNull();
  });

  it("validates 3 structured Fork takes from upstream LLM and rejects partial/invalid payloads", async () => {
    process.env.JEV_LLM_API_KEY = "dummy-fork";

    const validTakes = {
      takes: [
        {
          archetype: "queue_event_driven",
          title: "Async Queue",
          rationale: "Decouples bursts via durable queue",
          tradeoffTag: "Eventual consistency",
          graph: {
            notation: "architecture",
            summary: "Async Queue",
            nodes: [
              { id: "a", label: "API", kind: "node" },
              { id: "q", label: "Queue", kind: "node" },
            ],
            edges: [{ from: "a", to: "q", label: "publish", dashed: true }],
          },
        },
        {
          archetype: "cache_read_replica",
          title: "Cache-First",
          rationale: "Cuts read p99 latency with Redis",
          tradeoffTag: "Cache invalidation",
          graph: {
            notation: "architecture",
            summary: "Cache-First",
            nodes: [
              { id: "a", label: "API", kind: "node" },
              { id: "c", label: "Redis", kind: "database" },
            ],
            edges: [{ from: "a", to: "c", label: "read" }],
          },
        },
        {
          archetype: "gateway_edge_split",
          title: "Edge Gateway",
          rationale: "Isolates edge auth and rate limits",
          tradeoffTag: "Extra hop",
          graph: {
            notation: "architecture",
            summary: "Edge Gateway",
            nodes: [
              { id: "g", label: "Gateway", kind: "node" },
              { id: "a", label: "API", kind: "node" },
            ],
            edges: [{ from: "g", to: "a", label: "route" }],
          },
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o-mini",
          choices: [{ message: { content: JSON.stringify(validTakes) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const okFork = await generateForkTakesWithLlm({
      selectedIds: ["sel_1"],
      boardGraph: { version: 1 },
    });
    expect(okFork).not.toBeNull();
    expect(okFork!.takes).toHaveLength(3);

    // Non-2xx upstream status -> drains body and returns null
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      body: { cancel: cancelSpy },
    }) as unknown as typeof fetch;

    const failedFork = await generateForkTakesWithLlm({
      selectedIds: ["sel_1"],
      boardGraph: { version: 1 },
    });
    expect(failedFork).toBeNull();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
