import { z } from "zod";
import type { StorageLike } from "./recovery-buffer";

export const FEEDBACK_STORAGE_KEY = "jev_suggestion_feedback_v1";
export const MAX_FEEDBACK_KEYS = 64;
export const MAX_FEEDBACK_STORAGE_BYTES = 32 * 1024;
export const MAX_PREFERENCE_SUMMARY_ITEMS = 6;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_KEY_PATTERN = /^[a-z0-9:_-]{2,64}$/;

function isSafeFeedbackKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key) && SAFE_KEY_PATTERN.test(key);
}

function hasForbiddenOwnKeys(obj: unknown, depth = 0): boolean {
  if (depth > 6 || !obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => hasForbiddenOwnKeys(item, depth + 1));
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenOwnKeys(rec[key], depth + 1)) return true;
  }
  return false;
}

const feedbackEntrySchema = z.object({
  shown: z.number().int().min(0).max(1_000_000),
  accepted: z.number().int().min(0).max(1_000_000),
  rejected: z.number().int().min(0).max(1_000_000),
  lastUpdatedAt: z.number().finite().min(0),
});

export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;

const feedbackProfileSchema = z.object({
  version: z.literal(1),
  totals: z.object({
    shown: z.number().int().min(0).max(10_000_000),
    accepted: z.number().int().min(0).max(10_000_000),
    rejected: z.number().int().min(0).max(10_000_000),
  }),
  entries: z
    .record(z.string(), feedbackEntrySchema)
    .refine((map) => {
      const keys = Object.keys(map);
      if (keys.length > MAX_FEEDBACK_KEYS) return false;
      return keys.every(isSafeFeedbackKey);
    }, "Invalid or oversized feedback entries map"),
});

export type FeedbackProfile = z.infer<typeof feedbackProfileSchema>;

export const feedbackPreferenceSummarySchema = z
  .object({
    preferred: z
      .array(z.string().refine(isSafeFeedbackKey, "Invalid feedback key"))
      .max(MAX_PREFERENCE_SUMMARY_ITEMS),
    avoided: z
      .array(z.string().refine(isSafeFeedbackKey, "Invalid feedback key"))
      .max(MAX_PREFERENCE_SUMMARY_ITEMS),
    totalAccepted: z.number().int().min(0).max(10_000_000),
    totalRejected: z.number().int().min(0).max(10_000_000),
  })
  .strict();

export type FeedbackPreferenceSummary = z.infer<
  typeof feedbackPreferenceSummarySchema
>;

export function createEmptyFeedbackProfile(): FeedbackProfile {
  return {
    version: 1,
    totals: { shown: 0, accepted: 0, rejected: 0 },
    entries: {},
  };
}

export function sanitizeFeedbackKey(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmedLower = raw.trim().toLowerCase();
  if (FORBIDDEN_KEYS.has(trimmedLower)) return null;
  const normalized = trimmedLower
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!isSafeFeedbackKey(normalized)) return null;
  return normalized;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function loadFeedbackProfile(
  storage: StorageLike | null | undefined
): FeedbackProfile {
  if (!storage) return createEmptyFeedbackProfile();
  try {
    const raw = storage.getItem(FEEDBACK_STORAGE_KEY);
    if (!raw || utf8ByteLength(raw) > MAX_FEEDBACK_STORAGE_BYTES) {
      return createEmptyFeedbackProfile();
    }
    const decoded: unknown = JSON.parse(raw);
    if (!decoded || typeof decoded !== "object" || hasForbiddenOwnKeys(decoded)) {
      return createEmptyFeedbackProfile();
    }
    const parsed = feedbackProfileSchema.safeParse(decoded);
    if (!parsed.success) return createEmptyFeedbackProfile();

    // Clone into a prototype-safe plain object
    const safeEntries: Record<string, FeedbackEntry> = Object.create(null);
    for (const [k, v] of Object.entries(parsed.data.entries)) {
      if (isSafeFeedbackKey(k)) {
        safeEntries[k] = v;
      }
    }
    return {
      version: 1,
      totals: { ...parsed.data.totals },
      entries: { ...safeEntries },
    };
  } catch {
    return createEmptyFeedbackProfile();
  }
}

function trimProfileEntries(
  profile: FeedbackProfile,
  maxKeys: number
): FeedbackProfile {
  const entriesList = Object.entries(profile.entries);
  if (entriesList.length <= maxKeys) return profile;

  entriesList.sort((a, b) => {
    if (b[1].lastUpdatedAt !== a[1].lastUpdatedAt) {
      return b[1].lastUpdatedAt - a[1].lastUpdatedAt;
    }
    const scoreA = a[1].accepted + a[1].rejected;
    const scoreB = b[1].accepted + b[1].rejected;
    return scoreB - scoreA;
  });

  const kept: Record<string, FeedbackEntry> = {};
  for (const [k, v] of entriesList.slice(0, maxKeys)) {
    kept[k] = v;
  }
  return {
    version: 1,
    totals: { ...profile.totals },
    entries: kept,
  };
}

function writeFeedbackProfile(
  storage: StorageLike | null | undefined,
  profile: FeedbackProfile
): FeedbackProfile {
  let candidate = trimProfileEntries(profile, MAX_FEEDBACK_KEYS);
  if (!storage) return candidate;

  let limit = Object.keys(candidate.entries).length;
  while (limit >= 0) {
    try {
      const serialized = JSON.stringify(candidate);
      if (utf8ByteLength(serialized) > MAX_FEEDBACK_STORAGE_BYTES && limit > 0) {
        limit = Math.max(0, Math.floor(limit / 2));
        candidate = trimProfileEntries(candidate, limit);
        continue;
      }
      storage.setItem(FEEDBACK_STORAGE_KEY, serialized);
      return candidate;
    } catch {
      if (limit <= 1) {
        try {
          storage.removeItem(FEEDBACK_STORAGE_KEY);
        } catch {
          // ignore storage errors
        }
        return createEmptyFeedbackProfile();
      }
      limit = Math.max(1, Math.floor(limit * 0.7));
      candidate = trimProfileEntries(candidate, limit);
    }
  }
  return candidate;
}

function updateFeedbackKeys(
  storage: StorageLike | null | undefined,
  rawKeys: string[],
  field: "shown" | "accepted" | "rejected",
  now = Date.now()
): FeedbackProfile {
  const cleanKeys = Array.from(
    new Set(
      rawKeys
        .map(sanitizeFeedbackKey)
        .filter((k): k is string => k !== null)
    )
  );
  if (cleanKeys.length === 0) {
    return loadFeedbackProfile(storage);
  }

  const profile = loadFeedbackProfile(storage);
  const nextEntries: Record<string, FeedbackEntry> = { ...profile.entries };

  for (const key of cleanKeys) {
    const existing = Object.prototype.hasOwnProperty.call(nextEntries, key)
      ? nextEntries[key]
      : { shown: 0, accepted: 0, rejected: 0, lastUpdatedAt: 0 };
    nextEntries[key] = {
      shown: existing.shown + (field === "shown" ? 1 : 0),
      accepted: existing.accepted + (field === "accepted" ? 1 : 0),
      rejected: existing.rejected + (field === "rejected" ? 1 : 0),
      lastUpdatedAt: Math.max(existing.lastUpdatedAt, now),
    };
  }

  const nextProfile: FeedbackProfile = {
    version: 1,
    totals: {
      shown: profile.totals.shown + (field === "shown" ? 1 : 0),
      accepted: profile.totals.accepted + (field === "accepted" ? 1 : 0),
      rejected: profile.totals.rejected + (field === "rejected" ? 1 : 0),
    },
    entries: nextEntries,
  };

  return writeFeedbackProfile(storage, nextProfile);
}

export function recordSuggestionShown(
  storage: StorageLike | null | undefined,
  keys: string[],
  now = Date.now()
): FeedbackProfile {
  return updateFeedbackKeys(storage, keys, "shown", now);
}

export function recordSuggestionAccepted(
  storage: StorageLike | null | undefined,
  keys: string[],
  now = Date.now()
): FeedbackProfile {
  return updateFeedbackKeys(storage, keys, "accepted", now);
}

export function recordSuggestionRejected(
  storage: StorageLike | null | undefined,
  keys: string[],
  now = Date.now()
): FeedbackProfile {
  return updateFeedbackKeys(storage, keys, "rejected", now);
}

export function clearFeedbackProfile(
  storage: StorageLike | null | undefined
): void {
  if (!storage) return;
  try {
    storage.removeItem(FEEDBACK_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

/**
 * Bayesian / Laplace-smoothed acceptance rate centered at 0.5 for unseen patterns.
 */
export function computeSmoothedAcceptanceRate(entry: FeedbackEntry | undefined): number {
  if (!entry) return 0.5;
  const implicitSkips = Math.max(0, entry.shown - entry.accepted - entry.rejected);
  const priorAlpha = 1.5;
  const priorBeta = 1.5;
  const denom = entry.accepted + entry.rejected + implicitSkips * 0.15 + priorAlpha + priorBeta;
  return (entry.accepted + priorAlpha) / denom;
}

/**
 * Computes a bounded feedback boost/penalty in [-0.22, +0.22] for a candidate's pattern keys.
 */
export function computeFeedbackAffinity(
  keys: string[],
  profile: FeedbackProfile
): number {
  const clean = keys
    .map(sanitizeFeedbackKey)
    .filter((k): k is string => k !== null);
  if (clean.length === 0) return 0;

  let sumDelta = 0;
  let count = 0;
  for (const key of clean) {
    if (!Object.prototype.hasOwnProperty.call(profile.entries, key)) continue;
    const rate = computeSmoothedAcceptanceRate(profile.entries[key]);
    sumDelta += (rate - 0.5) * 0.44;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.max(-0.22, Math.min(0.22, sumDelta / count));
}

export interface RankableCandidate<T> {
  feedbackKeys: string[];
  baseScore?: number;
  item?: T;
}

/**
 * Deterministically re-ranks candidates using acceptance/rejection history without
 * mutating the input items or fabricating AI probabilities.
 */
export function rankCandidatesWithFeedback<
  T extends { feedbackKeys: string[]; baseScore?: number }
>(
  candidates: T[],
  profile: FeedbackProfile
): Array<{ item: T; score: number; affinity: number }> {
  const total = Math.max(1, candidates.length);
  return candidates
    .map((item, idx) => {
      const defaultBase = 0.5 + ((total - idx) / total) * 0.08;
      const base =
        typeof item.baseScore === "number" && Number.isFinite(item.baseScore)
          ? item.baseScore
          : defaultBase;
      const affinity = computeFeedbackAffinity(item.feedbackKeys, profile);
      return {
        item,
        score: Number((base + affinity).toFixed(5)),
        affinity: Number(affinity.toFixed(5)),
        originalIdx: idx,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.originalIdx - b.originalIdx;
    })
    .map(({ item, score, affinity }) => ({ item, score, affinity }));
}

/**
 * Produces a tiny bounded preference summary (<= 6 preferred, <= 6 avoided)
 * safe to include optionally in /api/jev/decide requests.
 */
export function buildFeedbackPreferenceSummary(
  profile: FeedbackProfile
): FeedbackPreferenceSummary | null {
  const scored = Object.entries(profile.entries)
    .filter(([k, e]) => isSafeFeedbackKey(k) && e.accepted + e.rejected > 0)
    .map(([key, entry]) => ({
      key,
      rate: computeSmoothedAcceptanceRate(entry),
      signal: entry.accepted + entry.rejected,
    }));

  if (scored.length === 0) return null;

  const preferred = scored
    .filter((s) => s.rate >= 0.56)
    .sort((a, b) => b.rate - a.rate || b.signal - a.signal)
    .slice(0, MAX_PREFERENCE_SUMMARY_ITEMS)
    .map((s) => s.key);

  const avoided = scored
    .filter((s) => s.rate <= 0.44)
    .sort((a, b) => a.rate - b.rate || b.signal - a.signal)
    .slice(0, MAX_PREFERENCE_SUMMARY_ITEMS)
    .map((s) => s.key);

  if (preferred.length === 0 && avoided.length === 0) return null;

  return {
    preferred,
    avoided,
    totalAccepted: profile.totals.accepted,
    totalRejected: profile.totals.rejected,
  };
}
