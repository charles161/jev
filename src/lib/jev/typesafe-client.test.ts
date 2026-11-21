// Charles (21 Nov 2026): Skot needs one credential, the Vercel AI Gateway key (or the deployment's OIDC token),
// for jev decisions as well as generation. The Gateway serves Jev on its TypeSafe-compatible API:
// POST https://ai-gateway.vercel.sh/typesafe/v1/systemone, model "typesafe-ai/jev"
// (https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). TYPESAFE_API_KEY stays as a direct fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callTypeSafeJev,
  resolveJevTransport,
  TypeSafeApiError,
  type JevTransport,
  type SystemOneRequest,
} from "@/lib/jev/typesafe-client";

const SAMPLE_PAYLOAD: SystemOneRequest = {
  state: "WHITEBOARD STATE: secret-prompt-text-never-log",
  questions: {
    intent: {
      type: "choice",
      instructions: "Pick intent",
      criteria: { extend: "Extend flow", connect: "Connect nodes" },
    },
  },
};

const DIRECT: JevTransport = {
  via: "direct",
  url: "https://api.typesafe.ai/v1/systemone",
  token: "dummy-key",
  model: "jev-latest",
};

const GATEWAY: JevTransport = {
  via: "gateway",
  url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  token: "gw-key",
  model: "typesafe-ai/jev",
  authMethod: "api-key",
};

const okBody = (model: string) => ({
  model,
  answers: {
    intent: { type: "choice", choice: "extend", confidence: 0.92, probabilities: { extend: 0.92, connect: 0.08 } },
  },
  usage: { input_tokens: 42, output_tokens: 8 },
});

describe("resolveJevTransport", () => {
  it("routes jev through the AI Gateway with an API key, model typesafe-ai/jev", () => {
    expect(resolveJevTransport({ token: "gw-key", method: "api-key" }, {})).toEqual(GATEWAY);
  });

  it("routes jev through the AI Gateway with the OIDC token", () => {
    expect(resolveJevTransport({ token: "oidc-tok", method: "oidc" }, {})).toEqual({
      ...GATEWAY,
      token: "oidc-tok",
      authMethod: "oidc",
    });
  });

  it("prefers the Gateway over TYPESAFE_API_KEY so one credential is enough", () => {
    const t = resolveJevTransport({ token: "gw-key", method: "api-key" }, { TYPESAFE_API_KEY: "ts-key" });
    expect(t?.via).toBe("gateway");
  });

  it("lets JEV_MODEL pick a pinned Gateway jev version", () => {
    const t = resolveJevTransport({ token: "gw-key", method: "api-key" }, { JEV_MODEL: " typesafe-ai/jev-1.14.0 " });
    expect(t?.model).toBe("typesafe-ai/jev-1.14.0");
  });

  it("falls back to TypeSafe directly with TYPESAFE_API_KEY and no Gateway credential", () => {
    expect(resolveJevTransport(null, { TYPESAFE_API_KEY: "  dummy-key  " })).toEqual(DIRECT);
  });

  it("returns null with no credential at all, or only blank ones", () => {
    expect(resolveJevTransport(null, {})).toBeNull();
    expect(resolveJevTransport(null, { TYPESAFE_API_KEY: "   \t\n " })).toBeNull();
  });
});

describe("callTypeSafeJev (System One over the Gateway or directly)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts to the Gateway's TypeSafe-compatible endpoint with the gateway token and reports source gateway:<model>", async () => {
    const body = { ...okBody("typesafe-ai/jev"), provider_metadata: { gateway: { cost: "0.00001" } } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callTypeSafeJev(SAMPLE_PAYLOAD, GATEWAY);
    expect(result.source).toBe("gateway:typesafe-ai/jev");
    expect(result.response.model).toBe("typesafe-ai/jev");
    expect(result.response.answers).toEqual(body.answers);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(init.headers).toEqual({ Authorization: "Bearer gw-key", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "typesafe-ai/jev",
      state: SAMPLE_PAYLOAD.state,
      questions: SAMPLE_PAYLOAD.questions,
    });
  });

  it("sends POST to TypeSafe directly with model jev-latest and reports source typesafe-jev", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(okBody("jev-latest")), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callTypeSafeJev(SAMPLE_PAYLOAD, DIRECT);
    expect(result.response).toEqual(okBody("jev-latest"));
    expect(result.source).toBe("typesafe-jev");
    expect(result.latencyMs).toBeGreaterThanOrEqual(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ Authorization: "Bearer dummy-key", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "jev-latest",
      state: SAMPLE_PAYLOAD.state,
      questions: SAMPLE_PAYLOAD.questions,
    });
  });

  for (const transport of [GATEWAY, DIRECT]) {
    it(`maps TimeoutError/AbortError to TIMEOUT and fetch failures to NETWORK_ERROR (${transport.via})`, async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" })) as unknown as typeof fetch;
      await expect(callTypeSafeJev(SAMPLE_PAYLOAD, transport)).rejects.toMatchObject({ code: "TIMEOUT" });

      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })) as unknown as typeof fetch;
      await expect(callTypeSafeJev(SAMPLE_PAYLOAD, transport)).rejects.toMatchObject({ code: "TIMEOUT" });

      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED")) as unknown as typeof fetch;
      await expect(callTypeSafeJev(SAMPLE_PAYLOAD, transport)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    });

    for (const status of [401, 503]) {
      it(`cancels the body and logs safe metadata on HTTP ${status} (${transport.via})`, async () => {
        const cancelSpy = vi.fn().mockResolvedValue(undefined);
        globalThis.fetch = vi
          .fn()
          .mockResolvedValue({ ok: false, status, body: { cancel: cancelSpy } }) as unknown as typeof fetch;
        const warnSpy = vi.spyOn(console, "warn");

        await expect(callTypeSafeJev(SAMPLE_PAYLOAD, transport)).rejects.toMatchObject({
          code: "UPSTREAM_HTTP_ERROR",
          status,
        });
        expect(cancelSpy).toHaveBeenCalledTimes(1);

        const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain(`"upstreamStatus":${status}`);
        expect(logged).toContain(`"upstream":"${transport.via}"`);
        expect(logged).not.toContain(transport.token);
        expect(logged).not.toContain("secret-prompt-text-never-log");
      });
    }
  }

  it("throws INVALID_RESPONSE on malformed JSON or schema mismatch, and TIMEOUT if body read aborts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("not-json{{{", { status: 200 })) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD, GATEWAY)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ model: "", answers: {} }), { status: 200 })) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD, GATEWAY)).rejects.toBeInstanceOf(TypeSafeApiError);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(Object.assign(new Error("stream timeout"), { name: "AbortError" })),
    }) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD, GATEWAY)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("isJevModelSource", () => {
  it("treats direct TypeSafe and any Gateway jev model as a live jev source", async () => {
    const { isJevModelSource } = await import("@/lib/jev/types");
    expect(isJevModelSource("typesafe-jev")).toBe(true);
    expect(isJevModelSource("gateway:typesafe-ai/jev")).toBe(true);
    expect(isJevModelSource("llm-json")).toBe(false);
    expect(isJevModelSource("heuristic")).toBe(false);
    expect(isJevModelSource(undefined)).toBe(false);
  });
});
