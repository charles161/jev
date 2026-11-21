"use client";

import React, { useRef } from "react";
import { IconLayers, IconSpinner } from "@/brand/icons";
import {
  ALL_MORPH_NOTATIONS,
  MORPH_NOTATION_LABELS,
} from "@/lib/jev/notation-morph";
import type { MorphNotation } from "@/lib/jev/types";

interface NotationMorphBarProps {
  activeNotation: MorphNotation;
  isMorphedGroup?: boolean;
  evaluating?: boolean;
  isHeuristic?: boolean;
  compact?: boolean;
  onSelectNotation: (notation: MorphNotation) => void;
}

export function NotationMorphBar({
  activeNotation,
  isMorphedGroup = false,
  evaluating = false,
  isHeuristic = true,
  compact = false,
  onSelectNotation,
}: NotationMorphBarProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const nextIdx =
        (idx + delta + ALL_MORPH_NOTATIONS.length) % ALL_MORPH_NOTATIONS.length;
      const nextNotation = ALL_MORPH_NOTATIONS[nextIdx];
      onSelectNotation(nextNotation);
      tabRefs.current[nextIdx]?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Notation morph switcher"
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border/80 bg-secondary/65 p-0.5"
    >
      {!compact && (
        <span
          className="inline-flex shrink-0 items-center gap-1 pl-1.5 pr-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
          title="Reversible in-place notation morph — return to Sketch anytime"
        >
          <IconLayers
            className="h-3 w-3 text-[#2563EB] dark:text-[#38BDF8]"
            aria-hidden="true"
          />
          <span className="hidden sm:inline">Morph</span>
        </span>
      )}

      {ALL_MORPH_NOTATIONS.map((notation, idx) => {
        const active = activeNotation === notation;
        return (
          <button
            key={notation}
            ref={(node) => {
              tabRefs.current[idx] = node;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelectNotation(notation)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            title={
              notation === "sketch"
                ? "Restore original Sketch in place"
                : `Morph selection in place to ${MORPH_NOTATION_LABELS[notation]}`
            }
            className={`min-h-[32px] shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[10.5px] ${
              active
                ? "bg-foreground text-background shadow-2xs"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            {MORPH_NOTATION_LABELS[notation]}
          </button>
        );
      })}

      {evaluating && (
        <span
          role="status"
          aria-label="Refining semantic notation"
          className="inline-flex shrink-0 items-center gap-1 px-1.5 font-mono text-[9.5px] text-muted-foreground"
          title="Refining semantic notation"
        >
          <IconSpinner
            className="h-2.5 w-2.5 animate-spin text-[#2563EB] dark:text-[#38BDF8]"
            aria-hidden="true"
          />
        </span>
      )}

      {!evaluating && isMorphedGroup && activeNotation !== "sketch" && (
        <span
          className="hidden shrink-0 rounded-full border border-border/70 bg-card/85 px-1.5 py-0.5 font-mono text-[9px] font-medium text-muted-foreground sm:inline-flex"
          title={
            isHeuristic
              ? "Morphed deterministically with local heuristic extractor"
              : "Semantic model refined by AI"
          }
        >
          {isHeuristic ? "Heuristic" : "AI"}
        </span>
      )}
    </div>
  );
}
