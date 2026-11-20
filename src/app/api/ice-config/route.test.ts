import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/ice-config/route";
import { resetIceConfigRateLimiterForTests } from "@/lib/server/ice-config";

function makeGet(ip = "198.51.100.50"): NextRequest {
  return new NextRequest("http://localhost/api/ice-config", {
    method: "GET",
    headers: { "x-forwarded-for": ip },
  });
}

describe("GET /api/ice-config (configurable STUN/TURN servers)", () => {
  const savedEnv = {
    ICE_SERVERS_JSON: process.env.ICE_SERVERS_JSON,
    TURN_URLS: process.env.TURN_URLS,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
  };

  beforeEach(() => {
    delete process.env.ICE_SERVERS_JSON;
    delete process.env.TURN_URLS;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
    resetIceConfigRateLimiterForTests();
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

  it("returns default STUN servers with Cache-Control: no-store when no env vars are configured", async () => {
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const data = (await res.json()) as {
      iceServers: RTCIceServer[];
      hasTurn: boolean;
    };
    expect(data.hasTurn).toBe(false);
    expect(data.iceServers.length).toBeGreaterThanOrEqual(1);
    expect(
      data.iceServers.every((s) =>
        typeof s.urls === "string"
          ? s.urls.startsWith("stun:")
          : s.urls.every((u) => u.startsWith("stun:"))
      )
    ).toBe(true);
  });

  it("returns validated TURN + STUN config from ICE_SERVERS_JSON dynamically at runtime", async () => {
    process.env.ICE_SERVERS_JSON = JSON.stringify([
      { urls: "stun:stun.example.net:3478" },
      {
        urls: ["turn:turn.example.net:3478?transport=udp", "turns:turn.example.net:5349"],
        username: "turnuser",
        credential: "turnpass",
      },
    ]);

    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()) as {
      iceServers: RTCIceServer[];
      hasTurn: boolean;
    };
    expect(data.hasTurn).toBe(true);
    expect(data.iceServers).toHaveLength(2);
    expect(data.iceServers[1]).toEqual({
      urls: [
        "turn:turn.example.net:3478?transport=udp",
        "turns:turn.example.net:5349",
      ],
      username: "turnuser",
      credential: "turnpass",
    });
  });

  it("supports TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL env vars alongside default STUN", async () => {
    process.env.TURN_URLS =
      "turn:turn1.example.org:3478, turns:turn2.example.org:5349";
    process.env.TURN_USERNAME = "alice";
    process.env.TURN_CREDENTIAL = "secret-cred";

    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      iceServers: RTCIceServer[];
      hasTurn: boolean;
    };
    expect(data.hasTurn).toBe(true);
    expect(data.iceServers.some((s) => s.username === "alice")).toBe(true);
    expect(
      data.iceServers.some((s) =>
        typeof s.urls === "string"
          ? s.urls.startsWith("stun:")
          : s.urls.some((u) => u.startsWith("stun:"))
      )
    ).toBe(true);
  });

  it("falls back safely to default STUN when ICE_SERVERS_JSON is malformed or contains non-STUN/TURN URLs", async () => {
    process.env.ICE_SERVERS_JSON = JSON.stringify([
      { urls: "https://evil.example.com/steal" },
    ]);

    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      iceServers: RTCIceServer[];
      hasTurn: boolean;
    };
    expect(data.hasTurn).toBe(false);
    expect(JSON.stringify(data)).not.toContain("evil.example.com");
  });

  it("enforces per-IP rate limiting with 429 and Retry-After", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 60; i += 1) {
      const okRes = await GET(makeGet(ip));
      expect(okRes.status).toBe(200);
    }
    const limited = await GET(makeGet(ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
