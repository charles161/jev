import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STUN_SERVERS,
  resolveIceConfigFromEnv,
} from "@/lib/server/ice-config";

function makeEnv(
  vars: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

describe("ice-config (resolveIceConfigFromEnv)", () => {
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

  it("prioritizes valid ICE_SERVERS_JSON over TURN_URLS and NEXT_PUBLIC_ICE_SERVERS", () => {
    const res = resolveIceConfigFromEnv(
      makeEnv({
        ICE_SERVERS_JSON: JSON.stringify([
          {
            urls: "turns:primary.example.net:5349",
            username: "u",
            credential: "p",
          },
        ]),
        TURN_URLS: "turn:secondary.example.net:3478",
        NEXT_PUBLIC_ICE_SERVERS: JSON.stringify([
          { urls: "stun:tertiary.example.net:3478" },
        ]),
      })
    );

    expect(res.hasTurn).toBe(true);
    expect(res.iceServers).toEqual([
      {
        urls: "turns:primary.example.net:5349",
        username: "u",
        credential: "p",
      },
    ]);
  });

  it("logs a warning and falls through when ICE_SERVERS_JSON is invalid, empty, oversized, or uses disallowed schemes", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const invalidCases = [
      "not-valid-json",
      "[]",
      JSON.stringify([{ urls: "https://evil.example.com" }]),
      JSON.stringify([{ urls: "turn:bad url with spaces:3478" }]),
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
  });

  it("resolves single and multiple TURN_URLS, filters invalid entries, and computes hasTurn accurately", () => {
    const single = resolveIceConfigFromEnv(
      makeEnv({
        TURN_URLS: "turn:single.example.org:3478",
        TURN_USERNAME: "alice",
        TURN_CREDENTIAL: "pass123",
      })
    );
    expect(single.hasTurn).toBe(true);
    expect(single.iceServers[single.iceServers.length - 1]).toEqual({
      urls: "turn:single.example.org:3478",
      username: "alice",
      credential: "pass123",
    });

    // Mixed valid + invalid URLs: invalid entries are dropped; STUN-only keeps hasTurn=false
    const stunOnly = resolveIceConfigFromEnv(
      makeEnv({
        TURN_URLS: "http://ignored.example.com, stun:custom.example.org:3478",
      })
    );
    expect(stunOnly.hasTurn).toBe(false);
    expect(stunOnly.iceServers).toHaveLength(DEFAULT_STUN_SERVERS.length + 1);
    expect(stunOnly.iceServers[stunOnly.iceServers.length - 1]).toEqual({
      urls: "stun:custom.example.org:3478",
    });

    // All invalid TURN_URLS logs warning and falls through to NEXT_PUBLIC_ICE_SERVERS
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallthrough = resolveIceConfigFromEnv(
      makeEnv({
        TURN_URLS: "http://bad, javascript:alert(1)",
        NEXT_PUBLIC_ICE_SERVERS: JSON.stringify([
          { urls: "stuns:public.example.org:5349" },
        ]),
      })
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(fallthrough).toEqual({
      iceServers: [{ urls: "stuns:public.example.org:5349" }],
      hasTurn: false,
    });
  });

  it("ignores malformed NEXT_PUBLIC_ICE_SERVERS and returns DEFAULT_STUN_SERVERS", () => {
    const res = resolveIceConfigFromEnv(
      makeEnv({
        NEXT_PUBLIC_ICE_SERVERS: "{broken",
      })
    );
    expect(res).toEqual({
      iceServers: DEFAULT_STUN_SERVERS,
      hasTurn: false,
    });
  });
});
