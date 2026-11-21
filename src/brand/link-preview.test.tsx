// Charles (21 Nov 2026): WhatsApp showed the link preview without an image. Platforms ignore SVG favicons and
// need an absolute og:image, PNG icons, a favicon.ico and a web manifest. Also: a visible "Beta" badge.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSiteMetadata, DEFAULT_SITE_URL, resolveSiteUrl } from "@/brand/brand";
import { BrandWordmark } from "@/brand/BrandWordmark";
import { BasePathFaviconLink } from "@/brand/BasePathFaviconLink";
import manifest from "@/app/manifest";

const ROOT = path.resolve(__dirname, "../..");
const PUBLIC = path.join(ROOT, "public");
const APP = path.join(ROOT, "src", "app");

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function icoSizes(file: string): number[] {
  const buf = readFileSync(file);
  expect(buf.readUInt16LE(2)).toBe(1);
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => buf[6 + i * 16] || 256).sort((a, b) => a - b);
}

describe("site URL", () => {
  it("prefers SITE_URL, then the request host, then production", () => {
    expect(resolveSiteUrl({ env: { SITE_URL: "https://skot.lightslips.ai/" } })).toBe("https://skot.lightslips.ai");
    expect(resolveSiteUrl({ env: {}, host: "preview-123.vercel.app", proto: "https" })).toBe("https://preview-123.vercel.app");
    expect(resolveSiteUrl({ env: {}, host: "localhost:3000", proto: "http" })).toBe("http://localhost:3000");
    expect(resolveSiteUrl({ env: {} })).toBe(DEFAULT_SITE_URL);
    expect(DEFAULT_SITE_URL).toBe("https://skot.lightslips.ai");
  });

  it("ignores a malformed host or SITE_URL", () => {
    expect(resolveSiteUrl({ env: { SITE_URL: "not a url" }, host: "bad host/x", proto: "https" })).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl({ env: {}, host: "evil.com", proto: "javascript" })).toBe("https://evil.com");
  });

  it("uses https for any public host even when Next reports http behind a proxy", () => {
    expect(resolveSiteUrl({ env: {}, host: "skot.lightslips.ai", proto: "http" })).toBe("https://skot.lightslips.ai");
    expect(resolveSiteUrl({ env: {}, host: "127.0.0.1:3000", proto: "http" })).toBe("http://127.0.0.1:3000");
  });
});

describe("link preview metadata", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["", "https://skot.lightslips.ai/og.png"],
    ["/skot", "https://skot.lightslips.ai/skot/og.png"],
  ])("base %j: absolute og:image and a large Twitter card", (basePath, expected) => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
    const meta = buildSiteMetadata("https://skot.lightslips.ai");
    expect(meta.metadataBase?.toString()).toBe("https://skot.lightslips.ai/");
    const og = (meta.openGraph?.images as Array<{ url: string; width: number; height: number; type: string; alt: string }>)[0];
    expect(og).toMatchObject({ url: expected, width: 1200, height: 630, type: "image/png" });
    expect(og.alt).toContain("Skot");
    expect(meta.openGraph?.url).toBe(`https://skot.lightslips.ai${basePath}/`);
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
    expect((meta.twitter?.images as Array<{ url: string }>)[0].url).toBe(expected);
  });

  it("says (beta) in the page description", () => {
    const meta = buildSiteMetadata("https://skot.lightslips.ai");
    expect(meta.description).toMatch(/\(beta\)$/);
    expect(meta.openGraph?.description).toMatch(/\(beta\)$/);
  });
});

describe("platform images", () => {
  it("ships a 1200x630 PNG link preview image", () => {
    expect(pngSize(path.join(PUBLIC, "og.png"))).toEqual({ width: 1200, height: 630 });
  });

  it("ships PNG icons: apple-touch 180 (file convention), 192 and 512", () => {
    expect(pngSize(path.join(APP, "apple-icon.png"))).toEqual({ width: 180, height: 180 });
    expect(pngSize(path.join(PUBLIC, "icon-192.png"))).toEqual({ width: 192, height: 192 });
    expect(pngSize(path.join(PUBLIC, "icon-512.png"))).toEqual({ width: 512, height: 512 });
  });

  it("ships favicon.ico with 16, 32 and 48 px images (file convention)", () => {
    expect(icoSizes(path.join(APP, "favicon.ico"))).toEqual([16, 32, 48]);
  });
});

describe("favicon.ico link under a base path", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds the base-path favicon link only when a base path is set (Next omits it then)", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    expect(renderToStaticMarkup(<BasePathFaviconLink />)).toBe("");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/skot");
    expect(renderToStaticMarkup(<BasePathFaviconLink />)).toBe('<link rel="icon" href="/skot/favicon.ico" sizes="48x48" type="image/x-icon"/>');
  });

  it("the root layout renders it in <head>", () => {
    const layout = readFileSync(path.join(APP, "layout.tsx"), "utf8");
    expect(layout).toMatch(/<head>[\s\S]*<BasePathFaviconLink \/>[\s\S]*<\/head>/);
  });
});

describe("web manifest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["", "/skot"])("base %j: valid manifest whose icons exist at the declared sizes", (basePath) => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
    const m = manifest();
    expect(m.name).toContain("Skot");
    expect(m.short_name).toBe("Skot");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe(`${basePath}/`);
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith(`${basePath}/`)).toBe(true);
      const file = path.join(PUBLIC, icon.src.slice(basePath.length));
      expect(existsSync(file)).toBe(true);
      const { width, height } = pngSize(file);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe("Beta badge", () => {
  it("renders a visible Beta pill next to the Skot name", () => {
    const html = renderToStaticMarkup(<BrandWordmark />);
    expect(html).toMatch(/>Skot</);
    const pill = html.match(/<span[^>]*data-beta-badge[^>]*>([^<]*)<\/span>/);
    expect(pill?.[1]).toBe("Beta");
    expect(pill?.[0]).not.toMatch(/sr-only|hidden|opacity-0|aria-hidden="true"/);
    expect(html.indexOf(">Skot<")).toBeLessThan(html.indexOf("data-beta-badge"));
  });

  it("the app header uses the wordmark with the badge", () => {
    const src = readFileSync(path.join(ROOT, "src", "components", "jev", "JevWorkspace.tsx"), "utf8");
    expect(src).toMatch(/<BrandWordmark\b/);
  });
});
