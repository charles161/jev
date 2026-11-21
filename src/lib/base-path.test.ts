import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, normalizeBasePath } from "@/lib/base-path";
import nextConfig from "../../next.config";

describe("normalizeBasePath", () => {
  it("defaults to no base path", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("   ")).toBe("");
  });

  it("accepts a leading-slash prefix and strips a trailing slash", () => {
    expect(normalizeBasePath("/ichalk")).toBe("/ichalk");
    expect(normalizeBasePath("/ichalk/")).toBe("/ichalk");
    expect(normalizeBasePath("/a/b")).toBe("/a/b");
  });

  it("rejects values Next.js basePath cannot use", () => {
    expect(() => normalizeBasePath("ichalk")).toThrow(/must start with "\/"/);
    expect(() => normalizeBasePath("/")).toThrow(/leave it empty/);
    expect(() => normalizeBasePath("/ich alk")).toThrow(/letters, digits/);
  });
});

describe("appUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the path unchanged when NEXT_PUBLIC_BASE_PATH is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    expect(appUrl("/api/signal")).toBe("/api/signal");
    expect(appUrl("/api/signal?room=r1&since=3")).toBe("/api/signal?room=r1&since=3");
  });

  it("prefixes the configured base path", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/ichalk");
    expect(appUrl("/api/jev/decide")).toBe("/ichalk/api/jev/decide");
    expect(appUrl("/api/ice-config?room=x")).toBe("/ichalk/api/ice-config?room=x");
  });

  it("only accepts absolute app paths", () => {
    expect(() => appUrl("api/signal")).toThrow(/absolute app path/);
    expect(() => appUrl("https://evil.example/api")).toThrow(/absolute app path/);
    expect(() => appUrl("//evil.example/api")).toThrow(/absolute app path/);
  });
});

describe("next.config basePath", () => {
  it("is off by default so the root deployment is unchanged", () => {
    expect(nextConfig.basePath ?? "").toBe(process.env.NEXT_PUBLIC_BASE_PATH ?? "");
  });
});

const SRC = path.resolve(__dirname, "..");
const SERVER_ONLY = [
  path.join(SRC, "app", "api"),
  path.join(SRC, "lib", "server"),
];
const HELPER = path.join(SRC, "lib", "base-path.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("client code routes every app URL through appUrl()", () => {
  it("has no raw '/api/' string or template literal outside the helper", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === HELPER) continue;
      if (/\.test\.tsx?$/.test(file)) continue;
      if (SERVER_ONLY.some((dir) => file.startsWith(dir + path.sep))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/["'`]\/api\//.test(line) && !/appUrl\(\s*["'`]\/api\//.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'Wrap absolute app URLs in appUrl("/api/...") from "@/lib/base-path" so they keep working when NEXT_PUBLIC_BASE_PATH is set (Next basePath does not prefix fetch()).'
    ).toEqual([]);
  });
});
