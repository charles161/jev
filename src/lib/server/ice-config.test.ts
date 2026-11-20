import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STUN_SERVERS,
  mintCoturnCredentials,
  resolveIceConfigFromEnv,
  TURN_CREDENTIAL_TTL_SECONDS,
} from "@/lib/server/ice-config";

function makeEnv(
  vars: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

describe("ice-config (coturn HMAC auth & zero static TURN exposure)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to DEFAULT_STUN_SERVERS with hasTurn=false when env is empty", () => {
    const res = resolveIceConfigFromEnv(makeEnv());
    expect(res).toEqual({
      iceServers: DEFAULT_STUN_SERVERS,
      hasTurn: false,
    });
  });

  it("never exposes static TURN_USERNAME/TURN_CREDENTIAL or static TURN entries from ICE_SERVERS_JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const staticTurnAttempt = resolveIceConfigFromEnv(
      makeEnv({
        TURN_URLS: "turn:relay.example.org:3478, turns:relay.example.org:5349",
        TURN_USERNAME: "static-user",
        TURN_CREDENTIAL: "static-pass",
      }),
      { peerId: "p_auth_peer_1234" }
    );
    expect(staticTurnAttempt.hasTurn).toBe(false);
    expect(JSON.stringify(staticTurnAttempt)).not.toContain("static-user");
    expect(JSON.stringify(staticTurnAttempt)).not.toContain("static-pass");
    expect(JSON.stringify(staticTurnAttempt)).not.toContain("relay.example.org");

    // Static TURN in ICE_SERVERS_JSON is stripped (only STUN entries kept)
    const jsonStaticTurn = resolveIceConfigFromEnv(
      makeEnv({
        ICE_SERVERS_JSON: JSON.stringify([
          { urls: "stun:stun.example.net:3478" },
          {
            urls: "turns:static.example.net:5349",
            username: "u",
            credential: "p",
          },
        ]),
      })
    );
    expect(jsonStaticTurn.hasTurn).toBe(false);
    expect(jsonStaticTurn.iceServers).toEqual([
      { urls: "stun:stun.example.net:3478" },
    ]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("mints short-lived (~10 min TTL) coturn REST HMAC-SHA1 credentials only for authenticated peers", () => {
    const nowMs = 1_750_000_000_000;
    const secret = "coturn-shared-hmac-secret-xyz";
    const peerId = "p_verified_peer_abc";

    const minted = mintCoturnCredentials({
      sharedSecret: secret,
      peerId,
      nowMs,
    });
    const expectedExpiry = Math.floor(nowMs / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
    const expectedUsername = `${expectedExpiry}:${peerId}`;
    const expectedCred = createHmac("sha1", secret)
      .update(expectedUsername, "utf8")
      .digest("base64");

    expect(TURN_CREDENTIAL_TTL_SECONDS).toBe(600);
    expect(minted.expiresAt).toBe(expectedExpiry);
    expect(minted.username).toBe(expectedUsername);
    expect(minted.credential).toBe(expectedCred);

    const env = makeEnv({
      TURN_URLS: "turn:turn1.example.org:3478, turns:turn2.example.org:5349",
      TURN_SHARED_SECRET: secret,
    });

    // Unauthenticated caller gets STUN-only
    const unauth = resolveIceConfigFromEnv(env, null, nowMs);
    expect(unauth.hasTurn).toBe(false);
    expect(unauth.iceServers).toEqual(DEFAULT_STUN_SERVERS);

    // Authenticated peer receives STUN + short-lived HMAC TURN credentials
    const authed = resolveIceConfigFromEnv(env, { peerId }, nowMs);
    expect(authed.hasTurn).toBe(true);
    expect(authed.expiresAt).toBe(expectedExpiry);
    expect(authed.ttlSeconds).toBe(TURN_CREDENTIAL_TTL_SECONDS);
    expect(authed.iceServers[authed.iceServers.length - 1]).toEqual({
      urls: ["turn:turn1.example.org:3478", "turns:turn2.example.org:5349"],
      username: expectedUsername,
      credential: expectedCred,
    });
  });

  it("logs a warning and falls back to DEFAULT_STUN_SERVERS when ICE_SERVERS_JSON or TURN_URLS are invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const invalidCases = [
      "not-valid-json",
      "[]",
      JSON.stringify([{ urls: "https://evil.example.com" }]),
      JSON.stringify([{ urls: "stun:bad url with spaces:3478" }]),
      JSON.stringify(
        Array.from({ length: 17 }, (_, i) => ({
          urls: `stun:s${i}.example.net:3478`,
        }))
      ),
    ];

    for (const bad of invalidCases) {
      const res = resolveIceConfigFromEnv(makeEnv({ ICE_SERVERS_JSON: bad }));
      expect(res).toEqual({
        iceServers: DEFAULT_STUN_SERVERS,
        hasTurn: false,
      });
    }
    expect(warnSpy).toHaveBeenCalledTimes(invalidCases.length);

    // Invalid TURN_URLS logs warning and falls through to valid STUN in NEXT_PUBLIC_ICE_SERVERS
    const fallthrough = resolveIceConfigFromEnv(
      makeEnv({
        TURN_URLS: "http://bad, javascript:alert(1)",
        TURN_SHARED_SECRET: "secret",
        NEXT_PUBLIC_ICE_SERVERS: JSON.stringify([
          { urls: "stuns:public.example.org:5349" },
        ]),
      }),
      { peerId: "p_peer_123456" }
    );
    expect(fallthrough).toEqual({
      iceServers: [{ urls: "stuns:public.example.org:5349" }],
      hasTurn: false,
    });
  });
});
