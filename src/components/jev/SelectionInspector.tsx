"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Copy, Trash2, X } from "lucide-react";
import { ALL_TONES, getTonePalette } from "@/lib/jev/colors";
import { computeSmartPopoverPlacement } from "@/lib/jev/popover-placement";
import {
  BoardTheme,
  ColorTone,
  ElementKind,
  JevElement,
  Viewport,
} from "@/lib/jev/types";

interface SelectionInspectorProps {
  element: JevElement | null;
  allElements: JevElement[];
  ghostElements: JevElement[];
  viewport: Viewport;
  theme: BoardTheme;
  hasPredictionHud: boolean;
  hiddenWhileInteracting?: boolean;
  onPatch: (id: string, patch: Partial<JevElement>) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const SHAPE_KINDS: Array<{ kind: ElementKind; label: string }> = [
  { kind: "node", label: "Box" },
  { kind: "diamond", label: "Decision" },
  { kind: "database", label: "Store" },
  { kind: "ellipse", label: "Actor" },
];

export function SelectionInspector({
  element,
  allElements,
  ghostElements,
  viewport,
  theme,
  hasPredictionHud,
  hiddenWhileInteracting = false,
  onPatch,
  onDuplicate,
  onDelete,
  onClose,
}: SelectionInspectorProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState({ width: 244, height: 210 });
  const [screenSize, setScreenSize] = useState({ width: 1280, height: 800 });

  useEffect(() => {
    const syncScreen = () => {
      setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    };
    syncScreen();
    window.addEventListener("resize", syncScreen);
    return () => window.removeEventListener("resize", syncScreen);
  }, []);

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setCardSize((prev) =>
          Math.abs(prev.width - rect.width) > 2 ||
          Math.abs(prev.height - rect.height) > 2
            ? { width: Math.round(rect.width), height: Math.round(rect.height) }
            : prev
        );
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [element?.id, element?.kind]);

  const placement = useMemo(() => {
    if (!element) return null;
    return computeSmartPopoverPlacement({
      element,
      allElements,
      ghostElements,
      viewport,
      screenWidth: screenSize.width,
      screenHeight: screenSize.height,
      popoverWidth: cardSize.width,
      popoverHeight: cardSize.height,
      hasPredictionHud,
    });
  }, [
    element,
    allElements,
    ghostElements,
    viewport,
    screenSize.width,
    screenSize.height,
    cardSize.width,
    cardSize.height,
    hasPredictionHud,
  ]);

  if (!element || !placement) return null;

  const isConvertibleShape =
    element.kind === "node" ||
    element.kind === "diamond" ||
    element.kind === "database" ||
    element.kind === "ellipse";

  return (
    <aside
      ref={cardRef}
      role="dialog"
      aria-label={`Edit ${element.label || element.kind}`}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        transform: `translate3d(${placement.x}px, ${placement.y}px, 0)`,
      }}
      className={`jev-glass fixed left-0 top-0 z-30 flex w-[244px] flex-col gap-2.5 rounded-2xl p-3 shadow-[0_16px_42px_-12px_rgba(15,23,42,0.28)] transition-[opacity] duration-150 ${
        hiddenWhileInteracting
          ? "pointer-events-none opacity-0"
          : "pointer-events-auto opacity-100"
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#D94E28]" />
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            {element.kind}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
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
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Label & Sublabel quick editors */}
      {element.kind !== "freedraw" && (
        <div className="flex flex-col gap-1.5">
          <input
            value={element.label}
            onChange={(e) => onPatch(element.id, { label: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") onClose();
            }}
            placeholder={element.kind === "arrow" ? "Arrow label…" : "Label"}
            className="w-full rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-xs font-medium text-foreground outline-none focus:border-[#D94E28]"
          />
          {isConvertibleShape && (
            <input
              value={element.sublabel ?? ""}
              onChange={(e) =>
                onPatch(element.id, { sublabel: e.target.value || undefined })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") onClose();
              }}
              placeholder="Sublabel (optional)"
              className="w-full rounded-lg border border-border bg-background/45 px-2.5 py-1 font-mono text-[11px] text-muted-foreground outline-none focus:border-[#D94E28] focus:text-foreground"
            />
          )}
        </div>
      )}

      {/* Color Tone Swatches */}
      <div className="flex items-center justify-between gap-1.5">
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
                  ? "scale-105 ring-2 ring-[#D94E28] ring-offset-2 ring-offset-card"
                  : "border-black/15 dark:border-white/15"
              }`}
              style={{ backgroundColor: pal.swatch }}
            />
          );
        })}
      </div>

      {/* Shape Switcher */}
      {isConvertibleShape && (
        <div className="grid grid-cols-4 gap-1">
          {SHAPE_KINDS.map((sk) => (
            <button
              key={sk.kind}
              type="button"
              onClick={() => onPatch(element.id, { kind: sk.kind })}
              className={`rounded-lg px-1.5 py-1 text-[11px] font-medium transition-colors ${
                element.kind === sk.kind
                  ? "bg-foreground text-background"
                  : "bg-secondary/75 text-foreground/80 hover:bg-secondary"
              }`}
            >
              {sk.label}
            </button>
          ))}
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
                : "bg-secondary/75 text-foreground/80 hover:bg-secondary"
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
                : "bg-secondary/75 text-foreground/80 hover:bg-secondary"
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
