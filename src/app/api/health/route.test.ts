import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  const origKey = process.env.TYPESAFE_API_KEY;

  afterEach(() => {
    if (origKey === undefined) {
      delete process.env.TYPESAFE_API_KEY;
    } else {
      process.env.TYPESAFE_API_KEY = origKey;
    }
  });

  it("returns 200 healthy with Cache-Control: no-store and never exposes env vars", async () => {
    process.env.TYPESAFE_API_KEY = "test-secret-should-never-appear";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    expect(text).not.toContain("test-secret-should-never-appear");
    expect(text).not.toContain("TYPESAFE_API_KEY");

    const json = JSON.parse(text) as {
      ok: boolean;
      status: string;
      timestamp: string;
    };
    expect(json.ok).toBe(true);
    expect(json.status).toBe("healthy");
    expect(Number.isNaN(Date.parse(json.timestamp))).toBe(false);
  });
});
