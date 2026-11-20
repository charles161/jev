import { MAX_TOMBSTONES } from "./sync-validation";
import type { ElementTombstone, JevElement, TombstoneMap } from "./types";

export interface BoardSyncState {
  elements: JevElement[];
  boardTitle: string;
  titleUpdatedAt: number;
  tombstones: TombstoneMap;
  hasLocalEdits: boolean;
}

export interface RemoteSyncPayload {
  elements: JevElement[];
  boardTitle: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  hasLocalEdits?: boolean;
  authoritative?: boolean;
  senderPeerId: string;
}

export interface MergeBoardResult {
  state: BoardSyncState;
  changed: boolean;
  adoptedAuthoritative: boolean;
}

function pruneTombstones(tombstones: TombstoneMap): TombstoneMap {
  const entries = Object.entries(tombstones);
  if (entries.length <= MAX_TOMBSTONES) return tombstones;
  entries.sort((a, b) => b[1].deletedAt - a[1].deletedAt);
  return Object.fromEntries(entries.slice(0, MAX_TOMBSTONES));
}

function elementsContentEqual(a: JevElement, b: JevElement): boolean {
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

function elementVersion(el: JevElement, fallbackActor: string): VersionVector {
  return {
    rev: el.rev ?? 0,
    ts: el.updatedAt ?? 0,
    actor: el.updatedBy ?? el.createdBy ?? fallbackActor,
  };
}

function tombstoneVersion(
  tomb: ElementTombstone,
  fallbackActor: string
): VersionVector {
  return {
    rev: tomb.rev,
    ts: tomb.deletedAt,
    actor: tomb.deletedBy ?? fallbackActor,
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

/**
 * Stamps monotonic element revisions & updatedAt timestamps on locally added/modified
 * elements, and records tombstones for any elements deleted by a local action.
 */
export function applyLocalElementsChange(
  prevElements: JevElement[],
  nextElements: JevElement[],
  prevTombstones: TombstoneMap,
  peerId: string,
  now = Date.now()
): { elements: JevElement[]; tombstones: TombstoneMap } {
  const prevById = new Map(prevElements.map((e) => [e.id, e]));
  const nextIds = new Set<string>();
  const tombstones: TombstoneMap = { ...prevTombstones };

  const stamped = nextElements.map((el) => {
    nextIds.add(el.id);
    const prevEl = prevById.get(el.id);
    const priorTomb = tombstones[el.id];

    if (!prevEl) {
      const minRev = priorTomb ? priorTomb.rev + 1 : 1;
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

    const nextRev = Math.max((prevEl.rev ?? 0) + 1, el.rev ?? 1);
    const nextTs = Math.max(now, (prevEl.updatedAt ?? 0) + 1);
    return {
      ...el,
      rev: nextRev,
      updatedAt: nextTs,
      updatedBy: peerId,
    };
  });

  // Record tombstones for elements removed in this local edit
  for (const prevEl of prevElements) {
    if (!nextIds.has(prevEl.id)) {
      const existingTomb = tombstones[prevEl.id];
      const baseRev = Math.max(prevEl.rev ?? 0, existingTomb?.rev ?? 0);
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

  return {
    elements: stamped,
    tombstones: pruneTombstones(tombstones),
  };
}

/**
 * Merges a remote peer's board snapshot with local board state:
 * 1. Fresh unmodified joiners NEVER overwrite a host / edited board.
 * 2. Fresh unmodified joiners adopt the host's authoritative board wholesale
 *    (so default starter shapes never resurrect into a custom or blank room).
 * 3. Concurrent edits from synced peers merge deterministically & commutatively
 *    at the element level using (rev, updatedAt, updatedBy) + tombstones.
 */
export function mergeRemoteBoardState(
  local: BoardSyncState,
  remote: RemoteSyncPayload,
  localPeerId: string
): MergeBoardResult {
  const remoteTombstones = remote.tombstones ?? {};
  const remoteTitleUpdatedAt = remote.titleUpdatedAt ?? 0;

  // 1. Protect host / edited local board from an unmodified fresh joiner
  if (
    local.hasLocalEdits &&
    remote.hasLocalEdits === false &&
    !remote.authoritative
  ) {
    return {
      state: local,
      changed: false,
      adoptedAuthoritative: false,
    };
  }

  // 2. Fresh unmodified joiner adopts authoritative / edited remote board wholesale
  if (!local.hasLocalEdits && (remote.authoritative || remote.hasLocalEdits)) {
    const adoptedState: BoardSyncState = {
      elements: remote.elements,
      boardTitle: remote.boardTitle,
      titleUpdatedAt: remoteTitleUpdatedAt,
      tombstones: pruneTombstones({ ...remoteTombstones }),
      hasLocalEdits: Boolean(remote.hasLocalEdits),
    };
    const changed =
      !elementsFullyEqual(local.elements, adoptedState.elements) ||
      local.boardTitle !== adoptedState.boardTitle ||
      !tombstonesEqual(local.tombstones, adoptedState.tombstones);

    return {
      state: adoptedState,
      changed,
      adoptedAuthoritative: true,
    };
  }

  // 3. Deterministic element-level commutative merge
  const mergedTombstones: TombstoneMap = {};
  const allTombKeys = new Set([
    ...Object.keys(local.tombstones),
    ...Object.keys(remoteTombstones),
  ]);
  for (const id of allTombKeys) {
    const lt = local.tombstones[id];
    const rt = remoteTombstones[id];
    if (lt && !rt) {
      mergedTombstones[id] = lt;
    } else if (!lt && rt) {
      mergedTombstones[id] = rt;
    } else if (lt && rt) {
      const cmp = compareVersions(
        tombstoneVersion(lt, localPeerId),
        tombstoneVersion(rt, remote.senderPeerId)
      );
      mergedTombstones[id] = cmp >= 0 ? lt : rt;
    }
  }

  const localById = new Map(local.elements.map((e) => [e.id, e]));
  const remoteById = new Map(remote.elements.map((e) => [e.id, e]));
  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

  const mergedElements: JevElement[] = [];

  for (const id of allIds) {
    const localEl = localById.get(id);
    const remoteEl = remoteById.get(id);
    let winner: JevElement | null = null;
    let winnerActor = localPeerId;

    if (localEl && !remoteEl) {
      winner = localEl;
      winnerActor = localPeerId;
    } else if (!localEl && remoteEl) {
      winner = remoteEl;
      winnerActor = remote.senderPeerId;
    } else if (localEl && remoteEl) {
      const cmp = compareVersions(
        elementVersion(localEl, localPeerId),
        elementVersion(remoteEl, remote.senderPeerId)
      );
      if (cmp > 0) {
        winner = localEl;
        winnerActor = localPeerId;
      } else if (cmp < 0) {
        winner = remoteEl;
        winnerActor = remote.senderPeerId;
      } else {
        // Exact tie-breaker for full commutativity
        const localJson = JSON.stringify(localEl);
        const remoteJson = JSON.stringify(remoteEl);
        if (localJson >= remoteJson) {
          winner = localEl;
          winnerActor = localPeerId;
        } else {
          winner = remoteEl;
          winnerActor = remote.senderPeerId;
        }
      }
    }

    if (!winner) continue;

    const tomb = mergedTombstones[id];
    if (tomb) {
      const elVer = elementVersion(winner, winnerActor);
      const tombVer = tombstoneVersion(tomb, remote.senderPeerId);
      if (compareVersions(tombVer, elVer) >= 0) {
        // Tombstone is newer (or equal): element stays deleted
        continue;
      }
      // Live element strictly supersedes older tombstone
      delete mergedTombstones[id];
    }

    mergedElements.push(winner);
  }

  const sortedElements = sortElementsDeterministically(mergedElements);
  const prunedTombstones = pruneTombstones(mergedTombstones);

  // Merge board title deterministically
  let mergedTitle = local.boardTitle;
  let mergedTitleUpdatedAt = local.titleUpdatedAt;
  if (remoteTitleUpdatedAt > local.titleUpdatedAt) {
    mergedTitle = remote.boardTitle;
    mergedTitleUpdatedAt = remoteTitleUpdatedAt;
  } else if (
    remoteTitleUpdatedAt === local.titleUpdatedAt &&
    remoteTitleUpdatedAt > 0 &&
    remote.boardTitle !== local.boardTitle &&
    remote.senderPeerId > localPeerId
  ) {
    mergedTitle = remote.boardTitle;
  }

  const nextState: BoardSyncState = {
    elements: sortedElements,
    boardTitle: mergedTitle,
    titleUpdatedAt: mergedTitleUpdatedAt,
    tombstones: prunedTombstones,
    hasLocalEdits: Boolean(local.hasLocalEdits || remote.hasLocalEdits),
  };

  const changed =
    !elementsFullyEqual(local.elements, nextState.elements) ||
    local.boardTitle !== nextState.boardTitle ||
    !tombstonesEqual(local.tombstones, nextState.tombstones);

  return {
    state: nextState,
    changed,
    adoptedAuthoritative: false,
  };
}
