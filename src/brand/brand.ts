import type { Metadata } from "next";

export const BRAND_NAME = "Skot";
export const BRAND_TAGLINE = "sketch at the speed of thought";

const description =
  "Skot: sketch at the speed of thought. Write to draw instantly, drag with spatial intent understanding, Tab + Enter predictive drafting, and peer-to-peer WebRTC collaboration.";

export const siteMetadata = {
  title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
  description,
  applicationName: BRAND_NAME,
  openGraph: {
    title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    description,
    siteName: BRAND_NAME,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    description,
  },
} satisfies Metadata;
