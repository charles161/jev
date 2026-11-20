import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getSignal, POST as postSignal } from "@/app/api/signal/route";
import { POST as postDecide } from "@/app/api/jev/decide/route";
import { resetDecideStateForTests } from "@/lib/server/decide-state";
import { getClientIp } from "@/lib/server/http";
import { resetDefaultSignalStoreForTests } from "@/lib/server/signal-store";

const VALID_SECRET = "secr_0123456789abcdefABCDEF0123456789";

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
    // Default TRUST_PROXY=none: rotating X-Forwarded-For must NOT allow creating >5 rooms
    for (let i = 0; i < 5; i += 1) {
      const res = await postSignal(
        new NextRequest("http://localhost/api/signal", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-room-secret": VALID_SECRET,
            "x-forwarded-for": `203.0.113.${i + 1}`,
          },
          body: JSON.stringify({
            room: `room_SpoofAttempt_00000000000${i}`,
            type: "join",
          }),
        })
      );
      expect(res.status).toBe(200);
    }

    // 6th room with a brand-new spoofed X-Forwarded-For MUST be rejected with 429
    const sixth = await postSignal(
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
    expect(sixth.status).toBe(429);
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
