import type { MetadataRoute } from "next";
import { BRAND_NAME, BRAND_TAGLINE } from "@/brand/brand";
import { appUrl } from "@/lib/base-path";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    short_name: BRAND_NAME,
    description: `${BRAND_NAME}: ${BRAND_TAGLINE} (beta)`,
    start_url: appUrl("/"),
    scope: appUrl("/"),
    display: "standalone",
    background_color: "#11151d",
    theme_color: "#d94e28",
    icons: [
      { src: appUrl("/icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: appUrl("/icon-512.png"), sizes: "512x512", type: "image/png" },
    ],
  };
}
