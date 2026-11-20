import {
  boardRecoveryEntrySchema,
  MAX_RECOVERY_SNAPSHOTS,
  parseRecoveryBuffer,
  type BoardRecoveryEntry,
} from "./sync-validation";

export { MAX_RECOVERY_SNAPSHOTS };
export type { BoardRecoveryEntry };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function getRecoveryStorageKey(roomId: string): string {
  return `jev_recovery_${roomId}`;
}

export function loadRecoverySnapshots(
  storage: StorageLike | null | undefined,
  roomId: string
): BoardRecoveryEntry[] {
  if (!storage || !roomId) return [];
  try {
    const raw = storage.getItem(getRecoveryStorageKey(roomId));
    if (!raw) return [];
    return parseRecoveryBuffer(raw);
  } catch {
    return [];
  }
}

function writeRecoverySnapshots(
  storage: StorageLike | null | undefined,
  roomId: string,
  entries: BoardRecoveryEntry[]
): BoardRecoveryEntry[] {
  if (!storage || !roomId) return entries;
  const key = getRecoveryStorageKey(roomId);
  if (entries.length === 0) {
    try {
      storage.removeItem(key);
    } catch {
      // ignore storage errors
    }
    return [];
  }

  let candidate = entries.slice(0, MAX_RECOVERY_SNAPSHOTS);
  while (candidate.length > 0) {
    try {
      storage.setItem(key, JSON.stringify(candidate));
      return candidate;
    } catch {
      // Trim oldest entry on QuotaExceededError and retry
      candidate = candidate.slice(0, candidate.length - 1);
    }
  }
  return [];
}

/**
 * Prepends a pre-change board snapshot into the room's bounded 8-snapshot ring buffer
 * (newest first; oldest evicted beyond MAX_RECOVERY_SNAPSHOTS).
 */
export function pushRecoverySnapshot(
  storage: StorageLike | null | undefined,
  roomId: string,
  entry: BoardRecoveryEntry
): BoardRecoveryEntry[] {
  const validated = boardRecoveryEntrySchema.safeParse(entry);
  if (!validated.success) {
    return loadRecoverySnapshots(storage, roomId);
  }
  const existing = loadRecoverySnapshots(storage, roomId);
  const next = [validated.data, ...existing].slice(0, MAX_RECOVERY_SNAPSHOTS);
  return writeRecoverySnapshots(storage, roomId, next);
}

/**
 * Pops and returns the most recently saved recovery snapshot for a room.
 */
export function popRecoverySnapshot(
  storage: StorageLike | null | undefined,
  roomId: string
): { entry: BoardRecoveryEntry | null; remaining: BoardRecoveryEntry[] } {
  const existing = loadRecoverySnapshots(storage, roomId);
  if (existing.length === 0) {
    return { entry: null, remaining: [] };
  }
  const [latest, ...rest] = existing;
  const remaining = writeRecoverySnapshots(storage, roomId, rest);
  return { entry: latest, remaining };
}

export function clearRecoverySnapshots(
  storage: StorageLike | null | undefined,
  roomId: string
): void {
  if (!storage || !roomId) return;
  try {
    storage.removeItem(getRecoveryStorageKey(roomId));
  } catch {
    // ignore storage errors
  }
}
