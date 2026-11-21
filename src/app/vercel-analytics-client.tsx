"use client";

import { Analytics } from "@vercel/analytics/next";
import { dropUrlFragment } from "@/lib/analytics-privacy";

export function SkotAnalytics() {
  return <Analytics beforeSend={dropUrlFragment} />;
}
