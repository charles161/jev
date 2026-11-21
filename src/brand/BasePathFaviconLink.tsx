import { appUrl, normalizeBasePath } from "@/lib/base-path";

/** Next emits the app/favicon.ico <link> only without a base path; add it for the /skot build. */
export function BasePathFaviconLink() {
  if (!normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH)) return null;
  return <link rel="icon" href={appUrl("/favicon.ico")} sizes="48x48" type="image/x-icon" />;
}
