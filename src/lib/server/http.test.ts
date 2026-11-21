import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getIceConfig } from "@/app/api/ice-config/route";
import { GET as getSignal, POST as postSignal } from "@/app/api/signal/route";
import { POST as postDecide } from "@/app/api/jev/decide/route";
import { resetDecideStateForTests } from "@/lib/server/decide-state";
import {
  getClientIp,
  getTrustProxyMode,
  jsonNoStore,
  ProxyConfigError,
  readJsonBodyWithByteLimit,
} from "@/lib/server/http";
import { resetIceConfigRateLimiterForTests } from "@/lib/server/ice-config";
import { resetDefaultSignalStoreForTests } from "@/lib/server/signal-store";

const VALID_SECRET = `secr_http_test_${"s".repeat(22)}`;

describe("Review (a): TRUST_PROXY & anti-IP-spoofing in getClientIp", () => {
  const origTrustProxy = process.env.TRUST_PROXY;

  beforeEach(() => {
    delete process.env.TRUST_PROXY;
    resetDefaultSignalStoreForTests();
    resetDecideStateForTests();
  });

  afterEach(() => {
    if (origTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = origTrustProxy;
    }
  });

  it("ignores X-Forwarded-For and CF-Connecting-IP under default TRUST_PROXY=none", () => {
    const req1 = new NextRequest("http://localhost/api/signal", {
      headers: {
        "x-forwarded-for": "203.0.113.10",
        "cf-connecting-ip": "198.51.100.10",
      },
    });
    const req2 = new NextRequest("http://localhost/api/signal", {
      headers: {
        "x-forwarded-for": "203.0.113.99",
        "cf-connecting-ip": "198.51.100.99",
      },
    });

    // Neither spoofed header splits buckets under TRUST_PROXY=none
    expect(getClientIp(req1)).toBe(getClientIp(req2));
    expect(getClientIp(req1)).not.toBe("203.0.113.10");
    expect(getClientIp(req1)).not.toBe("198.51.100.10");
  });

  it("trusts CF-Connecting-IP ONLY under TRUST_PROXY=cloudflare and ignores X-Forwarded-For", () => {
    process.env.TRUST_PROXY = "cloudflare";
    const req = new NextRequest("http://localhost/api/signal", {
      headers: {
        "x-forwarded-for": "203.0.113.10, 10.0.0.1",
        "cf-connecting-ip": "198.51.100.42",
      },
    });
    expect(getClientIp(req)).toBe("198.51.100.42");

    // Without CF-Connecting-IP, spoofed X-Forwarded-For is still ignored
    const spoofedOnly = new NextRequest("http://localhost/api/signal", {
      headers: {
        "x-forwarded-for": "203.0.113.55",
      },
    });
    expect(getClientIp(spoofedOnly)).not.toBe("203.0.113.55");
  });

  it("blocks spoofed X-Forwarded-For rotation from bypassing /api/signal per-IP room cap", async () => {
    // Default TRUST_PROXY=none: rotating X-Forwarded-For must NOT allow creating more than the 20-room quota
    for (let i = 0; i < 20; i += 1) {
      const res = await postSignal(
        new NextRequest("http://localhost/api/signal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-room-secret": VALID_SECRET,
            "x-forwarded-for": `203.0.113.${i + 1}`,
          },
          body: JSON.stringify({
            room: `room_SpoofAttempt_${String(i).padStart(12, "0")}`,
            type: "join",
          }),
        })
      );
      expect(res.status).toBe(200);
    }

    // 21st room with a brand-new spoofed X-Forwarded-For MUST be rejected with 429
    const over = await postSignal(
      new NextRequest("http://localhost/api/signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-secret": VALID_SECRET,
          "x-forwarded-for": "203.0.113.250",
        },
        body: JSON.stringify({
          room: "room_SpoofAttempt_000000000099",
          type: "join",
        }),
      })
    );
    expect(over.status).toBe(429);
    expect((await over.json()).code).toBe("ip_room_limit");
  });

  it("blocks spoofed X-Forwarded-For rotation from bypassing /api/jev/decide rate limits", async () => {
    let hitRateLimit = false;
    for (let i = 0; i < 35; i += 1) {
      const res = await postDecide(
        new NextRequest("http://localhost/api/jev/decide", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${(i % 250) + 1}`,
          },
          body: JSON.stringify({
            mode: "classify_prompt",
            prompt: `spoof test ${i}`,
          }),
        })
      );
      if (res.status === 429) {
        hitRateLimit = true;
        break;
      }
    }
    expect(hitRateLimit).toBe(true);
    void getSignal;
  });
});

describe("http helpers (getTrustProxyMode, jsonNoStore, readJsonBodyWithByteLimit)", () => {
  it("resolves getTrustProxyMode safely with case/whitespace normalization", () => {
    expect(getTrustProxyMode({ NODE_ENV: "test" })).toBe("none");
    expect(
      getTrustProxyMode({ NODE_ENV: "test", TRUST_PROXY: "  CLOUDFLARE " })
    ).toBe("cloudflare");
    expect(getTrustProxyMode({ NODE_ENV: "test", TRUST_PROXY: " Vercel " })).toBe(
      "vercel"
    );
    expect(getTrustProxyMode({ NODE_ENV: "test", TRUST_PROXY: "nginx" })).toBe(
      "none"
    );
    expect(getTrustProxyMode({ NODE_ENV: "test", TRUST_PROXY: "" })).toBe(
      "none"
    );
  });

  it("jsonNoStore enforces Cache-Control: no-store while preserving custom headers and status", async () => {
    const res = jsonNoStore(
      { ok: true },
      {
        status: 201,
        headers: {
          "X-Custom": "abc",
          "Cache-Control": "public, max-age=3600",
        },
      }
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-custom")).toBe("abc");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("readJsonBodyWithByteLimit parses valid JSON up to exact UTF-8 byte boundary and rejects oversized, malformed, or invalid UTF-8 payloads", async () => {
    const payload = JSON.stringify({ msg: "ok" });
    const exactBytes = Buffer.byteLength(payload, "utf8");

    const okReq = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: payload,
    });
    expect(await readJsonBodyWithByteLimit(okReq, exactBytes)).toEqual({
      ok: true,
      data: { msg: "ok" },
      byteLength: exactBytes,
    });

    // 1 byte over limit fails with 413
    const overByOne = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: payload,
    });
    expect(await readJsonBodyWithByteLimit(overByOne, exactBytes - 1)).toEqual({
      ok: false,
      status: 413,
      error: "Payload too large",
    });

    // Declared Content-Length > maxBytes fast-rejects with 413
    const bigHeaderReq = new NextRequest("http://localhost/api/test", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: "{}",
    });
    expect(await readJsonBodyWithByteLimit(bigHeaderReq, 64)).toEqual({
      ok: false,
      status: 413,
      error: "Payload too large",
    });

    // Multi-byte UTF-8 streamed without Content-Length rejects with 413
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('{"emoji":"'));
        controller.enqueue(enc.encode("🚀".repeat(20)));
        controller.enqueue(enc.encode('"}'));
        controller.close();
      },
    });
    const streamReq = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: chunkedStream,
    });
    expect(await readJsonBodyWithByteLimit(streamReq, 40)).toEqual({
      ok: false,
      status: 413,
      error: "Payload too large",
    });

    // Invalid UTF-8 bytes rejected with 400
    const badUtf8Req = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    });
    expect(await readJsonBodyWithByteLimit(badUtf8Req, 1024)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid UTF-8 request body",
    });

    // Malformed JSON rejected with 400
    const badJsonReq = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: "{not-json",
    });
    expect(await readJsonBodyWithByteLimit(badJsonReq, 1024)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid JSON",
    });

    // Null body (GET) rejected with 400
    const noBodyReq = new NextRequest("http://localhost/api/test", {
      method: "GET",
    });
    expect(await readJsonBodyWithByteLimit(noBodyReq, 1024)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid request body",
    });
  });
});

describe("Fix 1: fail-fast in production when TRUST_PROXY is unset (no mocked request.ip)", () => {
  beforeEach(() => {
    resetDefaultSignalStoreForTests();
    resetDecideStateForTests();
    resetIceConfigRateLimiterForTests();
    delete process.env.TRUST_PROXY;
    delete process.env.ALLOW_SINGLE_USER_LOCAL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("throws ProxyConfigError in production when TRUST_PROXY is unset or none without socket IP", () => {
    const req = new NextRequest("http://localhost/api/signal", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    // Verify Next 16.4.6 NextRequest genuinely has no .ip or .socket
    expect((req as unknown as Record<string, unknown>).ip).toBeUndefined();
    expect((req as unknown as Record<string, unknown>).socket).toBeUndefined();

    expect(() =>
      getClientIp(req, { NODE_ENV: "production" })
    ).toThrow(ProxyConfigError);

    expect(() =>
      getClientIp(req, { NODE_ENV: "production", TRUST_PROXY: "none" })
    ).toThrow(ProxyConfigError);

    // Explicit opt-in for single-user local prod allows TRUST_PROXY=none
    expect(
      getClientIp(req, {
        NODE_ENV: "production",
        TRUST_PROXY: "none",
        ALLOW_SINGLE_USER_LOCAL: "1",
      })
    ).toBe("local-single-user");
  });

  it("returns 503 + structured error log on API routes when prod lacks TRUST_PROXY, while /api/health stays 200", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const sigPost = await postSignal(
      new NextRequest("http://localhost/api/signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-secret": VALID_SECRET,
        },
        body: JSON.stringify({
          room: "room_ProdFailFast_000000000001",
          type: "join",
        }),
      })
    );
    expect(sigPost.status).toBe(503);
    expect(sigPost.headers.get("cache-control")).toBe("no-store");
    const sigPostJson = (await sigPost.json()) as { code?: string };
    expect(sigPostJson.code).toBe("proxy_misconfigured");

    const sigGet = await getSignal(
      new NextRequest(
        "http://localhost/api/signal?room=room_ProdFailFast_000000000001&since=0"
      )
    );
    expect(sigGet.status).toBe(503);

    const decideRes = await postDecide(
      new NextRequest("http://localhost/api/jev/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "classify_prompt", prompt: "hello" }),
      })
    );
    expect(decideRes.status).toBe(503);

    const iceRes = await getIceConfig(
      new NextRequest("http://localhost/api/ice-config")
    );
    expect(iceRes.status).toBe(503);

    expect(errSpy).toHaveBeenCalledTimes(4);

    // /api/health MUST remain 200 healthy without leaking secrets
    const healthRes = await getHealth();
    expect(healthRes.status).toBe(200);
  });

  it("isolates distinct Cloudflare clients in production via CF-Connecting-IP without mocked request.ip", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY", "cloudflare");

    // Client A exhausts its 20-room cap
    for (let i = 0; i < 20; i += 1) {
      const res = await postSignal(
        new NextRequest("http://localhost/api/signal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-room-secret": VALID_SECRET,
            "cf-connecting-ip": "198.51.100.10",
          },
          body: JSON.stringify({
            room: `room_CfClientA_${String(i).padStart(12, "0")}`,
            type: "join",
          }),
        })
      );
      expect(res.status).toBe(200);
    }

    // Client A's 21st room is blocked (429)
    const overA = await postSignal(
      new NextRequest("http://localhost/api/signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-secret": VALID_SECRET,
          "cf-connecting-ip": "198.51.100.10",
        },
        body: JSON.stringify({
          room: "room_CfClientA_00000000000099",
          type: "join",
        }),
      })
    );
    expect(overA.status).toBe(429);

    // Distinct Client B is NOT collapsed into Client A's bucket and succeeds (200)
    const firstB = await postSignal(
      new NextRequest("http://localhost/api/signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-secret": VALID_SECRET,
          "cf-connecting-ip": "198.51.100.20",
        },
        body: JSON.stringify({
          room: "room_CfClientB_00000000000001",
          type: "join",
        }),
      })
    );
    expect(firstB.status).toBe(200);
  });
});

describe("TRUST_PROXY=vercel (https://vercel.com/docs/headers/request-headers)", () => {
  const prodVercel = { NODE_ENV: "production", TRUST_PROXY: "vercel" } as const;

  beforeEach(() => {
    resetDefaultSignalStoreForTests();
    resetDecideStateForTests();
    resetIceConfigRateLimiterForTests();
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("trusts x-vercel-forwarded-for over a client-supplied X-Forwarded-For", () => {
    const req = new NextRequest("http://localhost/api/signal", {
      headers: {
        "x-forwarded-for": "203.0.113.66",
        "x-vercel-forwarded-for": "198.51.100.7",
        "cf-connecting-ip": "192.0.2.1",
      },
    });
    expect(getClientIp(req, prodVercel)).toBe("198.51.100.7");
  });

  it("falls back to x-real-ip when x-vercel-forwarded-for is absent", () => {
    const req = new NextRequest("http://localhost/api/signal", {
      headers: { "x-forwarded-for": "203.0.113.66", "x-real-ip": "198.51.100.8" },
    });
    expect(getClientIp(req, prodVercel)).toBe("198.51.100.8");
  });

  it("never trusts X-Forwarded-For or CF-Connecting-IP alone and fails fast in production", () => {
    const req = new NextRequest("http://localhost/api/signal", {
      headers: { "x-forwarded-for": "203.0.113.66", "cf-connecting-ip": "192.0.2.1" },
    });
    expect(() => getClientIp(req, prodVercel)).toThrow(ProxyConfigError);
    expect(getClientIp(req, { NODE_ENV: "test", TRUST_PROXY: "vercel" })).toBe(
      "unknown"
    );
  });

  it("rejects malformed Vercel header values instead of using them as bucket keys", () => {
    const req = new NextRequest("http://localhost/api/signal", {
      headers: { "x-vercel-forwarded-for": "<script>", "x-real-ip": "198.51.100.9" },
    });
    expect(getClientIp(req, prodVercel)).toBe("198.51.100.9");
  });

  it("caps rooms per Vercel client IP despite rotating X-Forwarded-For, and isolates other clients", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY", "vercel");
    const join = (vercelIp: string, xff: string, n: number) =>
      postSignal(
        new NextRequest("http://localhost/api/signal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-room-secret": VALID_SECRET,
            "x-vercel-forwarded-for": vercelIp,
            "x-forwarded-for": xff,
          },
          body: JSON.stringify({
            room: `room_VercelCap_0000000000${String(n).padStart(2, "0")}`,
            type: "join",
          }),
        })
      );
    for (let i = 0; i < 20; i += 1) {
      expect((await join("198.51.100.20", `203.0.113.${i + 1}`, i)).status).toBe(200);
    }
    expect((await join("198.51.100.20", "203.0.113.250", 20)).status).toBe(429);
    expect((await join("198.51.100.21", "203.0.113.1", 21)).status).toBe(200);
  });
});
