import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/ice-config/route";
import { POST as postSignal } from "@/app/api/signal/route";
import { resetIceConfigRateLimiterForTests } from "@/lib/server/ice-config";
import { resetDefaultSignalStoreForTests } from "@/lib/server/signal-store";

const VALID_ROOM = "room_IceAuthRoom0123456789ab";
const VALID_SECRET = "secr_0123456789abcdefABCDEF0123456789";
const WRONG_SECRET = "secr_WRONG56789abcdefABCDEF0123456789";

function makeGet(
  query = "",
  headers: Record<string, string> = {}
): NextRequest {
  const suffix = query ? `?${query}` : "";
  return new NextRequest(`http://localhost/api/ice-config${suffix}`, {
    method: "GET",
    headers,
  });
}

describe("GET /api/ice-config (authenticated short-lived coturn HMAC credentials)", () => {
  const savedEnv = {
    ICE_SERVERS_JSON: process.env.ICE_SERVERS_JSON,
    TURN_URLS: process.env.TURN_URLS,
    TURN_SHARED_SECRET: process.env.TURN_SHARED_SECRET,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
  };

  beforeEach(() => {
    delete process.env.ICE_SERVERS_JSON;
    delete process.env.TURN_URLS;
    delete process.env.TURN_SHARED_SECRET;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
    resetIceConfigRateLimiterForTests();
    resetDefaultSignalStoreForTests();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("returns STUN-only with Cache-Control: no-store when unauthenticated, even if TURN_SHARED_SECRET is configured", async () => {
    process.env.TURN_URLS = "turn:turn.example.org:3478, turns:turn.example.org:5349";
    process.env.TURN_SHARED_SECRET = "super-secret-coturn-key";
    process.env.TURN_USERNAME = "legacy-static-user";
    process.env.TURN_CREDENTIAL = "legacy-static-pass";

    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const data = (await res.json()) as {
      iceServers: RTCIceServer[];
      hasTurn: boolean;
    };
    expect(data.hasTurn).toBe(false);
    expect(JSON.stringify(data)).not.toContain("turn.example.org");
    expect(JSON.stringify(data)).not.toContain("legacy-static");
    expect(
      data.iceServers.every((s) =>
        typeof s.urls === "string"
          ? s.urls.startsWith("stun:")
          : s.urls.every((u) => u.startsWith("stun:"))
      )
    ).toBe(true);
  });

  it("returns STUN-only when room/secret/peer-token auth fails against SignalStore", async () => {
    process.env.TURN_URLS = "turn:turn.example.org:3478";
    process.env.TURN_SHARED_SECRET = "super-secret-coturn-key";

    // Join room first so room exists
    const joinRes = await postSignal(
      new NextRequest("http://localhost/api/signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-secret": VALID_SECRET,
        },
        body: JSON.stringify({ room: VALID_ROOM, type: "join", name: "Alice" }),
      })
    );
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as {
      peerId: string;
      peerToken: string;
    };

    // Wrong room secret -> STUN-only
    const badSecretRes = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}`, {
        "x-room-secret": WRONG_SECRET,
        "x-peer-token": joined.peerToken,
      })
    );
    expect(badSecretRes.status).toBe(200);
    const badSecretData = (await badSecretRes.json()) as { hasTurn: boolean };
    expect(badSecretData.hasTurn).toBe(false);

    // Wrong peer token -> STUN-only
    const badTokenRes = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}`, {
        "x-room-secret": VALID_SECRET,
        "x-peer-token": "tok_invalid_0123456789abcdef01234",
      })
    );
    expect(badTokenRes.status).toBe(200);
    const badTokenData = (await badTokenRes.json()) as { hasTurn: boolean };
    expect(badTokenData.hasTurn).toBe(false);
  });

  it("issues short-lived coturn HMAC-SHA1 TURN credentials for a peer authenticated against SignalStore", async () => {
    const sharedSecret = "coturn-hmac-secret-2026";
    process.env.TURN_URLS =
      "turn:turn1.example.org:3478?transport=udp, turns:turn2.example.org:5349";
    process.env.TURN_SHARED_SECRET = sharedSecret;

    const joinRes = await postSignal(
      new NextRequest("http://localhost/api/signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-secret": VALID_SECRET,
        },
        body: JSON.stringify({ room: VALID_ROOM, type: "join", name: "Alice" }),
      })
    );
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as {
      peerId: string;
      peerToken: string;
    };

    const res = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}`, {
        "x-room-secret": VALID_SECRET,
        "x-peer-token": joined.peerToken,
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const data = (await res.json()) as {
      iceServers: RTCIceServer[];
      hasTurn: boolean;
      ttlSeconds?: number;
      expiresAt?: number;
    };
    expect(data.hasTurn).toBe(true);
    expect(data.ttlSeconds).toBe(600);
    expect(typeof data.expiresAt).toBe("number");

    const turnEntry = data.iceServers.find((s) =>
      Array.isArray(s.urls)
        ? s.urls.some((u) => u.startsWith("turn"))
        : s.urls.startsWith("turn")
    );
    expect(turnEntry).toBeDefined();
    expect(turnEntry?.username).toBe(`${data.expiresAt}:${joined.peerId}`);
    const expectedHmac = createHmac("sha1", sharedSecret)
      .update(turnEntry!.username!, "utf8")
      .digest("base64");
    expect(turnEntry?.credential).toBe(expectedHmac);
  });

  it("enforces per-IP rate limiting with 429 and Retry-After", async () => {
    for (let i = 0; i < 60; i += 1) {
      const okRes = await GET(makeGet());
      expect(okRes.status).toBe(200);
    }
    const limited = await GET(makeGet());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
