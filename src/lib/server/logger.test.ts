import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyServerError,
  logServerEvent,
  type ServerLogEvent,
} from "@/lib/server/logger";

describe("server logger (allowlist redaction & error classification)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes info, warn, and error levels to matching console methods with single-line JSON", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logServerEvent("info", {
      route: "/api/health",
      event: "ok",
      method: "GET",
      status: 200,
      latencyMs: 3,
    });
    logServerEvent("warn", {
      route: "/api/jev/decide",
      event: "degraded",
      mode: "rank_actions",
      upstreamStatus: 503,
      errorClass: "TypeSafeApiError",
      errorCode: "UPSTREAM_HTTP_ERROR",
      degraded: true,
    });
    logServerEvent("error", {
      route: "/api/signal",
      event: "unhandled",
      status: 500,
      errorClass: "Error",
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const infoLine = String(infoSpy.mock.calls[0][0]);
    expect(infoLine).not.toContain("\n");
    const infoObj = JSON.parse(infoLine) as Record<string, unknown>;
    expect(infoObj.level).toBe("info");
    expect(infoObj.route).toBe("/api/health");
    expect(infoObj.event).toBe("ok");
    expect(infoObj.method).toBe("GET");
    expect(infoObj.status).toBe(200);
    expect(infoObj.latencyMs).toBe(3);
    expect(Date.parse(String(infoObj.ts))).not.toBeNaN();

    const warnObj = JSON.parse(String(warnSpy.mock.calls[0][0])) as Record<
      string,
      unknown
    >;
    expect(warnObj).toMatchObject({
      level: "warn",
      route: "/api/jev/decide",
      event: "degraded",
      mode: "rank_actions",
      upstreamStatus: 503,
      errorClass: "TypeSafeApiError",
      errorCode: "UPSTREAM_HTTP_ERROR",
      degraded: true,
    });
  });

  it("enforces strict field allowlist and strips any unallowlisted/sensitive properties passed at runtime", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const unsafePayload = {
      route: "/api/jev/decide",
      event: "upstream_failed",
      status: 502,
      // Runtime-injected sensitive fields that MUST NEVER be emitted
      apiKey: "dummy-key",
      authorization: "Bearer dummy",
      roomSecret: "dummy-room",
      peerToken: "dummy-peer",
      prompt: "confidential merger diagram",
      headers: { cookie: "session=abc" },
      body: { secret: true },
    } as unknown as ServerLogEvent;

    logServerEvent("warn", unsafePayload);

    const line = String(warnSpy.mock.calls[0][0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "event",
      "level",
      "route",
      "status",
      "ts",
    ]);
    expect(line).not.toContain("dummy-key");
    expect(line).not.toContain("Bearer dummy");
    expect(line).not.toContain("dummy-room");
    expect(line).not.toContain("dummy-peer");
    expect(line).not.toContain("confidential merger diagram");
    expect(line).not.toContain("session=abc");
  });

  it("classifies standard errors, typed errors, malformed error objects, and primitives safely", () => {
    expect(classifyServerError(new TypeError("bad input"))).toEqual({
      errorClass: "TypeError",
      errorCode: undefined,
      upstreamStatus: undefined,
    });

    expect(
      classifyServerError({
        name: "TypeSafeApiError",
        code: "UPSTREAM_HTTP_ERROR",
        status: 429,
      })
    ).toEqual({
      errorClass: "TypeSafeApiError",
      errorCode: "UPSTREAM_HTTP_ERROR",
      upstreamStatus: 429,
    });

    // Empty strings and non-integer status are sanitized out
    expect(
      classifyServerError({
        name: "",
        code: "",
        status: 500.5,
      })
    ).toEqual({
      errorClass: "Error",
      errorCode: undefined,
      upstreamStatus: undefined,
    });

    expect(classifyServerError({ status: "500" })).toEqual({
      errorClass: "Error",
      errorCode: undefined,
      upstreamStatus: undefined,
    });

    expect(classifyServerError(null)).toEqual({ errorClass: "UnknownError" });
    expect(classifyServerError(undefined)).toEqual({
      errorClass: "UnknownError",
    });
    expect(classifyServerError("string failure")).toEqual({
      errorClass: "UnknownError",
    });
    expect(classifyServerError(42)).toEqual({ errorClass: "UnknownError" });
  });
});
