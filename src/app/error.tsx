"use client";

import { BOARD_STORAGE_PREFIX, boardStorageKey } from "@/lib/jev/storage-keys";
import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const VALID_ROOM_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;

function getActiveRoomFromUrl(): string | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashRoom = hash ? new URLSearchParams(hash).get("room") : null;
  if (hashRoom && VALID_ROOM_PATTERN.test(hashRoom)) return hashRoom;
  const queryRoom = new URLSearchParams(window.location.search).get("room");
  if (queryRoom && VALID_ROOM_PATTERN.test(queryRoom)) return queryRoom;
  return null;
}

function getErrorDigest(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string"
  ) {
    return (error as { digest: string }).digest;
  }
  return null;
}

function clearSavedBoardStorage(): number {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  try {
    const activeRoom = getActiveRoomFromUrl();
    if (activeRoom) {
      const activeKey = boardStorageKey(activeRoom);
      if (window.localStorage.getItem(activeKey) !== null) {
        window.localStorage.removeItem(activeKey);
        removed += 1;
      }
    }

    if (removed === 0) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(BOARD_STORAGE_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {
    // Ignore restricted/unavailable storage environments
  }
  return removed;
}

export default function AppError({
  error,
  retry,
  reset,
}: {
  error: unknown;
  retry?: () => void;
  reset?: () => void;
}) {
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const digest = getErrorDigest(error);

  useEffect(() => {
    const errorClass = error instanceof Error ? error.name : "UnknownError";
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        boundary: "app/error",
        errorClass,
        ...(digest ? { digest } : {}),
      })
    );
  }, [error, digest]);

  const handleRetry = () => {
    if (typeof retry === "function") {
      retry();
    } else if (typeof reset === "function") {
      reset();
    } else if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  const handleResetLocalBoard = () => {
    const removed = clearSavedBoardStorage();
    setResetNotice(
      removed > 0
        ? "Cleared saved local board state. Reloading clean canvas…"
        : "No saved local board found. Reloading clean canvas…"
    );
    window.setTimeout(() => {
      window.location.reload();
    }, 150);
  };

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-6 text-foreground">
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm"
        role="alert"
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#d94e28]/12 text-[#d94e28]">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="font-editorial text-xl font-semibold tracking-tight text-foreground">
              The whiteboard hit an unexpected snag
            </h1>
            <p className="text-xs text-muted-foreground">
              Your workspace paused to prevent data corruption.
            </p>
          </div>
        </div>

        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
          Try reloading the canvas first. If the error keeps happening because
          of corrupted local browser storage, reset the saved local board to
          start fresh.
        </p>

        {resetNotice ? (
          <p className="mb-4 rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
            {resetNotice}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="button" onClick={handleRetry}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Try again
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleResetLocalBoard}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Reset local board
          </Button>
        </div>

        {digest ? (
          <p className="mt-4 font-mono text-[11px] text-muted-foreground">
            Error reference: {digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
