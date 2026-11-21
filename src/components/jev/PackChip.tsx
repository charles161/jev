"use client";

import { IconClose, IconEndOneMany, IconEntity, IconSequence, IconStateMachine, type IconComponent } from "@/brand/icons";
import type { PackChip as PackChipModel, PackChipKind } from "@/lib/jev/pack-inference";
import type { Viewport } from "@/lib/jev/types";

const CHIP_ICONS: Record<PackChipKind, IconComponent> = {
  "er-entity": IconEntity,
  "crows-foot": IconEndOneMany,
  sequence: IconSequence,
  state: IconStateMachine,
};

interface PackChipProps {
  chip: PackChipModel;
  viewport: Viewport;
  screen: { width: number; height: number };
  onApply: (chip: PackChipModel) => void;
  onDismiss: (chip: PackChipModel) => void;
}

/** A quiet, dismissible hint beside the element whose drawing implies a notation pack. Never a modal. */
export function PackChip({ chip, viewport, screen, onApply, onDismiss }: PackChipProps) {
  const Icon = CHIP_ICONS[chip.kind];
  const maxW = Math.min(300, screen.width - 24);
  const sx = viewport.x + chip.anchor.x * viewport.zoom + 8;
  const sy = viewport.y + chip.anchor.y * viewport.zoom - 38;
  if (sx < 0 || sx > screen.width || sy + 38 < 0 || sy > screen.height) return null;
  const x = Math.max(12, Math.min(screen.width - 12 - maxW, Math.round(sx)));
  const y = Math.max(screen.width < 640 ? 118 : 76, Math.min(screen.height - 260, Math.round(sy)));
  return (
    <div
      role="group"
      aria-label="Pack suggestion"
      data-chip-kind={chip.kind}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ transform: `translate3d(${x}px, ${y}px, 0)`, maxWidth: maxW }}
      className="jev-glass fixed left-0 top-0 z-20 flex items-center gap-0.5 rounded-full py-0.5 pl-1 pr-0.5 shadow-[0_10px_28px_-12px_rgba(15,23,42,0.32)] animate-in fade-in-0 zoom-in-95"
    >
      <button
        type="button"
        onClick={() => onApply(chip)}
        className="flex min-h-[32px] min-w-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-semibold text-foreground transition-colors hover:bg-[#D94E28]/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[26px]"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-[#C2411D] dark:text-[#FF8562]" aria-hidden="true" />
        <span className="truncate">{chip.title}</span>
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${chip.title}`}
        onClick={() => onDismiss(chip)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-[26px] sm:w-[26px]"
      >
        <IconClose className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
