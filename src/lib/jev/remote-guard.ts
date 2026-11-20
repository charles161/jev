import {
  BoardSyncState,
  diffBoardElements,
  MergeBoardOptions,
  MergeBoardResult,
  mergeRemoteBoardState,
  RemoteSyncPayload,
} from "./board-sync";
import type { BoardRecoveryEntry, StoredBoardSnapshot } from "./sync-validation";
import type { JevElement } from "./types";

export const REMOTE_CHANGE_SNAPSHOT_RATIO = 0.3;
export const PEER_PAUSE_CHANGE_RATIO = 0.5;
export const REMOTE_CHANGE_WINDOW_MS = 60_000;
export const PERIODIC_SNAPSHOT_INTERVAL_MS = 120_000;
const MAX_QUARANTINED_PAYLOADS_PER_PEER = 50;

export interface PeerQuarantineIncident {
  peerId: string;
  peerName: string;
  changedCount: number;
  deletedCount: number;
  editedCount: number;
  baselineCount: number;
  changeRatio: number;
  quarantinedCount: number;
  preIncidentSnapshot: StoredBoardSnapshot;
  triggeredAt: number;
}

export interface RestoreToastSummary {
  kind: "full_replace" | "bulk_delete" | "remote_changes";
  removedCount: number;
  editedCount: number;
  changedCount: number;
  localCount: number;
}

export type EvaluateRemoteResult =
  | {
      decision: "resync";
      merged: MergeBoardResult;
    }
  | {
      decision: "noop";
      merged: MergeBoardResult;
    }
  | {
      decision: "paused";
      incident: PeerQuarantineIncident;
      recoveryEntry?: BoardRecoveryEntry;
    }
  | {
      decision: "apply";
      merged: MergeBoardResult;
      showRestoreToast: boolean;
      recoveryEntry?: BoardRecoveryEntry;
      toastSummary?: RestoreToastSummary;
    };

export interface QuarantinedRemoteEntry {
  payload: RemoteSyncPayload;
  authoritativePeerId?: string | null;
}

export type ResolvePeerIncidentResult =
  | {
      action: "keep";
      peerId: string;
      payloadsToApply: RemoteSyncPayload[];
      entriesToApply: QuarantinedRemoteEntry[];
    }
  | {
      action: "revert";
      peerId: string;
      restoreSnapshot: StoredBoardSnapshot;
    };

interface ChangedElementEntry {
  changedAt: number;
  kind: "delete" | "edit";
}

interface PeerWindowState {
  peerId: string;
  peerName: string;
  changedElements: Map<string, ChangedElementEntry>;
  baselineCount: number;
  preIncidentSnapshot: StoredBoardSnapshot | null;
  paused: boolean;
  triggeredAt: number;
  quarantinedEntries: QuarantinedRemoteEntry[];
}

function cloneElement(el: JevElement): JevElement {
  return {
    ...el,
    ...(el.fromPoint ? { fromPoint: { ...el.fromPoint } } : {}),
    ...(el.toPoint ? { toPoint: { ...el.toPoint } } : {}),
    ...(el.points ? { points: el.points.map((pt) => ({ ...pt })) } : {}),
  };
}

export function cloneBoardSyncSnapshot(
  state: BoardSyncState
): StoredBoardSnapshot {
  const tombstones: NonNullable<StoredBoardSnapshot["tombstones"]> = {};
  for (const [id, tomb] of Object.entries(state.tombstones ?? {})) {
    tombstones[id] = { ...tomb };
  }
  return {
    elements: state.elements.map(cloneElement),
    boardTitle: state.boardTitle,
    ...(state.titleRev !== undefined ? { titleRev: state.titleRev } : {}),
    ...(state.titleUpdatedBy ? { titleUpdatedBy: state.titleUpdatedBy } : {}),
    ...(state.titleUpdatedAt !== undefined
      ? { titleUpdatedAt: state.titleUpdatedAt }
      : {}),
    tombstones,
    ...(state.tombstoneHorizonRev !== undefined
      ? { tombstoneHorizonRev: state.tombstoneHorizonRev }
      : {}),
    ...(state.tombstoneHorizonAt !== undefined
      ? { tombstoneHorizonAt: state.tombstoneHorizonAt }
      : {}),
    ...(state.boardEpoch ? { boardEpoch: state.boardEpoch } : {}),
    ...(state.boardEpochCreatedAt !== undefined
      ? { boardEpochCreatedAt: state.boardEpochCreatedAt }
      : {}),
    ...(state.baseTimestamp !== undefined
      ? { baseTimestamp: state.baseTimestamp }
      : {}),
    hasLocalEdits: state.hasLocalEdits,
  };
}

function pruneMapWindow(
  entries: Map<string, ChangedElementEntry>,
  now: number,
  windowMs: number
): void {
  for (const [id, entry] of entries.entries()) {
    if (now - entry.changedAt > windowMs) {
      entries.delete(id);
    }
  }
}

function countByKind(entries: Map<string, ChangedElementEntry>): {
  deletedCount: number;
  editedCount: number;
} {
  let deletedCount = 0;
  let editedCount = 0;
  for (const entry of entries.values()) {
    if (entry.kind === "delete") deletedCount += 1;
    else editedCount += 1;
  }
  return { deletedCount, editedCount };
}

export class RemoteChangeGuard {
  private lastSnapshotAt: number;
  private dirtySinceLastSnapshot = false;
  private entrySeq = 0;

  private sinceSnapshotPreState: StoredBoardSnapshot | null = null;
  private sinceSnapshotBaselineCount = 0;
  private sinceSnapshotChangedIds = new Set<string>();
  private sinceSnapshotDeletedIds = new Set<string>();
  private sinceSnapshotEditedIds = new Set<string>();

  private rolling60sEntries = new Map<string, ChangedElementEntry>();
  private rolling60sBaselineCount = 0;
  private rolling60sPreState: StoredBoardSnapshot | null = null;

  private peerWindows = new Map<string, PeerWindowState>();

  constructor(now = Date.now()) {
    this.lastSnapshotAt = now;
  }

  private nextRecoveryId(now: number): string {
    this.entrySeq += 1;
    return `rec_${now.toString(36)}_${this.entrySeq}`;
  }

  private resetSinceLastSnapshot(): void {
    this.sinceSnapshotPreState = null;
    this.sinceSnapshotBaselineCount = 0;
    this.sinceSnapshotChangedIds.clear();
    this.sinceSnapshotDeletedIds.clear();
    this.sinceSnapshotEditedIds.clear();
  }

  private buildIncident(peerState: PeerWindowState): PeerQuarantineIncident {
    const { deletedCount, editedCount } = countByKind(peerState.changedElements);
    const changedCount = peerState.changedElements.size;
    const baselineCount = Math.max(
      peerState.baselineCount,
      peerState.preIncidentSnapshot?.elements.length ?? 0
    );
    return {
      peerId: peerState.peerId,
      peerName: peerState.peerName,
      changedCount,
      deletedCount,
      editedCount,
      baselineCount,
      changeRatio: baselineCount > 0 ? changedCount / baselineCount : 0,
      quarantinedCount: peerState.quarantinedEntries.length,
      preIncidentSnapshot: peerState.preIncidentSnapshot ?? {
        elements: [],
        hasLocalEdits: true,
      },
      triggeredAt: peerState.triggeredAt,
    };
  }

  markLocalChange(now = Date.now()): void {
    this.dirtySinceLastSnapshot = true;
    if (this.lastSnapshotAt <= 0) {
      this.lastSnapshotAt = now;
    }
  }

  resetAfterRestore(now = Date.now()): void {
    this.resetSinceLastSnapshot();
    this.rolling60sEntries.clear();
    this.rolling60sBaselineCount = 0;
    this.rolling60sPreState = null;
    this.lastSnapshotAt = now;
    this.dirtySinceLastSnapshot = false;
  }

  isPeerPaused(peerId: string): boolean {
    return this.peerWindows.get(peerId)?.paused === true;
  }

  getActiveIncidents(): PeerQuarantineIncident[] {
    const out: PeerQuarantineIncident[] = [];
    for (const peerState of this.peerWindows.values()) {
      if (peerState.paused) {
        out.push(this.buildIncident(peerState));
      }
    }
    return out;
  }

  evaluateIncoming(params: {
    local: BoardSyncState;
    remote: RemoteSyncPayload;
    localPeerId: string;
    senderName?: string;
    mergeOptions?: MergeBoardOptions;
    now?: number;
  }): EvaluateRemoteResult {
    const now = params.now ?? params.mergeOptions?.now ?? Date.now();
    const { local, remote, localPeerId, mergeOptions } = params;
    const peerId = remote.verifiedSenderPeerId ?? remote.senderPeerId;
    const existingPeer = this.peerWindows.get(peerId);
    const resolvedName =
      params.senderName?.trim() || existingPeer?.peerName || "A collaborator";

    // Unmodified fresh joiners adopt the room board without triggering vandalism guards or toasts
    if (!local.hasLocalEdits) {
      const merged = mergeRemoteBoardState(
        local,
        remote,
        localPeerId,
        mergeOptions
      );
      if (merged.needsFullResync) {
        return { decision: "resync", merged };
      }
      if (!merged.changed && !merged.adoptedAuthoritative) {
        return { decision: "noop", merged };
      }
      this.lastSnapshotAt = now;
      this.dirtySinceLastSnapshot = false;
      return {
        decision: "apply",
        merged,
        showRestoreToast: false,
      };
    }

    // Already-paused peer: quarantine incoming payload until the user chooses Keep or Revert
    if (existingPeer?.paused) {
      existingPeer.peerName = resolvedName;
      const entry: QuarantinedRemoteEntry = {
        payload: remote,
        authoritativePeerId: mergeOptions?.authoritativePeerId,
      };
      if (
        existingPeer.quarantinedEntries.length <
        MAX_QUARANTINED_PAYLOADS_PER_PEER
      ) {
        existingPeer.quarantinedEntries.push(entry);
      } else {
        existingPeer.quarantinedEntries[
          existingPeer.quarantinedEntries.length - 1
        ] = entry;
      }
      return {
        decision: "paused",
        incident: this.buildIncident(existingPeer),
      };
    }

    const merged = mergeRemoteBoardState(
      local,
      remote,
      localPeerId,
      mergeOptions
    );
    if (merged.needsFullResync) {
      return { decision: "resync", merged };
    }
    if (!merged.changed && !merged.adoptedAuthoritative) {
      return { decision: "noop", merged };
    }

    const diff =
      merged.changeDiff ?? diffBoardElements(local.elements, merged.state.elements);

    // 1. Per-sender rolling 60s window (>50% -> pause + Keep / Revert)
    let peerState = existingPeer;
    if (!peerState) {
      peerState = {
        peerId,
        peerName: resolvedName,
        changedElements: new Map(),
        baselineCount: 0,
        preIncidentSnapshot: null,
        paused: false,
        triggeredAt: 0,
        quarantinedEntries: [],
      };
      this.peerWindows.set(peerId, peerState);
    } else {
      peerState.peerName = resolvedName;
    }

    pruneMapWindow(peerState.changedElements, now, REMOTE_CHANGE_WINDOW_MS);
    if (peerState.changedElements.size === 0 && diff.changedIds.length > 0) {
      peerState.baselineCount = local.elements.length;
      peerState.preIncidentSnapshot = cloneBoardSyncSnapshot(local);
    }

    const projectedDistinctIds = new Set<string>(
      peerState.changedElements.keys()
    );
    for (const id of diff.changedIds) {
      projectedDistinctIds.add(id);
    }
    const effectivePeerBaseline = Math.max(
      peerState.baselineCount,
      local.elements.length
    );
    const projectedPeerRatio =
      effectivePeerBaseline > 0
        ? projectedDistinctIds.size / effectivePeerBaseline
        : 0;

    if (
      diff.changedIds.length > 0 &&
      projectedPeerRatio > PEER_PAUSE_CHANGE_RATIO
    ) {
      for (const id of diff.deletedIds) {
        peerState.changedElements.set(id, { changedAt: now, kind: "delete" });
      }
      for (const id of diff.editedIds) {
        const prev = peerState.changedElements.get(id);
        peerState.changedElements.set(id, {
          changedAt: now,
          kind: prev?.kind === "delete" ? "delete" : "edit",
        });
      }
      peerState.baselineCount = effectivePeerBaseline;
      peerState.paused = true;
      peerState.triggeredAt = now;
      peerState.quarantinedEntries = [
        {
          payload: remote,
          authoritativePeerId: mergeOptions?.authoritativePeerId,
        },
      ];
      const preSnap =
        peerState.preIncidentSnapshot ?? cloneBoardSyncSnapshot(local);
      peerState.preIncidentSnapshot = preSnap;

      const { deletedCount, editedCount } = countByKind(
        peerState.changedElements
      );
      const recoveryEntry: BoardRecoveryEntry = {
        id: this.nextRecoveryId(now),
        savedAt: now,
        reason: "peer_quarantine",
        removedCount: deletedCount,
        editedCount,
        previousElementCount: preSnap.elements.length,
        snapshot: preSnap,
      };
      this.lastSnapshotAt = now;
      this.dirtySinceLastSnapshot = false;

      return {
        decision: "paused",
        incident: this.buildIncident(peerState),
        recoveryEntry,
      };
    }

    // 2. Commit accepted batch into per-sender 60s window
    for (const id of diff.deletedIds) {
      peerState.changedElements.set(id, { changedAt: now, kind: "delete" });
    }
    for (const id of diff.editedIds) {
      const prev = peerState.changedElements.get(id);
      peerState.changedElements.set(id, {
        changedAt: now,
        kind: prev?.kind === "delete" ? "delete" : "edit",
      });
    }

    // 3. Track cumulative distinct remote changes since last snapshot
    if (diff.changedIds.length > 0) {
      if (!this.sinceSnapshotPreState) {
        this.sinceSnapshotPreState = cloneBoardSyncSnapshot(local);
        this.sinceSnapshotBaselineCount = local.elements.length;
      }
      for (const id of diff.deletedIds) {
        this.sinceSnapshotDeletedIds.add(id);
        this.sinceSnapshotChangedIds.add(id);
      }
      for (const id of diff.editedIds) {
        this.sinceSnapshotEditedIds.add(id);
        this.sinceSnapshotChangedIds.add(id);
      }
    }

    // 4. Track cumulative distinct remote changes within rolling 60s window
    pruneMapWindow(this.rolling60sEntries, now, REMOTE_CHANGE_WINDOW_MS);
    if (this.rolling60sEntries.size === 0 && diff.changedIds.length > 0) {
      this.rolling60sBaselineCount = local.elements.length;
      this.rolling60sPreState = cloneBoardSyncSnapshot(local);
    }
    for (const id of diff.deletedIds) {
      this.rolling60sEntries.set(id, { changedAt: now, kind: "delete" });
    }
    for (const id of diff.editedIds) {
      const prev = this.rolling60sEntries.get(id);
      this.rolling60sEntries.set(id, {
        changedAt: now,
        kind: prev?.kind === "delete" ? "delete" : "edit",
      });
    }

    const sinceSnapshotBaseline = Math.max(
      this.sinceSnapshotBaselineCount,
      local.elements.length
    );
    const sinceSnapshotRatio =
      sinceSnapshotBaseline > 0
        ? this.sinceSnapshotChangedIds.size / sinceSnapshotBaseline
        : 0;

    const rolling60sBaseline = Math.max(
      this.rolling60sBaselineCount,
      local.elements.length
    );
    const rolling60sRatio =
      rolling60sBaseline > 0
        ? this.rolling60sEntries.size / rolling60sBaseline
        : 0;

    const singleBatchExceeds =
      diff.changeRatio > REMOTE_CHANGE_SNAPSHOT_RATIO ||
      Boolean(merged.destructiveChange);
    const cumulativeSinceSnapshotExceeds =
      sinceSnapshotRatio > REMOTE_CHANGE_SNAPSHOT_RATIO;
    const cumulative60sExceeds = rolling60sRatio > REMOTE_CHANGE_SNAPSHOT_RATIO;

    const showRestoreToast = singleBatchExceeds || cumulative60sExceeds;
    const shouldSaveSnapshot =
      singleBatchExceeds || cumulativeSinceSnapshotExceeds || showRestoreToast;

    let recoveryEntry: BoardRecoveryEntry | undefined;
    let toastSummary: RestoreToastSummary | undefined;

    if (shouldSaveSnapshot) {
      const preSnap =
        this.sinceSnapshotPreState ??
        this.rolling60sPreState ??
        cloneBoardSyncSnapshot(local);
      const rollingCounts = countByKind(this.rolling60sEntries);
      const removedCount = Math.max(
        diff.deletedCount,
        this.sinceSnapshotDeletedIds.size,
        rollingCounts.deletedCount
      );
      const editedCount = Math.max(
        diff.editedCount,
        this.sinceSnapshotEditedIds.size,
        rollingCounts.editedCount
      );
      const changedCount = Math.max(
        diff.changedCount,
        this.sinceSnapshotChangedIds.size,
        this.rolling60sEntries.size
      );
      const reason: BoardRecoveryEntry["reason"] = merged.destructiveChange
        ? merged.destructiveChange.kind === "full_replace"
          ? "authoritative_replace"
          : "authoritative_bulk_delete"
        : "remote_change_threshold";

      recoveryEntry = {
        id: this.nextRecoveryId(now),
        savedAt: now,
        reason,
        removedCount,
        editedCount,
        previousElementCount: preSnap.elements.length,
        snapshot: preSnap,
      };

      if (showRestoreToast) {
        toastSummary = {
          kind: merged.destructiveChange
            ? merged.destructiveChange.kind
            : "remote_changes",
          removedCount,
          editedCount,
          changedCount,
          localCount: preSnap.elements.length,
        };
      }

      this.resetSinceLastSnapshot();
      this.lastSnapshotAt = now;
      this.dirtySinceLastSnapshot = false;
    } else if (merged.changed) {
      this.dirtySinceLastSnapshot = true;
    }

    return {
      decision: "apply",
      merged,
      showRestoreToast,
      ...(recoveryEntry ? { recoveryEntry } : {}),
      ...(toastSummary ? { toastSummary } : {}),
    };
  }

  resolvePeerIncident(
    peerId: string,
    decision: "keep" | "revert",
    now = Date.now()
  ): ResolvePeerIncidentResult | null {
    const peerState = this.peerWindows.get(peerId);
    if (!peerState || !peerState.paused) {
      return null;
    }

    const entries = [...peerState.quarantinedEntries];
    const payloads = entries.map((e) => e.payload);
    const restoreSnapshot = peerState.preIncidentSnapshot ?? {
      elements: [],
      hasLocalEdits: true,
    };

    peerState.paused = false;
    peerState.quarantinedEntries = [];
    peerState.changedElements.clear();
    peerState.baselineCount = 0;
    peerState.preIncidentSnapshot = null;
    peerState.triggeredAt = 0;

    if (decision === "keep") {
      this.dirtySinceLastSnapshot = true;
      return {
        action: "keep",
        peerId,
        payloadsToApply: payloads,
        entriesToApply: entries,
      };
    }

    this.resetAfterRestore(now);
    return {
      action: "revert",
      peerId,
      restoreSnapshot,
    };
  }

  maybeTakePeriodicSnapshot(
    currentState: BoardSyncState,
    now = Date.now()
  ): BoardRecoveryEntry | null {
    if (!this.dirtySinceLastSnapshot) return null;
    if (currentState.elements.length === 0 && !currentState.hasLocalEdits) {
      return null;
    }
    if (now - this.lastSnapshotAt < PERIODIC_SNAPSHOT_INTERVAL_MS) {
      return null;
    }

    const snapshot = cloneBoardSyncSnapshot(currentState);
    const entry: BoardRecoveryEntry = {
      id: this.nextRecoveryId(now),
      savedAt: now,
      reason: "periodic",
      removedCount: 0,
      editedCount: 0,
      previousElementCount: snapshot.elements.length,
      snapshot,
    };

    this.resetSinceLastSnapshot();
    this.lastSnapshotAt = now;
    this.dirtySinceLastSnapshot = false;
    return entry;
  }
}
