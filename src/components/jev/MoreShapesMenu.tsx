"use client";

import { useState } from "react";
import {
  IconActivation,
  IconBlob,
  IconCache,
  IconClass,
  IconEntity,
  IconExternalSystem,
  IconFinalState,
  IconFragment,
  IconInitialState,
  IconLoadBalancer,
  IconQueue,
  IconShapes,
  IconUser,
  IconZone,
  type IconComponent,
} from "@/brand/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KIND_LABELS } from "@/lib/jev/notation-kinds";
import { MORE_SHAPE_GROUPS, isMoreShapeKind, type MoreShapeKind, type ShapeGroup } from "@/lib/jev/shape-tools";
import type { ToolType } from "@/lib/jev/types";

export const MORE_SHAPE_ICONS: Record<MoreShapeKind, IconComponent> = {
  queue: IconQueue,
  cache: IconCache,
  lb: IconLoadBalancer,
  blob: IconBlob,
  external: IconExternalSystem,
  actor: IconUser,
  zone: IconZone,
  entity: IconEntity,
  class: IconClass,
  activation: IconActivation,
  fragment: IconFragment,
  initial: IconInitialState,
  final: IconFinalState,
};

/** Kinds a selected box can turn into in place: same footprint, so no containers, bars or pseudo-states. */
export const KIND_SWAP_GROUPS: readonly ShapeGroup<MoreShapeKind>[] = [
  { title: "System design", kinds: ["queue", "cache", "lb", "blob", "external", "actor"] },
  { title: "LLD notation", kinds: ["entity", "class"] },
];

interface MoreShapesPanelProps {
  groups: readonly ShapeGroup<MoreShapeKind>[];
  activeKind?: string;
  onPick: (kind: MoreShapeKind) => void;
}

export function MoreShapesPanel({ groups, activeKind, onPick }: MoreShapesPanelProps) {
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title} className="flex flex-col gap-1">
          <h3 className="px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {group.title}
          </h3>
          <div className="grid grid-cols-2 gap-0.5">
            {group.kinds.map((kind) => {
              const KindIcon = MORE_SHAPE_ICONS[kind];
              const active = activeKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-label={KIND_LABELS[kind]}
                  aria-pressed={active}
                  onClick={() => onPick(kind)}
                  className={`flex min-h-9 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[11.5px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7 ${
                    active
                      ? "bg-[#1C2028] text-[#F8F6F1] dark:bg-[#F1EDE4] dark:text-[#11151D]"
                      : "text-foreground/85 hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  <KindIcon className="h-4 w-4 shrink-0" />
                  <span>{KIND_LABELS[kind]}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

interface MoreShapesButtonProps {
  tool: ToolType;
  onPick: (kind: MoreShapeKind) => void;
}

/** Dock entry for every HLD / LLD shape: shows the picked kind's icon while that tool is armed. */
export function MoreShapesButton({ tool, onPick }: MoreShapesButtonProps) {
  const [open, setOpen] = useState(false);
  const armed = isMoreShapeKind(tool) ? tool : null;
  const TriggerIcon = armed ? MORE_SHAPE_ICONS[armed] : IconShapes;
  const label = armed ? `More shapes (${KIND_LABELS[armed]})` : "More shapes";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={Boolean(armed)}
                  className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8 ${
                    armed || open
                      ? armed
                        ? "bg-[#1C2028] text-[#F8F6F1] shadow-xs dark:bg-[#F1EDE4] dark:text-[#11151D]"
                        : "bg-secondary text-foreground"
                      : "text-foreground/80 hover:bg-secondary hover:text-foreground"
                  }`}
                />
              }
            />
          }
        >
          <TriggerIcon className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="center" sideOffset={8} className="w-[23.5rem] max-w-[calc(100vw-24px)] rounded-2xl p-2">
        <MoreShapesPanel
          groups={MORE_SHAPE_GROUPS}
          activeKind={armed ?? undefined}
          onPick={(kind) => {
            onPick(kind);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
