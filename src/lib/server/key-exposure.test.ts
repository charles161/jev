// Charles (21 Nov 2026): the shared "jev" prediction key must never reach the browser.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
const all = files(SRC);
const SERVER_ONLY = ["typesafe-client", "llm-graph-client"];

describe("AI keys stay on the server", () => {
  it("no NEXT_PUBLIC_ variable carries a key", () => {
    for (const f of all) expect(readFileSync(f, "utf8")).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET)/);
  });
  it("key-reading modules are imported only from API routes", () => {
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      if (!SERVER_ONLY.some((m) => src.includes(`/${m}"`))) continue;
      expect(f.replace(SRC, "src")).toMatch(/^src\/app\/api\//);
    }
  });
  it("no client component touches the key env vars", () => {
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      if (!/^["']use client["']/m.test(src)) continue;
      expect(src).not.toMatch(/TYPESAFE_API_KEY|JEV_LLM_API_KEY|OPENAI_API_KEY/);
    }
  });
});
