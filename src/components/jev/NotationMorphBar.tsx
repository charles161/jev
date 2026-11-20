"use client";

import React from "react";
import { Layers, Loader2 } from "lucide-react";
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
  return (
    <div
      role="tablist"
      aria-label="Notation morph switcher"
      className={`inline-flex items-center gap-0.5 rounded-full border border-border/80 bg-secondary/65 p-0.5 ${
        compact ? "max-w-full overflow-x-auto" : ""
      }`}
    >
      {!compact && (
        <span
          className="inline-flex items-center gap-1 pl-1.5 pr-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
          title="Reversible in-place notation morph — return to Sketch anytime"
        >
          <Layers className="h-3 w-3 text-[#2563EB] dark:text-[#38BDF8]" />
          <span className="hidden sm:inline">Morph</span>
        </span>
      )}

      {ALL_MORPH_NOTATIONS.map((notation) => {
        const active = activeNotation === notation;
        return (
          <button
            key={notation}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelectNotation(notation)}
            title={
              notation === "sketch"
                ? "Restore original Sketch in place"
                : `Morph selection in place to ${MORPH_NOTATION_LABELS[notation]}`
            }
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold transition-all ${
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
          className="inline-flex items-center gap-1 px-1.5 font-mono text-[9.5px] text-muted-foreground"
          title="Refining semantic notation"
        >
          <Loader2 className="h-2.5 w-2.5 animate-spin text-[#2563EB] dark:text-[#38BDF8]" />
        </span>
      )}

      {!evaluating && isMorphedGroup && activeNotation !== "sketch" && (
        <span
          className="hidden rounded-full border border-border/70 bg-card/85 px-1.5 py-0.5 font-mono text-[9px] font-medium text-muted-foreground sm:inline-flex"
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
