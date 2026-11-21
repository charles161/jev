const BASE_PATH_PATTERN = /^(\/[A-Za-z0-9._~-]+)+$/;

export function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (value === "") {
    if ((raw ?? "").trim() !== "") {
      throw new Error('NEXT_PUBLIC_BASE_PATH "/" is the default root; leave it empty instead.');
    }
    return "";
  }
  if (!value.startsWith("/")) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH must start with "/", got "${value}".`);
  }
  if (!BASE_PATH_PATTERN.test(value)) {
    throw new Error(
      `NEXT_PUBLIC_BASE_PATH may only contain letters, digits and . _ ~ - segments, got "${value}".`
    );
  }
  return value;
}

export function appUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`appUrl() takes an absolute app path like "/api/signal", got "${path}".`);
  }
  return normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH) + path;
}
