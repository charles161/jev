import { z } from "zod";
import type { BoardSnapshot, JevElement, TombstoneMap } from "./types";

export const MAX_BOARD_ELEMENTS = 500;
export const MAX_LABEL_LENGTH = 500;
export const MAX_SUBLABEL_LENGTH = 500;
export const MAX_BOARD_TITLE_LENGTH = 120;
export const MAX_FREEDRAW_POINTS = 2000;
export const MAX_TOMBSTONES = 500;
export const MAX_WIRE_MESSAGE_BYTES = 512 * 1024;
export const MAX_STORAGE_BYTES = 1024 * 1024;
export const MAX_RECOVERY_SNAPSHOTS = 8;
export const MAX_RECOVERY_STORAGE_BYTES = MAX_STORAGE_BYTES * MAX_RECOVERY_SNAPSHOTS;

const COORD_LIMIT = 100_000;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(value: string): boolean {
  return !FORBIDDEN_KEYS.has(value);
}

const safeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isSafeKey, "Unsafe identifier");

const finiteCoordSchema = z
  .number()
  .finite()
  .min(-COORD_LIMIT)
  .max(COORD_LIMIT);

const pointSchema = z.object({
  x: finiteCoordSchema,
  y: finiteCoordSchema,
});

const elementKindSchema = z.enum([
  "node",
  "diamond",
  "database",
  "ellipse",
  "frame",
  "text",
  "arrow",
  "freedraw",
]);

const colorToneSchema = z.enum([
  "ink",
  "terracotta",
  "cobalt",
  "teal",
  "ochre",
  "plum",
  "slate",
]);

export const jevElementSchema: z.ZodType<JevElement> = z
  .object({
    id: safeIdSchema,
    kind: elementKindSchema,
    x: finiteCoordSchema,
    y: finiteCoordSchema,
    width: finiteCoordSchema,
    height: finiteCoordSchema,
    label: z.string().max(MAX_LABEL_LENGTH),
    sublabel: z.string().max(MAX_SUBLABEL_LENGTH).optional(),
    tone: colorToneSchema,
    seed: z.number().finite(),
    fromId: safeIdSchema.optional(),
    toId: safeIdSchema.optional(),
    fromPoint: pointSchema.optional(),
    toPoint: pointSchema.optional(),
    arrowStyle: z.enum(["curved", "straight"]).optional(),
    dashed: z.boolean().optional(),
    bidirectional: z.boolean().optional(),
    points: z.array(pointSchema).max(MAX_FREEDRAW_POINTS).optional(),
    createdAt: z.number().finite().min(0),
    updatedAt: z.number().finite().min(0),
    createdBy: z.string().max(128).optional(),
    updatedBy: z.string().max(128).optional(),
    rev: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .refine(
    (el) => el.kind === "arrow" || (el.width >= 0 && el.height >= 0),
    "Non-arrow elements must have non-negative dimensions"
  );

const tombstoneEntrySchema = z.object({
  deletedAt: z.number().finite().min(0),
  rev: z.number().int().min(0).max(1_000_000_000),
  deletedBy: z.string().max(128).optional(),
});

export const tombstoneMapSchema: z.ZodType<TombstoneMap> = z
  .record(z.string(), tombstoneEntrySchema)
  .refine(
    (map) => {
      const keys = Object.keys(map);
      if (keys.length > MAX_TOMBSTONES) return false;
      return keys.every(
        (k) => k.length >= 1 && k.length <= 128 && isSafeKey(k)
      );
    },
    "Invalid or oversized tombstones map"
  );

const peerIdWireSchema = safeIdSchema;
const peerNameSchema = z.string().trim().min(1).max(64);
const peerColorSchema = z.string().regex(HEX_COLOR_PATTERN);

const helloWireSchema = z.object({
  kind: z.literal("hello"),
  peerId: peerIdWireSchema,
  name: peerNameSchema,
  color: peerColorSchema,
  ts: z.number().finite().min(0),
  joinedAt: z.number().finite().min(0).optional(),
  hasLocalEdits: z.boolean().optional(),
  isAuthoritative: z.boolean().optional(),
});

const cursorWireSchema = z.object({
  kind: z.literal("cursor"),
  peerId: peerIdWireSchema,
  name: peerNameSchema,
  color: peerColorSchema,
  x: finiteCoordSchema,
  y: finiteCoordSchema,
  selectedId: safeIdSchema.nullable().optional(),
  ts: z.number().finite().min(0),
});

const syncStateWireSchema = z.object({
  kind: z.literal("sync_state"),
  peerId: peerIdWireSchema,
  elements: z.array(jevElementSchema).max(MAX_BOARD_ELEMENTS),
  boardTitle: z.string().max(MAX_BOARD_TITLE_LENGTH),
  ts: z.number().finite().min(0),
  authoritative: z.boolean().optional(),
  hasLocalEdits: z.boolean().optional(),
  titleRev: z.number().int().min(0).max(1_000_000_000).optional(),
  titleUpdatedBy: safeIdSchema.optional(),
  titleUpdatedAt: z.number().finite().min(0).optional(),
  tombstones: tombstoneMapSchema.optional(),
  tombstoneHorizonRev: z.number().int().min(0).max(1_000_000_000).optional(),
  tombstoneHorizonAt: z.number().finite().min(0).optional(),
  boardEpoch: safeIdSchema.optional(),
  boardEpochCreatedAt: z.number().finite().min(0).optional(),
  baseRev: z.number().int().min(0).max(1_000_000_000).optional(),
  baseTimestamp: z.number().finite().min(0).optional(),
  fullResync: z.boolean().optional(),
});

const requestSyncWireSchema = z.object({
  kind: z.literal("request_sync"),
  peerId: peerIdWireSchema,
  ts: z.number().finite().min(0),
  reason: z.enum(["initial", "resync"]).optional(),
});

const pingWireSchema = z.object({
  kind: z.literal("ping"),
  peerId: peerIdWireSchema,
  sentAt: z.number().finite().min(0),
});

const pongWireSchema = z.object({
  kind: z.literal("pong"),
  peerId: peerIdWireSchema,
  sentAt: z.number().finite().min(0),
});

export const collabWireMessageSchema = z.discriminatedUnion("kind", [
  helloWireSchema,
  cursorWireSchema,
  syncStateWireSchema,
  requestSyncWireSchema,
  pingWireSchema,
  pongWireSchema,
]);

export type ValidatedCollabWireMessage = z.infer<typeof collabWireMessageSchema>;

export const storedBoardSnapshotSchema = z.object({
  elements: z.array(jevElementSchema).max(MAX_BOARD_ELEMENTS),
  boardTitle: z.string().max(MAX_BOARD_TITLE_LENGTH).optional(),
  titleRev: z.number().int().min(0).max(1_000_000_000).optional(),
  titleUpdatedBy: safeIdSchema.optional(),
  titleUpdatedAt: z.number().finite().min(0).optional(),
  tombstones: tombstoneMapSchema.optional(),
  tombstoneHorizonRev: z.number().int().min(0).max(1_000_000_000).optional(),
  tombstoneHorizonAt: z.number().finite().min(0).optional(),
  boardEpoch: safeIdSchema.optional(),
  boardEpochCreatedAt: z.number().finite().min(0).optional(),
  baseTimestamp: z.number().finite().min(0).optional(),
  hasLocalEdits: z.boolean().optional(),
});

export type StoredBoardSnapshot = Omit<BoardSnapshot, "boardTitle"> & {
  boardTitle?: string;
};

export const boardRecoveryEntrySchema = z.object({
  id: safeIdSchema,
  savedAt: z.number().finite().min(0),
  reason: z.enum([
    "authoritative_replace",
    "authoritative_bulk_delete",
    "remote_change_threshold",
    "peer_quarantine",
    "periodic",
    "manual",
  ]),
  removedCount: z.number().int().min(0).max(MAX_BOARD_ELEMENTS),
  editedCount: z.number().int().min(0).max(MAX_BOARD_ELEMENTS).optional(),
  previousElementCount: z.number().int().min(0).max(MAX_BOARD_ELEMENTS),
  snapshot: storedBoardSnapshotSchema,
});

export const boardRecoveryBufferSchema = z
  .array(boardRecoveryEntrySchema)
  .max(MAX_RECOVERY_SNAPSHOTS);

export type BoardRecoveryEntry = z.infer<typeof boardRecoveryEntrySchema>;

const manualSdpSchema = z.object({
  v: z.literal(1),
  from: safeIdSchema,
  name: peerNameSchema,
  sdp: z.object({
    type: z.enum(["offer", "answer"]),
    sdp: z
      .string()
      .min(10)
      .max(40_000)
      .refine((v) => v.startsWith("v=0"), "Invalid SDP"),
  }),
});

export type ValidatedManualSdp = z.infer<typeof manualSdpSchema>;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Strips any prototype-polluting own keys safely from parsed JSON objects before Zod validation.
 */
function hasForbiddenOwnKeys(obj: unknown, depth = 0): boolean {
  if (depth > 8 || !obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => hasForbiddenOwnKeys(item, depth + 1));
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenOwnKeys(record[key], depth + 1)) return true;
  }
  return false;
}

export function parseWireMessage(
  raw: unknown
): ValidatedCollabWireMessage | null {
  if (!raw || typeof raw !== "object") return null;
  if (hasForbiddenOwnKeys(raw)) return null;
  const parsed = collabWireMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseRawDataChannelMessage(
  rawData: unknown
): ValidatedCollabWireMessage | null {
  if (typeof rawData !== "string") return null;
  if (rawData.length === 0 || utf8ByteLength(rawData) > MAX_WIRE_MESSAGE_BYTES) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawData);
  } catch {
    return null;
  }
  return parseWireMessage(decoded);
}

export function parseStoredBoardSnapshot(
  rawJson: string
): StoredBoardSnapshot | null {
  if (
    typeof rawJson !== "string" ||
    rawJson.length === 0 ||
    utf8ByteLength(rawJson) > MAX_STORAGE_BYTES
  ) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || hasForbiddenOwnKeys(decoded)) {
    return null;
  }
  const parsed = storedBoardSnapshotSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

export function parseManualSdpPayload(raw: unknown): ValidatedManualSdp | null {
  if (!raw || typeof raw !== "object" || hasForbiddenOwnKeys(raw)) return null;
  const parsed = manualSdpSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseRecoveryBuffer(rawJson: string): BoardRecoveryEntry[] {
  if (
    typeof rawJson !== "string" ||
    rawJson.length === 0 ||
    utf8ByteLength(rawJson) > MAX_RECOVERY_STORAGE_BYTES
  ) {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded) || hasForbiddenOwnKeys(decoded)) {
    return [];
  }
  const parsed = boardRecoveryBufferSchema.safeParse(decoded);
  return parsed.success ? parsed.data : [];
}
