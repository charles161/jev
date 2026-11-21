"use client";

import { useState } from "react";
import {
  IconEndArrow,
  IconEndDiamond,
  IconEndMany,
  IconEndNone,
  IconEndOne,
  IconEndOneMany,
  IconEndOnlyOne,
  IconEndOpen,
  IconEndOpenDiamond,
  IconEndTriangle,
  IconEndZeroMany,
  IconEndZeroOne,
  type IconComponent,
} from "@/brand/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ARROW_END_GROUPS, ARROW_END_LABELS } from "@/lib/jev/arrow-end-options";
import type { ArrowEnd } from "@/lib/jev/types";

/** Glyphs are drawn pointing right, as an end marker; the start picker mirrors them. */
export const ARROW_END_GLYPHS: Record<ArrowEnd, IconComponent> = {
  none: IconEndNone,
  arrow: IconEndArrow,
  open: IconEndOpen,
  triangle: IconEndTriangle,
  diamond: IconEndDiamond,
  odiamond: IconEndOpenDiamond,
  er_one: IconEndOne,
  er_only_one: IconEndOnlyOne,
  er_zero_one: IconEndZeroOne,
  er_many: IconEndMany,
  er_one_many: IconEndOneMany,
  er_zero_many: IconEndZeroMany,
};

interface ArrowEndMenuProps {
  value: ArrowEnd;
  mirrored?: boolean;
  onPick: (end: ArrowEnd) => void;
}

export function ArrowEndMenu({ value, mirrored = false, onPick }: ArrowEndMenuProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {ARROW_END_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title} className="flex flex-col gap-0.5">
          <h3 className="px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {group.title}
          </h3>
          <div className="grid grid-cols-3 gap-0.5">
            {group.ends.map((end) => {
              const Glyph = ARROW_END_GLYPHS[end];
              const active = value === end;
              return (
                <button
                  key={end}
                  type="button"
                  aria-label={ARROW_END_LABELS[end]}
                  aria-pressed={active}
                  title={ARROW_END_LABELS[end]}
                  onClick={() => onPick(end)}
                  className={`flex min-h-9 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[10px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 ${
                    active
                      ? "bg-foreground text-background"
                      : "text-foreground/80 hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <Glyph className={`h-5 w-5 ${mirrored ? "-scale-x-100" : ""}`} />
                  <span className="whitespace-nowrap">{ARROW_END_LABELS[end]}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

interface ArrowEndPickerProps {
  side: "start" | "end";
  value: ArrowEnd;
  onPick: (end: ArrowEnd) => void;
}

export function ArrowEndPicker({ side, value, onPick }: ArrowEndPickerProps) {
  const [open, setOpen] = useState(false);
  const Glyph = ARROW_END_GLYPHS[value];
  const sideName = side === "start" ? "Start end" : "End end";
  const mirrored = side === "start";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${sideName}: ${ARROW_END_LABELS[value]}`}
            title={`${sideName}: ${ARROW_END_LABELS[value]}`}
            className={`flex h-9 w-10 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-8 ${
              open ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          />
        }
      >
        <Glyph className={`h-4 w-4 ${mirrored ? "-scale-x-100" : ""}`} />
      </PopoverTrigger>
      <PopoverContent side="bottom" sideOffset={8} className="w-[17rem] rounded-2xl p-2">
        <p className="px-1.5 text-[11px] font-medium text-foreground">{sideName}</p>
        <ArrowEndMenu
          value={value}
          mirrored={mirrored}
          onPick={(end) => {
            onPick(end);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
