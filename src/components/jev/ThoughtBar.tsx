"use client";

import React, { useState } from "react";
import { CornerDownLeft, MapPin, Sparkles, Wand2, X } from "lucide-react";
import { PROMPT_SPARKS } from "@/lib/jev/templates";

export interface PlacementBadgeInfo {
  label: string;
  confidence?: number;
  fromJev: boolean;
  evaluating?: boolean;
  optionCount?: number;
}

interface ThoughtBarProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  previewCount: number;
  placementInfo?: PlacementBadgeInfo | null;
  hasPredictions?: boolean;
  onChange: (val: string) => void;
  onSubmit: (prompt: string) => void;
  onClear: () => void;
  onCyclePlacement?: (reverse?: boolean) => void;
  onEmptyTab?: (reverse?: boolean) => void;
  onEmptyEnter?: () => void;
  onEmptyUndo?: () => void;
  onEmptyRedo?: () => void;
}

export function ThoughtBar({
  inputRef,
  value,
  previewCount,
  placementInfo,
  hasPredictions = false,
  onChange,
  onSubmit,
  onClear,
  onCyclePlacement,
  onEmptyTab,
  onEmptyEnter,
  onEmptyUndo,
  onEmptyRedo,
}: ThoughtBarProps) {
  const [focused, setFocused] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hasText = value.trim().length > 0;

    if (e.key === "Tab") {
      if (hasText && onCyclePlacement) {
        e.preventDefault();
        onCyclePlacement(e.shiftKey);
        return;
      }
      if (!hasText && hasPredictions && onEmptyTab) {
        e.preventDefault();
        onEmptyTab(e.shiftKey);
        return;
      }
    }

    if (e.key === "Enter") {
      if (hasText) {
        e.preventDefault();
        onSubmit(value.trim());
        return;
      }
      if (!hasText && hasPredictions && onEmptyEnter) {
        e.preventDefault();
        onEmptyEnter();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (hasText) {
        onClear();
      } else {
        inputRef.current?.blur();
      }
      return;
    }

    // Undo / Redo canvas smoothly when the Thought Bar is focused & empty
    if (!hasText && (e.metaKey || e.ctrlKey)) {
      const lower = e.key.toLowerCase();
      if (lower === "z") {
        e.preventDefault();
        if (e.shiftKey) onEmptyRedo?.();
        else onEmptyUndo?.();
        return;
      }
      if (lower === "y") {
        e.preventDefault();
        onEmptyRedo?.();
      }
    }
  };

  const canCyclePlacement = (placementInfo?.optionCount ?? 0) > 1;

  return (
    <div className="pointer-events-auto flex w-full max-w-[660px] flex-col items-center gap-2 px-3">
      {/* Quick starter sparks when focused, empty, and no prediction strip is already open */}
      {focused && !value.trim() && !hasPredictions && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {PROMPT_SPARKS.map((spark) => (
            <button
              key={spark.label}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSubmit(spark.prompt);
              }}
              className="jev-glass inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium text-foreground/85 shadow-xs transition-all hover:border-[#D94E28]/50 hover:text-foreground"
            >
              <Sparkles className="h-3 w-3 text-[#D94E28]" />
              {spark.label}
            </button>
          ))}
        </div>
      )}

      {/* Live Jev spatial placement / auto-connect pill while typing */}
      {value.trim() && placementInfo && (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            if (canCyclePlacement) onCyclePlacement?.(false);
          }}
          title={
            canCyclePlacement
              ? "Click or press Tab to switch placement / connection target"
              : undefined
          }
          className={`jev-glass flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium text-foreground/85 shadow-xs transition-colors ${
            canCyclePlacement
              ? "cursor-pointer hover:border-[#D94E28]/45"
              : "cursor-default"
          }`}
        >
          <MapPin className="h-3 w-3 shrink-0 text-[#D94E28]" />
          <span className="text-muted-foreground">
            {placementInfo.fromJev ? "Jev:" : "Heuristic:"}
          </span>
          <span className="font-semibold text-foreground">{placementInfo.label}</span>
          {placementInfo.fromJev && typeof placementInfo.confidence === "number" && (
            <span className="rounded-full bg-[#D94E28]/12 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-[#D94E28]">
              {Math.round(placementInfo.confidence * 100)}%
            </span>
          )}
          {canCyclePlacement && (
            <span className="ml-0.5 hidden items-center gap-1 text-[10px] text-muted-foreground sm:inline-flex">
              <span>·</span>
              <kbd className="rounded border border-border bg-secondary px-1 py-0 font-mono text-[9.5px] font-semibold text-foreground/80">
                Tab
              </kbd>
              <span>switch</span>
            </span>
          )}
          {placementInfo.evaluating && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#D94E28]" />
          )}
        </button>
      )}

      {/* Main Speed-of-Thought Input */}
      <div
        className={`jev-glass flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2 shadow-[0_14px_40px_-14px_rgba(15,23,42,0.28)] transition-all ${
          focused
            ? "ring-2 ring-[#D94E28]/45 border-[#D94E28]/50"
            : "hover:border-foreground/20"
        }`}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[#D94E28] text-white shadow-xs">
          <Wand2 className="h-3.5 w-3.5" />
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Type a component ("app", "server") or flow ("app -> gateway -> server")…'
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground/80 focus:outline-none"
        />

        {value.trim() ? (
          <div className="flex items-center gap-1.5">
            {previewCount > 0 && (
              <span className="hidden rounded-md bg-[#2563EB]/10 px-2 py-0.5 font-mono text-[10.5px] font-medium text-[#2563EB] dark:bg-[#38BDF8]/15 dark:text-[#38BDF8] sm:inline-block">
                {previewCount} live
              </span>
            )}
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear prompt"
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onSubmit(value.trim())}
              className="inline-flex items-center gap-1 rounded-xl bg-[#D94E28] px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-transform active:scale-95 hover:bg-[#C1411E]"
            >
              Draw
              <CornerDownLeft className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <kbd className="hidden rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground sm:inline-block">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}
