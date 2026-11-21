import type { Metadata } from "next";
import { appUrl } from "@/lib/base-path";

export const BRAND_NAME = "Skot";
export const BRAND_TAGLINE = "sketch at the speed of thought";

const description =
  "Skot: sketch at the speed of thought. Write to draw instantly, drag with spatial intent understanding, Tab + Enter predictive drafting (beta)";

export const DEFAULT_SITE_URL = "https://skot.lightslips.ai";
const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Absolute site origin for link previews: SITE_URL, else the request host, else production. */
export function resolveSiteUrl(source: {
  env?: Record<string, string | undefined>;
  host?: string | null;
  proto?: string | null;
}): string {
  const env = source.env ?? process.env;
  const fromEnv = originOf(env.SITE_URL);
  if (fromEnv) return fromEnv;
  const host = source.host?.split(",")[0]?.trim();
  if (host && HOST_PATTERN.test(host)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    const proto = local && source.proto?.split(",")[0]?.trim() === "http" ? "http" : "https";
    return `${proto}://${host}`;
  }
  return DEFAULT_SITE_URL;
}

const title = `${BRAND_NAME} — ${BRAND_TAGLINE}`;

export function buildSiteMetadata(siteUrl: string): Metadata {
  const image = {
    url: new URL(appUrl("/og.png"), siteUrl).toString(),
    width: 1200,
    height: 630,
    type: "image/png",
    alt: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
  };
  return {
    metadataBase: new URL(siteUrl),
    title,
    description,
    applicationName: BRAND_NAME,
    openGraph: {
      title,
      description,
      siteName: BRAND_NAME,
      type: "website",
      url: new URL(appUrl("/"), siteUrl).toString(),
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export const siteMetadata = buildSiteMetadata(DEFAULT_SITE_URL);
