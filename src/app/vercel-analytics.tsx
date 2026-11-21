import { SkotAnalytics } from "./vercel-analytics-client";

type Env = Record<string, string | undefined>;

export function isVercelDeployment(env: Env = process.env): boolean {
  return env.VERCEL === "1";
}

export function VercelAnalytics({ env = process.env }: { env?: Env } = {}) {
  return isVercelDeployment(env) ? <SkotAnalytics /> : null;
}
