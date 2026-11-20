import { NextRequest, NextResponse } from "next/server";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

const CLIENT_IP_PATTERN = /^[0-9a-fA-F:.%-]{1,64}$/;

export function jsonNoStore(
  body: unknown,
  init?: Omit<ResponseInit, "headers"> & { headers?: HeadersInit }
): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

export type TrustProxyMode = "cloudflare" | "none";

export function getTrustProxyMode(
  env: NodeJS.ProcessEnv = process.env
): TrustProxyMode {
  const raw = env.TRUST_PROXY?.trim().toLowerCase();
  return raw === "cloudflare" ? "cloudflare" : "none";
}

function extractDirectPeerIp(request: NextRequest): string | null {
  const extended = request as NextRequest & {
    ip?: unknown;
    socket?: { remoteAddress?: unknown };
  };
  if (typeof extended.ip === "string") {
    const trimmed = extended.ip.trim();
    if (CLIENT_IP_PATTERN.test(trimmed)) return trimmed;
  }
  if (typeof extended.socket?.remoteAddress === "string") {
    const trimmed = extended.socket.remoteAddress.trim();
    if (CLIENT_IP_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Safely extracts a bounded client IP token for rate limiting and room caps.
 * Never trusts X-Forwarded-For or X-Real-IP (which are trivially spoofable).
 * - TRUST_PROXY=cloudflare: trusts CF-Connecting-IP ONLY.
 * - TRUST_PROXY=none (default): ignores proxy headers and uses direct socket/peer IP when available.
 */
export function getClientIp(
  request: NextRequest,
  env: NodeJS.ProcessEnv = process.env
): string {
  const mode = getTrustProxyMode(env);

  if (mode === "cloudflare") {
    const cfIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
    if (CLIENT_IP_PATTERN.test(cfIp)) {
      return cfIp;
    }
    return extractDirectPeerIp(request) ?? "unknown";
  }

  return extractDirectPeerIp(request) ?? "unknown";
}

export type ReadJsonBodyResult =
  | { ok: true; data: unknown; byteLength: number }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads and parses a JSON request body while strictly enforcing a UTF-8 byte cap
 * BEFORE calling JSON.parse. Streams chunks so chunked transfers without
 * Content-Length cannot exhaust memory.
 */
export async function readJsonBodyWithByteLimit(
  request: NextRequest,
  maxBytes: number
): Promise<ReadJsonBodyResult> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, status: 413, error: "Payload too large" };
    }
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "Invalid request body" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore stream cancel errors
        }
        return { ok: false, status: 413, error: "Payload too large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "Invalid request body" };
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    return { ok: false, status: 400, error: "Invalid UTF-8 request body" };
  }

  if (Buffer.byteLength(rawText, "utf8") > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }

  try {
    const data: unknown = JSON.parse(rawText);
    return { ok: true, data, byteLength: totalBytes };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
}
