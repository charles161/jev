"use client";

import React from "react";
import { IconLayers } from "@/brand/icons";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { STARTER_BOARDS } from "@/lib/jev/starter-boards";

interface StarterBoardsPickerProps {
  onPick: (id: string) => void;
}

/** Board menu section: one item per classic problem. */
export function StarterBoardsMenuItems({ onPick }: StarterBoardsPickerProps) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Starter boards
      </DropdownMenuLabel>
      {STARTER_BOARDS.map((b) => (
        <DropdownMenuItem key={b.id} onClick={() => onPick(b.id)} title={b.blurb} className="gap-2 text-xs">
          <IconLayers className="h-3.5 w-3.5" aria-hidden="true" />
          {b.title}
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

/** First-run row: the same six boards as quiet chips. */
export function StarterBoardsRow({ onPick }: StarterBoardsPickerProps) {
  return (
    <div
      role="group"
      aria-label="Starter boards"
      className="jev-reveal mt-3 flex w-full flex-col items-center gap-2 sm:mt-4"
      style={{ animationDelay: "230ms" }}
    >
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        Starter boards · requirements, numbers, HLD, ER, sequence
      </span>
      <div className="flex flex-wrap justify-center gap-1.5">
        {STARTER_BOARDS.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onPick(b.id)}
            title={b.blurb}
            aria-label={`Starter board: ${b.title}`}
            className="min-h-[36px] rounded-full border border-border bg-card/85 px-3 py-1 text-[12px] font-medium text-foreground shadow-2xs transition-colors hover:border-foreground/30 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {b.title}
          </button>
        ))}
      </div>
    </div>
  );
}
