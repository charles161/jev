"use client";

import { BRAND_NAME } from "@/brand/brand";
import { BOARD_STORAGE_PREFIX, boardStorageKey } from "@/lib/jev/storage-keys";
import { useEffect, useState } from "react";

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

export default function GlobalError({
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
        boundary: "app/global-error",
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
    <html lang="en">
      <head>
        <title>{`${BRAND_NAME} — Recovery`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#f6f3ec",
          color: "#181b22",
          fontFamily:
            'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <main
          role="alert"
          style={{
            width: "100%",
            maxWidth: "448px",
            borderRadius: "16px",
            border: "1px solid #dfd8ca",
            backgroundColor: "#fdfbf7",
            padding: "24px",
            boxShadow: "0 2px 10px rgba(24, 27, 34, 0.05)",
          }}
        >
          <div
            style={{
              display: "inline-block",
              marginBottom: "12px",
              padding: "4px 10px",
              borderRadius: "999px",
              backgroundColor: "rgba(217, 78, 40, 0.12)",
              color: "#b83d1b",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.02em",
            }}
          >
            {BRAND_NAME} Recovery
          </div>

          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "21px",
              lineHeight: 1.3,
              fontWeight: 600,
              fontFamily: 'Georgia, "Times New Roman", serif',
            }}
          >
            Something went wrong loading {BRAND_NAME}
          </h1>

          <p
            style={{
              margin: "0 0 20px 0",
              fontSize: "14px",
              lineHeight: 1.55,
              color: "#5f6672",
            }}
          >
            You can retry rendering the workspace right away, or reset your
            locally cached board if corrupted browser state is preventing
            startup.
          </p>

          {resetNotice ? (
            <p
              style={{
                margin: "0 0 16px 0",
                padding: "8px 12px",
                borderRadius: "8px",
                backgroundColor: "#ebe5d9",
                fontSize: "12px",
                color: "#181b22",
              }}
            >
              {resetNotice}
            </p>
          ) : null}

          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
            <button
              type="button"
              onClick={handleRetry}
              style={{
                appearance: "none",
                border: "1px solid #1c2028",
                borderRadius: "8px",
                backgroundColor: "#1c2028",
                color: "#f8f6f1",
                padding: "8px 14px",
                fontSize: "14px",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={handleResetLocalBoard}
              style={{
                appearance: "none",
                border: "1px solid #dfd8ca",
                borderRadius: "8px",
                backgroundColor: "#f6f3ec",
                color: "#181b22",
                padding: "8px 14px",
                fontSize: "14px",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Reset local board
            </button>
          </div>

          {digest ? (
            <p
              style={{
                margin: "16px 0 0 0",
                fontSize: "11px",
                color: "#5f6672",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              Error reference: {digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
