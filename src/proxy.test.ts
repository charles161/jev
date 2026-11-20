import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

describe("Review (d): per-request CSP nonce via Next.js 16 proxy.ts", () => {
  it("generates unique per-request nonces and omits unsafe-inline from script-src in production", () => {
    const req1 = new NextRequest("http://localhost/");
    const req2 = new NextRequest("http://localhost/");

    const res1 = proxy(req1);
    const res2 = proxy(req2);

    const csp1 = res1.headers.get("content-security-policy") ?? "";
    const csp2 = res2.headers.get("content-security-policy") ?? "";

    expect(csp1).toContain("script-src");
    expect(csp1).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp1).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp1).toContain("'strict-dynamic'");
    expect(csp1).toContain("frame-ancestors 'none'");
    expect(csp1).not.toBe(csp2);
  });
});
