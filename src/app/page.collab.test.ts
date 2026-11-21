// Charles 21 Nov 2026: collab is "later" on Vercel; the Share P2P button must not appear there (its signalling 404s).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Share P2P is hidden where collaboration can't work", () => {
  it("the page turns collaboration off on Vercel", () => {
    const page = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(page).toMatch(/collabEnabled=\{process\.env\.VERCEL !== "1"\}/);
  });
  it("the workspace only renders the Share button when collaboration is enabled", () => {
    const ws = readFileSync(path.join(__dirname, "..", "components", "jev", "JevWorkspace.tsx"), "utf8");
    const i = ws.indexOf('"Share P2P"');
    const guard = ws.lastIndexOf("{collabEnabled && (", i);
    expect(guard).toBeGreaterThan(-1);
    expect(i - guard).toBeLessThan(4000);
  });
  it("the link-preview text no longer promises peer-to-peer collaboration", async () => {
    const brand = readFileSync(path.join(__dirname, "..", "brand", "brand.ts"), "utf8");
    expect(brand).not.toMatch(/peer-to-peer WebRTC collaboration/);
  });
});
