import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siteMetadata } from "@/brand/brand";
import { ContactSheet } from "@/brand/icons/ContactSheet";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const APP = path.join(SRC, "app");
const PUBLIC = path.join(ROOT, "public");

const PROXY_MATCHER_FILE = path.join(SRC, "proxy.ts");

const BASE_PATHS = ["", "/skot"] as const;

const ICON_FILE = /^(favicon\.ico|(icon|apple-icon)\d*\.(ico|jpe?g|png|svg|gif)|manifest\.(json|webmanifest))$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function appIconRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const file of walk(APP)) {
    if (!ICON_FILE.test(path.basename(file))) continue;
    const segments = path
      .relative(APP, file)
      .split(path.sep)
      .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    routes.set("/" + segments.join("/"), file);
  }
  return routes;
}

function resolveAsset(href: string, basePath: string): string {
  expect(href, `${href} must live under the base path "${basePath}"`).toMatch(
    new RegExp(`^${basePath.replace(/\//g, "\\/")}/(?!/)`)
  );
  const route = href.slice(basePath.length).split(/[?#]/)[0];
  const fromApp = appIconRoutes().get(route);
  if (fromApp) return fromApp;
  const fromPublic = path.join(PUBLIC, route);
  expect(existsSync(fromPublic), `${href} (base "${basePath}") resolves to no app icon route or public/ file`).toBe(true);
  return fromPublic;
}

function metadataIconUrls(): string[] {
  const meta = siteMetadata as Record<string, unknown>;
  const urls: string[] = [];
  const collect = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") urls.push(v);
    else if (v instanceof URL) urls.push(v.pathname);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if ("url" in o) collect(o.url);
      else Object.values(o).forEach(collect);
    }
  };
  collect(meta.icons);
  collect(meta.manifest);
  return urls;
}

describe("icons, favicon and manifest resolve with an empty base path (Vercel) and /skot (VPC)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ships a favicon as an app icon file convention (Next prefixes the base path itself)", () => {
    expect([...appIconRoutes().keys()]).toContain("/icon.svg");
    expect(readFileSync(path.join(APP, "icon.svg"), "utf8")).toMatch(/^<svg[\s>]/);
  });

  it.each(BASE_PATHS)("base %j: every generated <link> href resolves to a real file", (basePath) => {
    const hrefs = [...appIconRoutes().keys()].map((route) => `${basePath}${route}?hash`);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(existsSync(resolveAsset(href, basePath))).toBe(true);
  });

  it("does not hard-code icon/manifest URLs in metadata (Next does not add the base path to them)", () => {
    expect(
      metadataIconUrls(),
      "Use src/app/icon.*, apple-icon.* or manifest.* file conventions instead of metadata.icons/manifest strings."
    ).toEqual([]);
  });

  it.each(BASE_PATHS)("base %j: the /icons contact sheet's asset URLs resolve", (basePath) => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
    const html = renderToStaticMarkup(<ContactSheet />);
    const urls = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith("/"));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(existsSync(resolveAsset(url, basePath))).toBe(true);
  });

  it("routes every hard-coded asset URL in client code through appUrl()", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.(ts|tsx|css)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      if (file === PROXY_MATCHER_FILE) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const asset = /(["'`(])\/[^"'`)\s]+\.(svg|png|ico|jpe?g|webp|gif|webmanifest|woff2?)\b/;
        if (asset.test(line) && !/appUrl\(\s*["'`]\/[^"'`]+["'`]\s*\)/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'Wrap absolute asset URLs in appUrl("/x.svg") from "@/lib/base-path": Next basePath does not prefix raw <img src> or url() strings.'
    ).toEqual([]);
  });
});
