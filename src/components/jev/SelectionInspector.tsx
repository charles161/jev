"use client";

import React from "react";
import {
  ArrowLeftRight,
  Copy,
  Trash2,
} from "lucide-react";
import { ALL_TONES, getTonePalette } from "@/lib/jev/colors";
import {
  BoardTheme,
  ColorTone,
  ElementKind,
  JevElement,
} from "@/lib/jev/types";

interface SelectionInspectorProps {
  element: JevElement | null;
  theme: BoardTheme;
  onPatch: (id: string, patch: Partial<JevElement>) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

const SHAPE_KINDS: Array<{ kind: ElementKind; label: string }> = [
  { kind: "node", label: "Box" },
  { kind: "diamond", label: "Decision" },
  { kind: "database", label: "Store" },
  { kind: "ellipse", label: "Actor" },
];

export function SelectionInspector({
  element,
  theme,
  onPatch,
  onDuplicate,
  onDelete,
}: SelectionInspectorProps) {
  if (!element) return null;

  const isConvertibleShape =
    element.kind === "node" ||
    element.kind === "diamond" ||
    element.kind === "database" ||
    element.kind === "ellipse";

  return (
    <aside className="jev-glass pointer-events-auto hidden w-[236px] flex-col gap-3 rounded-2xl p-3.5 shadow-[0_14px_38px_-14px_rgba(15,23,42,0.22)] md:flex">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
          {element.kind}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onDuplicate(element.id)}
            title="Duplicate (⌘D)"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(element.id)}
            title="Delete (Backspace)"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Label & Sublabel quick editors */}
      {element.kind !== "freedraw" && (
        <div className="flex flex-col gap-1.5">
          <input
            value={element.label}
            onChange={(e) => onPatch(element.id, { label: e.target.value })}
            placeholder="Label"
            className="w-full rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground outline-none focus:border-[#D94E28]"
          />
          {isConvertibleShape && (
            <input
              value={element.sublabel ?? ""}
              onChange={(e) =>
                onPatch(element.id, { sublabel: e.target.value || undefined })
              }
              placeholder="Sublabel (optional)"
              className="w-full rounded-lg border border-border bg-background/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground outline-none focus:border-[#D94E28] focus:text-foreground"
            />
          )}
        </div>
      )}

      {/* Color Tone Swatches */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          Ink & Wash
        </span>
        <div className="flex items-center gap-1.5">
          {ALL_TONES.map((tone: ColorTone) => {
            const pal = getTonePalette(tone, theme);
            const active = element.tone === tone;
            return (
              <button
                key={tone}
                type="button"
                title={pal.label}
                onClick={() => onPatch(element.id, { tone })}
                className={`h-6 w-6 rounded-full border transition-transform hover:scale-110 ${
                  active
                    ? "ring-2 ring-[#D94E28] ring-offset-2 ring-offset-card scale-105"
                    : "border-black/15 dark:border-white/15"
                }`}
                style={{ backgroundColor: pal.swatch }}
              />
            );
          })}
        </div>
      </div>

      {/* Shape Switcher */}
      {isConvertibleShape && (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            Form
          </span>
          <div className="grid grid-cols-2 gap-1">
            {SHAPE_KINDS.map((sk) => (
              <button
                key={sk.kind}
                type="button"
                onClick={() => onPatch(element.id, { kind: sk.kind })}
                className={`rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors ${
                  element.kind === sk.kind
                    ? "bg-foreground text-background"
                    : "bg-secondary/70 text-foreground/80 hover:bg-secondary"
                }`}
              >
                {sk.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Arrow options */}
      {element.kind === "arrow" && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPatch(element.id, { dashed: !element.dashed })}
            className={`flex-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium transition-colors ${
              element.dashed
                ? "bg-foreground text-background"
                : "bg-secondary/70 text-foreground/80 hover:bg-secondary"
            }`}
          >
            Dashed
          </button>
          <button
            type="button"
            onClick={() =>
              onPatch(element.id, { bidirectional: !element.bidirectional })
            }
            className={`inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium transition-colors ${
              element.bidirectional
                ? "bg-foreground text-background"
                : "bg-secondary/70 text-foreground/80 hover:bg-secondary"
            }`}
          >
            <ArrowLeftRight className="h-3 w-3" />
            Two-way
          </button>
        </div>
      )}
    </aside>
  );
}
