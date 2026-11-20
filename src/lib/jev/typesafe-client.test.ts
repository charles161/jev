import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callTypeSafeJev,
  hasTypeSafeKey,
  TypeSafeApiError,
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

describe("typesafe-client (TypeSafe System One HTTP client)", () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.TYPESAFE_API_KEY;
    } else {
      process.env.TYPESAFE_API_KEY = originalKey;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("detects TYPESAFE_API_KEY presence accurately while rejecting blank/whitespace keys", () => {
    expect(hasTypeSafeKey()).toBe(false);
    process.env.TYPESAFE_API_KEY = "";
    expect(hasTypeSafeKey()).toBe(false);
    process.env.TYPESAFE_API_KEY = "   \t\n ";
    expect(hasTypeSafeKey()).toBe(false);
    process.env.TYPESAFE_API_KEY = "dummy-key";
    expect(hasTypeSafeKey()).toBe(true);
  });

  it("throws MISSING_API_KEY without calling fetch when key is unset or whitespace", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    process.env.TYPESAFE_API_KEY = "   ";
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      name: "TypeSafeApiError",
      code: "MISSING_API_KEY",
      latencyMs: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends POST request with Bearer auth and defaults model to jev-latest on success", async () => {
    process.env.TYPESAFE_API_KEY = "  dummy-key  ";
    const mockResponseBody = {
      model: "jev-latest",
      answers: {
        intent: {
          type: "choice",
          choice: "extend",
          confidence: 0.92,
          probabilities: { extend: 0.92, connect: 0.08 },
        },
      },
      usage: { input_tokens: 42, output_tokens: 8 },
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callTypeSafeJev(SAMPLE_PAYLOAD);
    expect(result.response).toEqual(mockResponseBody);
    expect(result.latencyMs).toBeGreaterThanOrEqual(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({
      Authorization: "Bearer dummy-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "jev-latest",
      state: SAMPLE_PAYLOAD.state,
      questions: SAMPLE_PAYLOAD.questions,
    });
  });

  it("maps TimeoutError and AbortError to TIMEOUT and generic fetch failures to NETWORK_ERROR", async () => {
    process.env.TYPESAFE_API_KEY = "dummy-key";

    const timeoutErr = Object.assign(new Error("timed out"), {
      name: "TimeoutError",
    });
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutErr) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("cancels upstream body and logs safe metadata (no secrets/prompts) on non-2xx HTTP status", async () => {
    process.env.TYPESAFE_API_KEY = "dummy-key";
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel: cancelSpy },
    }) as unknown as typeof fetch;

    const warnSpy = vi.spyOn(console, "warn");

    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      code: "UPSTREAM_HTTP_ERROR",
      status: 503,
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"upstreamStatus":503');
    expect(logged).not.toContain("dummy-key");
    expect(logged).not.toContain("secret-prompt-text-never-log");
  });

  it("throws INVALID_RESPONSE on malformed JSON or schema mismatch, and TIMEOUT if body read aborts", async () => {
    process.env.TYPESAFE_API_KEY = "dummy-key";

    // Malformed JSON
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not-json{{{", { status: 200 })
    ) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    // Schema mismatch (missing answers / empty model)
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ model: "", answers: {} }), { status: 200 })
    ) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toBeInstanceOf(
      TypeSafeApiError
    );

    // Body read aborts mid-stream
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(
        Object.assign(new Error("stream timeout"), { name: "AbortError" })
      ),
    }) as unknown as typeof fetch;
    await expect(callTypeSafeJev(SAMPLE_PAYLOAD)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});
