"use client";

import { useState } from "react";
import {
  IconApiToSchema,
  IconBreak,
  IconClose,
  IconConsistency,
  IconCpu,
  IconEstimate,
  IconFailureStep,
  IconMissingTransition,
  IconMoves,
  IconSpark,
  IconTrace,
  type IconComponent,
} from "@/brand/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MOVES, type MoveId } from "@/lib/jev/sd-moves/moves";
import type { MoveNotice } from "./use-moves";

export const MOVE_ICONS: Record<MoveId, IconComponent> = {
  break: IconBreak,
  trace: IconTrace,
  estimate: IconEstimate,
  schema: IconApiToSchema,
  failure: IconFailureStep,
  transitions: IconMissingTransition,
  consistency: IconConsistency,
};

/** The one entry point for the Sensei moves, sitting in the Thought Bar. */
export function MovesMenu({ onRun, quiet }: { onRun: (move: MoveId) => void; quiet: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Moves"
            title="Moves: break at 10×, trace, estimate, schema, failure steps, transitions, consistency"
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-xl border border-border px-2.5 py-1 text-[11.5px] font-semibold text-foreground/90 transition-colors hover:border-[#D94E28]/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
          />
        }
      >
        <IconMoves className="h-3.5 w-3.5 text-[#C2411D] dark:text-[#FF8562]" aria-hidden="true" />
        <span className="hidden sm:inline">Moves</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-[22rem] max-w-[calc(100vw-24px)] gap-1 rounded-2xl p-1.5">
        <div role="menu" aria-label="Moves" className="flex flex-col gap-0.5">
          {quiet && (
            <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">Practice mode: critique moves wait for Review.</p>
          )}
          {MOVES.map((m) => {
            const Icon = MOVE_ICONS[m.id];
            return (
              <button
                key={m.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onRun(m.id);
                }}
                className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none sm:min-h-0"
              >
                <Icon className="h-4 w-4 shrink-0 text-foreground/80" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold leading-tight text-foreground">{m.title}</span>
                  <span className="block text-[10.5px] leading-snug text-muted-foreground">{m.hint}</span>
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">/{m.command}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Says what a move did, and whether the words came from the rules or the AI. */
export function MoveNoticeToast({ notice, onDismiss }: { notice: MoveNotice | null; onDismiss: () => void }) {
  if (!notice) return null;
  const ai = notice.source === "AI";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[168px] z-40 flex justify-center px-3 sm:top-[120px]">
      <div
        key={notice.id}
        role="status"
        aria-live="polite"
        data-testid="move-notice"
        className="jev-glass pointer-events-auto flex max-w-[min(560px,calc(100vw-24px))] items-start gap-2.5 rounded-2xl border border-border px-3.5 py-2 shadow-[0_14px_36px_-12px_rgba(15,23,42,0.28)]"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#D94E28]/12 text-[#C2411D] dark:text-[#FF8562]">
          <IconMoves className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-xs leading-snug text-foreground">
          <span className="font-semibold">{notice.title}</span>
          {notice.source && (
            <span
              data-testid="move-source"
              className={`ml-1.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-full px-1.5 py-px font-mono text-[9.5px] font-semibold ${
                ai ? "bg-[#0F766E]/12 text-[#0F766E] dark:bg-[#34D399]/15 dark:text-[#34D399]" : "bg-secondary text-muted-foreground"
              }`}
            >
              {ai ? <IconSpark className="h-2.5 w-2.5" aria-hidden="true" /> : <IconCpu className="h-2.5 w-2.5" aria-hidden="true" />}
              {notice.source}
            </span>
          )}
          <span className="mt-0.5 block text-muted-foreground">{notice.text}</span>
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notice"
          className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0"
        >
          <IconClose className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
