import { MAX_TOMBSTONES } from "./sync-validation";
import type { ElementTombstone, JevElement, TombstoneMap } from "./types";

export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
export const BULK_DELETE_MIN_LOCAL_ELEMENTS = 1;
export const BULK_DELETE_REMOVAL_RATIO = 0.3;
const MAX_ADOPT_REV = 10_000;

export function createBoardEpoch(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `bep_${rand}`;
}

export interface BoardSyncState {
  elements: JevElement[];
  boardTitle: string;
  titleRev?: number;
  titleUpdatedBy?: string;
  titleUpdatedAt?: number;
  tombstones: TombstoneMap;
  tombstoneHorizonRev?: number;
  tombstoneHorizonAt?: number;
  boardEpoch?: string;
  boardEpochCreatedAt?: number;
  baseRev?: number;
  baseTimestamp?: number;
  hasLocalEdits: boolean;
}

export interface RemoteSyncPayload {
  elements: JevElement[];
  boardTitle: string;
  titleRev?: number;
  titleUpdatedBy?: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  tombstoneHorizonRev?: number;
  tombstoneHorizonAt?: number;
  boardEpoch?: string;
  boardEpochCreatedAt?: number;
  baseRev?: number;
  baseTimestamp?: number;
  fullResync?: boolean;
  hasLocalEdits?: boolean;
  /** Ignored for trust decisions; authority is derived strictly from server roster. */
  authoritative?: boolean;
  senderPeerId: string;
  /** Connection-bound peer ID verified from the RTCPeerConnection / signaling roster. */
  verifiedSenderPeerId?: string;
}

export interface MergeBoardOptions {
  /** Authoritative host peer ID derived strictly from the server-provided roster. */
  authoritativePeerId?: string | null;
  now?: number;
  maxTombstones?: number;
  tombstoneTtlMs?: number;
}

export interface DestructiveBoardChange {
  kind: "full_replace" | "bulk_delete";
  removedCount: number;
  localCount: number;
  removalRatio: number;
}

export interface BoardChangeDiff {
  deletedIds: string[];
  editedIds: string[];
  changedIds: string[];
  addedIds: string[];
  localCount: number;
  deletedCount: number;
  editedCount: number;
  changedCount: number;
  changeRatio: number;
  removalRatio: number;
}

export interface MergeBoardResult {
  state: BoardSyncState;
  changed: boolean;
  adoptedAuthoritative: boolean;
  needsFullResync: boolean;
  resyncReason?: "tombstone_horizon" | "epoch_mismatch";
  rejectedReason?: "unauthorized_bulk_delete";
  destructiveChange?: DestructiveBoardChange;
  changeDiff?: BoardChangeDiff;
}

export interface PeerAuthorityCandidate {
  peerId: string;
  /** Server-assigned join timestamp from /api/signal roster. */
  joinedAt: number;
  /** False for fresh unmodified empty joiners (ineligible for authority). */
  hasLocalEdits?: boolean;
  /** True for fresh unmodified empty joiners (ineligible for authority). */
  isFreshJoiner?: boolean;
  /** True when the peer is currently active in the server-provided roster (default: true). */
  inServerRoster?: boolean;
}

export interface ElectAuthoritativePeerOptions {
  /** Server-tracked creatorPeerId returned by /api/signal. */
  creatorPeerId?: string | null;
}

export function computeMaxKnownRev(state: {
  elements: JevElement[];
  tombstones?: TombstoneMap;
  titleRev?: number;
  tombstoneHorizonRev?: number;
  baseRev?: number;
}): number {
  let maxRev = Math.max(0, state.tombstoneHorizonRev ?? 0, state.titleRev ?? 0, state.baseRev ?? 0);
  for (const el of state.elements) {
    if (typeof el.rev === "number" && el.rev > maxRev) {
      maxRev = el.rev;
    }
  }
  if (state.tombstones) {
    for (const tomb of Object.values(state.tombstones)) {
      if (tomb.rev > maxRev) {
        maxRev = tomb.rev;
      }
    }
  }
  return maxRev;
}

/**
 * Returns 0 for fresh/unmodified starter boards, and >= 1 for any edited board
 * (including an intentionally cleared blank board).
 */
export function computeBoardContentRev(state: {
  elements: JevElement[];
  tombstones?: TombstoneMap;
  titleRev?: number;
  tombstoneHorizonRev?: number;
  baseRev?: number;
  hasLocalEdits?: boolean;
}): number {
  if (!state.hasLocalEdits) return 0;
  return Math.max(1, computeMaxKnownRev(state));
}

/**
 * Elects the single authoritative peer strictly from server-side roster facts:
 * 1. Peers not active in the server roster or known to be fresh unmodified joiners are NEVER eligible.
 * 2. If server-tracked `creatorPeerId` is currently active and eligible, `creatorPeerId` wins.
 * 3. Otherwise, earliest server-assigned `joinedAt` wins, with deterministic `peerId` tie-break.
 * Peer-reported `contentRev` / `baseRev` are NEVER consulted.
 */
export function electAuthoritativePeer(
  candidates: PeerAuthorityCandidate[],
  options: ElectAuthoritativePeerOptions = {}
): string | null {
  const eligible = candidates.filter((c) => {
    if (!c.peerId) return false;
    if (c.inServerRoster === false) return false;
    if (!Number.isFinite(c.joinedAt)) return false;
    if (c.isFreshJoiner === true) return false;
    if (c.hasLocalEdits === false) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  if (options.creatorPeerId) {
    const activeCreator = eligible.find(
      (c) => c.peerId === options.creatorPeerId
    );
    if (activeCreator) return activeCreator.peerId;
  }

  const sorted = [...eligible].sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });
  return sorted[0]?.peerId ?? null;
}

export function isBulkDeleteOrReplace(
  local: Pick<BoardSyncState, "elements" | "hasLocalEdits">,
  nextElements: JevElement[]
): {
  isDestructive: boolean;
  removedCount: number;
  localCount: number;
  removalRatio: number;
} {
  const localCount = local.elements.length;
  if (!local.hasLocalEdits || localCount < BULK_DELETE_MIN_LOCAL_ELEMENTS) {
    return { isDestructive: false, removedCount: 0, localCount, removalRatio: 0 };
  }
  const nextIds = new Set(nextElements.map((e) => e.id));
  let removedCount = 0;
  for (const el of local.elements) {
    if (!nextIds.has(el.id)) removedCount += 1;
  }
  const removalRatio = removedCount / localCount;
  return {
    isDestructive: removalRatio > BULK_DELETE_REMOVAL_RATIO,
    removedCount,
    localCount,
    removalRatio,
  };
}

export function diffBoardElements(
  prevElements: JevElement[],
  nextElements: JevElement[]
): BoardChangeDiff {
  const prevById = new Map(prevElements.map((e) => [e.id, e]));
  const nextById = new Map(nextElements.map((e) => [e.id, e]));
  const deletedIds: string[] = [];
  const editedIds: string[] = [];
  const changedIds: string[] = [];
  const addedIds: string[] = [];

  for (const prevEl of prevElements) {
    const nextEl = nextById.get(prevEl.id);
    if (!nextEl) {
      deletedIds.push(prevEl.id);
      changedIds.push(prevEl.id);
    } else if (!elementsContentEqual(prevEl, nextEl)) {
      editedIds.push(prevEl.id);
      changedIds.push(prevEl.id);
    }
  }

  for (const nextEl of nextElements) {
    if (!prevById.has(nextEl.id)) {
      addedIds.push(nextEl.id);
    }
  }

  const localCount = prevElements.length;
  const deletedCount = deletedIds.length;
  const editedCount = editedIds.length;
  const changedCount = changedIds.length;

  return {
    deletedIds,
    editedIds,
    changedIds,
    addedIds,
    localCount,
    deletedCount,
    editedCount,
    changedCount,
    changeRatio: localCount > 0 ? changedCount / localCount : 0,
    removalRatio: localCount > 0 ? deletedCount / localCount : 0,
  };
}

export function pruneTombstonesWithHorizon(
  tombstones: TombstoneMap,
  currentHorizonRev = 0,
  opts?: {
    maxTombstones?: number;
    ttlMs?: number;
    now?: number;
    currentHorizonAt?: number;
  }
): {
  tombstones: TombstoneMap;
  tombstoneHorizonRev: number;
  tombstoneHorizonAt: number;
} {
  const maxTombstones = opts?.maxTombstones ?? MAX_TOMBSTONES;
  const ttlMs = opts?.ttlMs;
  const now = opts?.now ?? Date.now();

  let horizon = Math.max(0, currentHorizonRev);
  let horizonAt = Math.max(0, opts?.currentHorizonAt ?? 0);
  const kept: Array<[string, ElementTombstone]> = [];

  for (const entry of Object.entries(tombstones)) {
    const [, tomb] = entry;
    if (
      ttlMs !== undefined &&
      ttlMs > 0 &&
      tomb.deletedAt > 0 &&
      now - tomb.deletedAt > ttlMs
    ) {
      horizon = Math.max(horizon, tomb.rev);
      horizonAt = Math.max(horizonAt, tomb.deletedAt);
      continue;
    }
    kept.push(entry);
  }

  if (kept.length <= maxTombstones) {
    return {
      tombstones: Object.fromEntries(kept),
      tombstoneHorizonRev: horizon,
      tombstoneHorizonAt: horizonAt,
    };
  }

  kept.sort((a, b) => {
    if (b[1].deletedAt !== a[1].deletedAt) {
      return b[1].deletedAt - a[1].deletedAt;
    }
    return b[1].rev - a[1].rev;
  });

  const retained = kept.slice(0, maxTombstones);
  const evicted = kept.slice(maxTombstones);
  for (const [, tomb] of evicted) {
    horizon = Math.max(horizon, tomb.rev);
    horizonAt = Math.max(horizonAt, tomb.deletedAt);
  }

  return {
    tombstones: Object.fromEntries(retained),
    tombstoneHorizonRev: horizon,
    tombstoneHorizonAt: horizonAt,
  };
}

export function elementsContentEqual(a: JevElement, b: JevElement): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.kind !== b.kind ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.label !== b.label ||
    a.sublabel !== b.sublabel ||
    a.tone !== b.tone ||
    a.seed !== b.seed ||
    a.fromId !== b.fromId ||
    a.toId !== b.toId ||
    a.arrowStyle !== b.arrowStyle ||
    a.dashed !== b.dashed ||
    a.bidirectional !== b.bidirectional
  ) {
    return false;
  }
  if (
    (a.fromPoint?.x ?? null) !== (b.fromPoint?.x ?? null) ||
    (a.fromPoint?.y ?? null) !== (b.fromPoint?.y ?? null) ||
    (a.toPoint?.x ?? null) !== (b.toPoint?.x ?? null) ||
    (a.toPoint?.y ?? null) !== (b.toPoint?.y ?? null)
  ) {
    return false;
  }
  const aPts = a.points;
  const bPts = b.points;
  if (Boolean(aPts) !== Boolean(bPts)) return false;
  if (aPts && bPts) {
    if (aPts.length !== bPts.length) return false;
    for (let i = 0; i < aPts.length; i += 1) {
      if (aPts[i].x !== bPts[i].x || aPts[i].y !== bPts[i].y) return false;
    }
  }
  return true;
}

function elementsFullyEqual(a: JevElement[], b: JevElement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ea = a[i];
    const eb = b[i];
    if (
      !elementsContentEqual(ea, eb) ||
      (ea.rev ?? 0) !== (eb.rev ?? 0) ||
      ea.updatedAt !== eb.updatedAt ||
      (ea.updatedBy ?? "") !== (eb.updatedBy ?? "")
    ) {
      return false;
    }
  }
  return true;
}

function tombstonesEqual(a: TombstoneMap, b: TombstoneMap): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const ta = a[key];
    const tb = b[key];
    if (
      !tb ||
      ta.rev !== tb.rev ||
      ta.deletedAt !== tb.deletedAt ||
      (ta.deletedBy ?? "") !== (tb.deletedBy ?? "")
    ) {
      return false;
    }
  }
  return true;
}

interface VersionVector {
  rev: number;
  ts: number;
  actor: string;
}

function compareVersions(a: VersionVector, b: VersionVector): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
}

function elementVersion(
  el: JevElement,
  fallbackActor: string,
  forceActor?: string
): VersionVector {
  return {
    rev: el.rev ?? 0,
    ts: el.updatedAt ?? 0,
    actor: forceActor ?? el.updatedBy ?? el.createdBy ?? fallbackActor,
  };
}

function tombstoneVersion(
  tomb: ElementTombstone,
  fallbackActor: string,
  forceActor?: string
): VersionVector {
  return {
    rev: tomb.rev,
    ts: tomb.deletedAt,
    actor: forceActor ?? tomb.deletedBy ?? fallbackActor,
  };
}

function sortElementsDeterministically(elements: JevElement[]): JevElement[] {
  return [...elements].sort((a, b) => {
    const aFrame = a.kind === "frame" ? 0 : 1;
    const bFrame = b.kind === "frame" ? 0 : 1;
    if (aFrame !== bFrame) return aFrame - bFrame;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function sanitizeAdoptedElements(
  elements: JevElement[],
  verifiedSenderId: string
): JevElement[] {
  return elements.map((el) => ({
    ...el,
    rev: Math.min(Math.max(0, el.rev ?? 1), MAX_ADOPT_REV),
    updatedBy: el.updatedBy ?? verifiedSenderId,
  }));
}

function sanitizeAdoptedTombstones(
  tombstones: TombstoneMap,
  verifiedSenderId: string
): TombstoneMap {
  const out: TombstoneMap = {};
  for (const [id, tomb] of Object.entries(tombstones)) {
    out[id] = {
      ...tomb,
      rev: Math.min(Math.max(0, tomb.rev), MAX_ADOPT_REV),
      deletedBy: tomb.deletedBy ?? verifiedSenderId,
    };
  }
  return out;
}

/**
 * Stamps monotonic element revisions & updatedAt timestamps on locally added/modified
 * elements, records tombstones for deleted elements, and tracks tombstoneHorizonRev
 * whenever old tombstones are pruned.
 */
export function applyLocalElementsChange(
  prevElements: JevElement[],
  nextElements: JevElement[],
  prevTombstones: TombstoneMap,
  peerId: string,
  now = Date.now(),
  prevHorizonRev = 0,
  opts?: { maxTombstones?: number; ttlMs?: number; prevHorizonAt?: number }
): {
  elements: JevElement[];
  tombstones: TombstoneMap;
  tombstoneHorizonRev: number;
  tombstoneHorizonAt: number;
} {
  const prevById = new Map(prevElements.map((e) => [e.id, e]));
  const nextIds = new Set<string>();
  const tombstones: TombstoneMap = { ...prevTombstones };

  const stamped = nextElements.map((el) => {
    nextIds.add(el.id);
    const prevEl = prevById.get(el.id);
    const priorTomb = tombstones[el.id];

    if (!prevEl) {
      const minRev = Math.max(
        prevHorizonRev + 1,
        priorTomb ? priorTomb.rev + 1 : 1
      );
      const minTs = priorTomb ? Math.max(now, priorTomb.deletedAt + 1) : now;
      if (priorTomb) {
        delete tombstones[el.id];
      }
      return {
        ...el,
        rev: Math.max(el.rev ?? 1, minRev),
        updatedAt: Math.max(el.updatedAt ?? minTs, minTs),
        updatedBy: peerId,
      };
    }

    if (elementsContentEqual(prevEl, el)) {
      return prevEl;
    }

    const nextRev = Math.max(
      (prevEl.rev ?? 0) + 1,
      el.rev ?? 1,
      prevHorizonRev + 1
    );
    const nextTs = Math.max(now, (prevEl.updatedAt ?? 0) + 1);
    return {
      ...el,
      rev: nextRev,
      updatedAt: nextTs,
      updatedBy: peerId,
    };
  });

  for (const prevEl of prevElements) {
    if (!nextIds.has(prevEl.id)) {
      const existingTomb = tombstones[prevEl.id];
      const baseRev = Math.max(
        prevEl.rev ?? 0,
        existingTomb?.rev ?? 0,
        prevHorizonRev
      );
      const baseTs = Math.max(
        prevEl.updatedAt ?? 0,
        existingTomb?.deletedAt ?? 0
      );
      tombstones[prevEl.id] = {
        rev: baseRev + 1,
        deletedAt: Math.max(now, baseTs + 1),
        deletedBy: peerId,
      };
    }
  }

  const pruned = pruneTombstonesWithHorizon(tombstones, prevHorizonRev, {
    maxTombstones: opts?.maxTombstones ?? MAX_TOMBSTONES,
    ttlMs: opts?.ttlMs,
    now,
    currentHorizonAt: opts?.prevHorizonAt,
  });

  return {
    elements: stamped,
    tombstones: pruned.tombstones,
    tombstoneHorizonRev: pruned.tombstoneHorizonRev,
    tombstoneHorizonAt: pruned.tombstoneHorizonAt,
  };
}

function buildAdoptedState(
  local: BoardSyncState,
  remote: RemoteSyncPayload,
  effectiveSenderId: string,
  options: MergeBoardOptions
): MergeBoardResult {
  const sanitizedElements = sanitizeAdoptedElements(
    remote.elements,
    effectiveSenderId
  );
  const sanitizedTombs = sanitizeAdoptedTombstones(
    remote.tombstones ?? {},
    effectiveSenderId
  );
  const remoteHorizon = Math.min(
    Math.max(0, remote.tombstoneHorizonRev ?? 0),
    MAX_ADOPT_REV
  );
  const maxAllowedTs = options.now !== undefined ? options.now : Number.MAX_SAFE_INTEGER;
  const clampedRemoteHorizonAt = Math.min(
    Math.max(0, remote.tombstoneHorizonAt ?? 0),
    maxAllowedTs
  );
  const pruned = pruneTombstonesWithHorizon(sanitizedTombs, remoteHorizon, {
    maxTombstones: options.maxTombstones ?? MAX_TOMBSTONES,
    ttlMs: options.tombstoneTtlMs,
    now: options.now,
    currentHorizonAt: clampedRemoteHorizonAt,
  });
  const adoptedTitleRev = Math.min(
    Math.max(0, remote.titleRev ?? 0),
    MAX_ADOPT_REV
  );
  const adoptedEpoch = remote.boardEpoch ?? local.boardEpoch;
  const adoptedEpochCreatedAt =
    remote.boardEpochCreatedAt ?? local.boardEpochCreatedAt;
  const adoptedBaseTimestamp =
    options.now !== undefined
      ? options.now
      : remote.baseTimestamp !== undefined
        ? Math.min(remote.baseTimestamp, maxAllowedTs)
        : local.baseTimestamp;

  const adoptedState: BoardSyncState = {
    elements: sanitizedElements,
    boardTitle: remote.boardTitle,
    titleRev: adoptedTitleRev,
    titleUpdatedBy: effectiveSenderId,
    titleUpdatedAt: remote.titleUpdatedAt ?? 0,
    tombstones: pruned.tombstones,
    tombstoneHorizonRev: pruned.tombstoneHorizonRev,
    ...(pruned.tombstoneHorizonAt > 0
      ? { tombstoneHorizonAt: pruned.tombstoneHorizonAt }
      : {}),
    ...(adoptedEpoch ? { boardEpoch: adoptedEpoch } : {}),
    ...(adoptedEpochCreatedAt !== undefined
      ? { boardEpochCreatedAt: adoptedEpochCreatedAt }
      : {}),
    ...(adoptedBaseTimestamp !== undefined
      ? { baseTimestamp: adoptedBaseTimestamp }
      : {}),
    hasLocalEdits: Boolean(remote.hasLocalEdits),
  };
  adoptedState.baseRev = Math.max(
    remote.baseRev !== undefined
      ? Math.min(Math.max(0, remote.baseRev), MAX_ADOPT_REV)
      : 0,
    computeMaxKnownRev(adoptedState)
  );

  const changed =
    !elementsFullyEqual(local.elements, adoptedState.elements) ||
    local.boardTitle !== adoptedState.boardTitle ||
    (local.titleRev ?? 0) !== (adoptedState.titleRev ?? 0) ||
    !tombstonesEqual(local.tombstones, adoptedState.tombstones) ||
    (local.tombstoneHorizonRev ?? 0) !==
      (adoptedState.tombstoneHorizonRev ?? 0) ||
    (local.tombstoneHorizonAt ?? 0) !==
      (adoptedState.tombstoneHorizonAt ?? 0) ||
    local.boardEpoch !== adoptedState.boardEpoch;

  const bulkCheck = isBulkDeleteOrReplace(local, adoptedState.elements);
  const changeDiff = diffBoardElements(local.elements, adoptedState.elements);

  return {
    state: adoptedState,
    changed,
    adoptedAuthoritative: true,
    needsFullResync: false,
    changeDiff,
    ...(bulkCheck.isDestructive
      ? {
          destructiveChange: {
            kind: "full_replace" as const,
            removedCount: bulkCheck.removedCount,
            localCount: bulkCheck.localCount,
            removalRatio: bulkCheck.removalRatio,
          },
        }
      : {}),
  };
}

/**
 * Merges a remote peer's board snapshot with local board state:
 * 1. Binds all tie-breaks and incoming authorship strictly to `verifiedSenderPeerId`.
 * 2. Ignores self-declared `remote.authoritative`; derives authority strictly from server-elected `options.authoritativePeerId`.
 * 3. Fresh unmodified joiners NEVER overwrite an edited board.
 * 4. Clamps incoming tombstones PER ELEMENT to `localElement.rev + 1` (or `existingTombstone.rev + 1` / `1` for unknown elements).
 * 5. Rejects any full replace or bulk delete removing >30% of a non-trivial local board (>=4 elements) unless sender is the server-elected authority.
 * 6. Refuses incremental merges across `boardEpoch` mismatch, `baseRev < tombstoneHorizonRev`, or offline >24h `baseTimestamp` staleness and signals full resync.
 * 7. Resolves board title conflicts using logical `titleRev` + verified `titleUpdatedBy` (clock-independent).
 */
export function mergeRemoteBoardState(
  local: BoardSyncState,
  remote: RemoteSyncPayload,
  localPeerId: string,
  options: MergeBoardOptions = {}
): MergeBoardResult {
  const effectiveSenderId = remote.verifiedSenderPeerId ?? remote.senderPeerId;
  const isVerifiedAuthoritative =
    options.authoritativePeerId !== undefined &&
    options.authoritativePeerId !== null &&
    options.authoritativePeerId === effectiveSenderId;
  const remoteTombstones = remote.tombstones ?? {};

  // 1. Protect edited local board from an unmodified fresh joiner (never trust remote.authoritative!)
  if (local.hasLocalEdits && remote.hasLocalEdits === false) {
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: false,
    };
  }

  // 2. Fresh unmodified joiner adopts edited / roster-authoritative remote board wholesale
  if (!local.hasLocalEdits && (isVerifiedAuthoritative || remote.hasLocalEdits)) {
    return buildAdoptedState(local, remote, effectiveSenderId, options);
  }

  // Pre-prune expired local tombstones when TTL is active so horizon advances before checks
  let effectiveLocalTombstones = local.tombstones;
  let localHorizon = local.tombstoneHorizonRev ?? 0;
  let localHorizonAt = local.tombstoneHorizonAt ?? 0;
  if (options.tombstoneTtlMs !== undefined && options.tombstoneTtlMs > 0) {
    const prePruned = pruneTombstonesWithHorizon(
      local.tombstones,
      localHorizon,
      {
        maxTombstones: options.maxTombstones ?? MAX_TOMBSTONES,
        ttlMs: options.tombstoneTtlMs,
        now: options.now,
        currentHorizonAt: localHorizonAt,
      }
    );
    effectiveLocalTombstones = prePruned.tombstones;
    localHorizon = prePruned.tombstoneHorizonRev;
    localHorizonAt = prePruned.tombstoneHorizonAt;
  }

  // 3. Epoch mismatch & tombstone horizon (rev + timestamp + 24h TTL) checks before incremental merge
  if (
    local.boardEpoch &&
    remote.boardEpoch &&
    local.boardEpoch !== remote.boardEpoch
  ) {
    if (isVerifiedAuthoritative && remote.fullResync) {
      return buildAdoptedState(local, remote, effectiveSenderId, options);
    }
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: true,
      resyncReason: "epoch_mismatch",
    };
  }

  // Epoch creation timestamp check: peer base predates current board epoch creation
  if (
    local.boardEpochCreatedAt !== undefined &&
    remote.baseTimestamp !== undefined &&
    remote.baseTimestamp < local.boardEpochCreatedAt &&
    !(isVerifiedAuthoritative && remote.fullResync)
  ) {
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: true,
      resyncReason: "epoch_mismatch",
    };
  }
  if (
    remote.boardEpochCreatedAt !== undefined &&
    local.baseTimestamp !== undefined &&
    local.baseTimestamp < remote.boardEpochCreatedAt
  ) {
    if (isVerifiedAuthoritative && remote.fullResync) {
      return buildAdoptedState(local, remote, effectiveSenderId, options);
    }
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: true,
      resyncReason: "epoch_mismatch",
    };
  }

  const remoteHorizon = remote.tombstoneHorizonRev ?? 0;
  const maxAllowedTs =
    options.now !== undefined ? options.now : Number.MAX_SAFE_INTEGER;
  const remoteHorizonAt = Math.min(
    Math.max(0, remote.tombstoneHorizonAt ?? 0),
    maxAllowedTs
  );
  const localKnownRev = Math.max(
    local.baseRev ?? 0,
    computeMaxKnownRev(local)
  );
  const ttlMs = options.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;
  const horizonCutoffAt =
    options.now !== undefined && ttlMs > 0 ? options.now - ttlMs : null;

  // Remote peer is stale relative to local's evicted tombstones (rev, pruned timestamp, or >24h offline TTL)
  const remotePredatesLocalHorizon =
    (localHorizon > 0 &&
      remote.baseRev !== undefined &&
      remote.baseRev < localHorizon) ||
    (localHorizonAt > 0 &&
      remote.baseTimestamp !== undefined &&
      remote.baseTimestamp < localHorizonAt) ||
    (horizonCutoffAt !== null &&
      remote.baseTimestamp !== undefined &&
      remote.baseTimestamp < horizonCutoffAt);

  if (remotePredatesLocalHorizon && !(isVerifiedAuthoritative && remote.fullResync)) {
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: true,
      resyncReason: "tombstone_horizon",
    };
  }

  // Local peer is stale relative to remote's evicted tombstones (rev, pruned timestamp, or >24h offline TTL)
  const localPredatesRemoteHorizon =
    (remoteHorizon > 0 && localKnownRev < remoteHorizon) ||
    (remoteHorizonAt > 0 &&
      local.baseTimestamp !== undefined &&
      local.baseTimestamp < remoteHorizonAt) ||
    (horizonCutoffAt !== null &&
      local.baseTimestamp !== undefined &&
      local.baseTimestamp < horizonCutoffAt &&
      remote.baseTimestamp !== undefined &&
      remote.baseTimestamp >= horizonCutoffAt);

  if (localPredatesRemoteHorizon) {
    if (isVerifiedAuthoritative && remote.fullResync) {
      return buildAdoptedState(local, remote, effectiveSenderId, options);
    }
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: true,
      resyncReason: "tombstone_horizon",
    };
  }

  // Explicit fullResync from the server-elected authoritative peer replaces state wholesale
  if (isVerifiedAuthoritative && remote.fullResync) {
    return buildAdoptedState(local, remote, effectiveSenderId, options);
  }

  // 4. Deterministic element-level commutative merge with per-element tombstone rev clamp & connection-bound actor identity
  const localMaxRev = computeMaxKnownRev(local);
  const localById = new Map(local.elements.map((e) => [e.id, e]));

  const clampedRemoteTombstones: TombstoneMap = {};
  for (const [id, rt] of Object.entries(remoteTombstones)) {
    const localEl = localById.get(id);
    const localTomb = effectiveLocalTombstones[id];
    const perElementBase = localEl
      ? Math.max(localEl.rev ?? 0, localTomb?.rev ?? 0)
      : (localTomb?.rev ?? 0);
    const ceiling = perElementBase + 1;
    clampedRemoteTombstones[id] = {
      ...rt,
      rev: Math.min(Math.max(0, rt.rev), ceiling),
      deletedBy: effectiveSenderId,
    };
  }

  const mergedTombstones: TombstoneMap = {};
  const allTombKeys = new Set([
    ...Object.keys(effectiveLocalTombstones),
    ...Object.keys(clampedRemoteTombstones),
  ]);
  for (const id of allTombKeys) {
    const lt = effectiveLocalTombstones[id];
    const rt = clampedRemoteTombstones[id];
    if (lt && !rt) {
      mergedTombstones[id] = lt;
    } else if (!lt && rt) {
      mergedTombstones[id] = rt;
    } else if (lt && rt) {
      const cmp = compareVersions(
        tombstoneVersion(lt, localPeerId),
        tombstoneVersion(rt, effectiveSenderId, effectiveSenderId)
      );
      mergedTombstones[id] = cmp >= 0 ? lt : rt;
    }
  }

  const remoteById = new Map<string, JevElement>();
  for (const rawRemoteEl of remote.elements) {
    const localEl = localById.get(rawRemoteEl.id);
    const localTomb = effectiveLocalTombstones[rawRemoteEl.id];
    const ceiling =
      Math.max(localMaxRev, localEl?.rev ?? 0, localTomb?.rev ?? 0) + 1;
    const clampedRev = Math.min(Math.max(0, rawRemoteEl.rev ?? 0), ceiling);
    remoteById.set(rawRemoteEl.id, {
      ...rawRemoteEl,
      rev: clampedRev,
      updatedBy: effectiveSenderId,
    });
  }

  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
  const mergedElements: JevElement[] = [];

  for (const id of allIds) {
    const localEl = localById.get(id);
    const remoteEl = remoteById.get(id);
    let winner: JevElement | null = null;
    let winnerActor = localPeerId;
    let forceWinnerActor: string | undefined;

    if (localEl && !remoteEl) {
      winner = localEl;
      winnerActor = localPeerId;
    } else if (!localEl && remoteEl) {
      winner = remoteEl;
      winnerActor = effectiveSenderId;
      forceWinnerActor = effectiveSenderId;
    } else if (localEl && remoteEl) {
      const cmp = compareVersions(
        elementVersion(localEl, localPeerId),
        elementVersion(remoteEl, effectiveSenderId, effectiveSenderId)
      );
      if (cmp > 0) {
        winner = localEl;
        winnerActor = localPeerId;
      } else if (cmp < 0) {
        winner = remoteEl;
        winnerActor = effectiveSenderId;
        forceWinnerActor = effectiveSenderId;
      } else {
        const localJson = JSON.stringify(localEl);
        const remoteJson = JSON.stringify(remoteEl);
        if (localJson >= remoteJson) {
          winner = localEl;
          winnerActor = localPeerId;
        } else {
          winner = remoteEl;
          winnerActor = effectiveSenderId;
          forceWinnerActor = effectiveSenderId;
        }
      }
    }

    if (!winner) continue;

    const tomb = mergedTombstones[id];
    if (tomb) {
      const elVer = elementVersion(winner, winnerActor, forceWinnerActor);
      const tombVer = tombstoneVersion(tomb, effectiveSenderId);
      if (compareVersions(tombVer, elVer) >= 0) {
        continue;
      }
      delete mergedTombstones[id];
    }

    mergedElements.push(winner);
  }

  const sortedElements = sortElementsDeterministically(mergedElements);

  // Safeguard: reject bulk deletes removing >30% of a non-trivial local board unless sender is server-elected authority
  const bulkCheck = isBulkDeleteOrReplace(local, sortedElements);
  if (bulkCheck.isDestructive && !isVerifiedAuthoritative) {
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
      needsFullResync: false,
      rejectedReason: "unauthorized_bulk_delete",
    };
  }

  const pruned = pruneTombstonesWithHorizon(
    mergedTombstones,
    Math.max(localHorizon, remoteHorizon),
    {
      maxTombstones: options.maxTombstones ?? MAX_TOMBSTONES,
      ttlMs: options.tombstoneTtlMs,
      now: options.now,
      currentHorizonAt: Math.max(localHorizonAt, remoteHorizonAt),
    }
  );

  // 5. Merge board title using logical titleRev + verified titleUpdatedBy (clamped; clock-independent)
  const localTitleRev = local.titleRev ?? 0;
  const localTitleActor = local.titleUpdatedBy ?? localPeerId;
  const clampedRemoteTitleRev = Math.min(
    Math.max(0, remote.titleRev ?? 0),
    localTitleRev + 1
  );

  let mergedTitle = local.boardTitle;
  let mergedTitleRev = localTitleRev;
  let mergedTitleUpdatedBy = localTitleActor;

  if (clampedRemoteTitleRev > localTitleRev) {
    mergedTitle = remote.boardTitle;
    mergedTitleRev = clampedRemoteTitleRev;
    mergedTitleUpdatedBy = effectiveSenderId;
  } else if (
    clampedRemoteTitleRev === localTitleRev &&
    remote.boardTitle !== local.boardTitle &&
    effectiveSenderId > localTitleActor
  ) {
    mergedTitle = remote.boardTitle;
    mergedTitleUpdatedBy = effectiveSenderId;
  }

  const mergedEpoch = local.boardEpoch ?? remote.boardEpoch;
  const mergedEpochCreatedAt =
    local.boardEpochCreatedAt ?? remote.boardEpochCreatedAt;
  const mergedBaseTimestamp =
    options.now !== undefined
      ? options.now
      : local.baseTimestamp !== undefined || remote.baseTimestamp !== undefined
        ? Math.min(
            maxAllowedTs,
            Math.max(local.baseTimestamp ?? 0, remote.baseTimestamp ?? 0)
          )
        : undefined;

  const nextState: BoardSyncState = {
    elements: sortedElements,
    boardTitle: mergedTitle,
    titleRev: mergedTitleRev,
    titleUpdatedBy: mergedTitleUpdatedBy,
    titleUpdatedAt: local.titleUpdatedAt ?? 0,
    tombstones: pruned.tombstones,
    tombstoneHorizonRev: pruned.tombstoneHorizonRev,
    ...(pruned.tombstoneHorizonAt > 0
      ? { tombstoneHorizonAt: pruned.tombstoneHorizonAt }
      : {}),
    ...(mergedEpoch ? { boardEpoch: mergedEpoch } : {}),
    ...(mergedEpochCreatedAt !== undefined
      ? { boardEpochCreatedAt: mergedEpochCreatedAt }
      : {}),
    ...(mergedBaseTimestamp !== undefined
      ? { baseTimestamp: mergedBaseTimestamp }
      : {}),
    hasLocalEdits: Boolean(local.hasLocalEdits || remote.hasLocalEdits),
  };
  nextState.baseRev = computeMaxKnownRev(nextState);

  const changed =
    !elementsFullyEqual(local.elements, nextState.elements) ||
    local.boardTitle !== nextState.boardTitle ||
    (local.titleRev ?? 0) !== (nextState.titleRev ?? 0) ||
    !tombstonesEqual(local.tombstones, nextState.tombstones) ||
    (local.tombstoneHorizonRev ?? 0) !==
      (nextState.tombstoneHorizonRev ?? 0) ||
    (local.tombstoneHorizonAt ?? 0) !== (nextState.tombstoneHorizonAt ?? 0);

  const changeDiff = diffBoardElements(local.elements, nextState.elements);

  return {
    state: nextState,
    changed,
    adoptedAuthoritative: false,
    needsFullResync: false,
    changeDiff,
    ...(bulkCheck.isDestructive
      ? {
          destructiveChange: {
            kind: "bulk_delete" as const,
            removedCount: bulkCheck.removedCount,
            localCount: bulkCheck.localCount,
            removalRatio: bulkCheck.removalRatio,
          },
        }
      : {}),
  };
}
