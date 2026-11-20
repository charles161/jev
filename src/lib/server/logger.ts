export type ServerLogLevel = "info" | "warn" | "error";

export interface ServerLogEvent {
  route: string;
  event: string;
  mode?: string;
  method?: string;
  status?: number;
  upstreamStatus?: number;
  errorClass?: string;
  errorCode?: string;
  latencyMs?: number;
  degraded?: boolean;
}

/**
 * Emits a structured single-line JSON log with an explicit allowlist of safe
 * operational fields. Never logs secrets, headers, prompts, or user content.
 */
export function logServerEvent(
  level: ServerLogLevel,
  fields: ServerLogEvent
): void {
  const record: Record<string, string | number | boolean> = {
    ts: new Date().toISOString(),
    level,
    route: fields.route,
    event: fields.event,
  };

  if (fields.method !== undefined) record.method = fields.method;
  if (fields.mode !== undefined) record.mode = fields.mode;
  if (fields.status !== undefined) record.status = fields.status;
  if (fields.upstreamStatus !== undefined) {
    record.upstreamStatus = fields.upstreamStatus;
  }
  if (fields.errorClass !== undefined) record.errorClass = fields.errorClass;
  if (fields.errorCode !== undefined) record.errorCode = fields.errorCode;
  if (fields.latencyMs !== undefined) record.latencyMs = fields.latencyMs;
  if (fields.degraded !== undefined) record.degraded = fields.degraded;

  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export function classifyServerError(err: unknown): {
  errorClass: string;
  errorCode?: string;
  upstreamStatus?: number;
} {
  if (err && typeof err === "object") {
    const e = err as {
      name?: unknown;
      code?: unknown;
      status?: unknown;
    };
    const errorClass =
      typeof e.name === "string" && e.name.length > 0 ? e.name : "Error";
    const errorCode =
      typeof e.code === "string" && e.code.length > 0 ? e.code : undefined;
    const upstreamStatus =
      typeof e.status === "number" && Number.isInteger(e.status)
        ? e.status
        : undefined;
    return { errorClass, errorCode, upstreamStatus };
  }
  return { errorClass: "UnknownError" };
}
