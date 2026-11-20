import type { JevElement } from "./types";

const MAX_HISTORY_ENTRIES = 40;

export interface CommitLocalOptions {
  recordUndo?: boolean;
  undoSnapshot?: JevElement[];
}

/**
 * Pure, synchronous undo/redo history controller that keeps all stack mutations
 * outside React state updaters, supports explicit pre-drag snapshots, and clears
 * local history when remote peer changes arrive so Undo never clobbers a peer.
 */
export class BoardHistoryController {
  private _current: JevElement[];
  private undoStack: JevElement[][] = [];
  private redoStack: JevElement[][] = [];

  constructor(initialElements: JevElement[]) {
    this._current = initialElements;
  }

  get current(): JevElement[] {
    return this._current;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  snapshotForDrag(): JevElement[] {
    return this._current.map((el) => ({ ...el }));
  }

  replaceWithoutHistory(next: JevElement[]): void {
    this._current = next;
  }

  commitLocal(next: JevElement[], opts?: CommitLocalOptions): void {
    const recordUndo = opts?.recordUndo ?? true;
    if (recordUndo) {
      const snapshot = opts?.undoSnapshot ?? this._current;
      this.undoStack = [
        ...this.undoStack.slice(-(MAX_HISTORY_ENTRIES - 1)),
        snapshot,
      ];
      this.redoStack = [];
    }
    this._current = next;
  }

  applyRemote(
    next: JevElement[],
    opts?: { clearHistory?: boolean }
  ): void {
    this._current = next;
    if (opts?.clearHistory ?? true) {
      this.undoStack = [];
      this.redoStack = [];
    }
  }

  undo(): JevElement[] | null {
    if (this.undoStack.length === 0) return null;
    const previous = this.undoStack[this.undoStack.length - 1];
    this.undoStack = this.undoStack.slice(0, -1);
    this.redoStack = [
      ...this.redoStack.slice(-(MAX_HISTORY_ENTRIES - 1)),
      this._current,
    ];
    this._current = previous;
    return previous;
  }

  redo(): JevElement[] | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack[this.redoStack.length - 1];
    this.redoStack = this.redoStack.slice(0, -1);
    this.undoStack = [
      ...this.undoStack.slice(-(MAX_HISTORY_ENTRIES - 1)),
      this._current,
    ];
    this._current = next;
    return next;
  }
}

/**
 * Leading + trailing throttler for active drag/resize broadcasts (~60ms cadence)
 * with guaranteed immediate flush on pointerup.
 */
export class BroadcastThrottler<T> {
  private readonly send: (payload: T) => void;
  private readonly intervalMs: number;
  private lastSentAt = -Infinity;
  private pending: T | null = null;
  private hasPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (payload: T) => void, intervalMs = 60) {
    this.send = send;
    this.intervalMs = intervalMs;
  }

  schedule(payload: T): void {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    if (elapsed >= this.intervalMs && this.timer === null) {
      this.lastSentAt = now;
      this.pending = null;
      this.hasPending = false;
      this.send(payload);
      return;
    }

    this.pending = payload;
    this.hasPending = true;

    if (this.timer === null) {
      const waitMs = Math.max(0, this.intervalMs - elapsed);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.hasPending && this.pending !== null) {
          const toSend = this.pending;
          this.pending = null;
          this.hasPending = false;
          this.lastSentAt = Date.now();
          this.send(toSend);
        }
      }, waitMs);
    }
  }

  flushNow(payload?: T): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const toSend =
      payload !== undefined ? payload : this.hasPending ? this.pending : null;
    this.pending = null;
    this.hasPending = false;
    if (toSend !== null) {
      this.lastSentAt = Date.now();
      this.send(toSend);
    }
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.hasPending = false;
  }
}
