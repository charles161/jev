"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Circle,
  Copy,
  Database,
  Diamond,
  GitFork,
  Pencil,
  Square,
  Trash2,
} from "lucide-react";
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
  onStartInlineEdit: (id: string) => void;
  onFork?: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

const SHAPE_KINDS: Array<{
  kind: ElementKind;
  label: string;
  icon: React.ReactNode;
}> = [
  { kind: "node", label: "Box", icon: <Square className="h-3 w-3" /> },
  { kind: "diamond", label: "Decision", icon: <Diamond className="h-3 w-3" /> },
  { kind: "database", label: "Store", icon: <Database className="h-3 w-3" /> },
  { kind: "ellipse", label: "Actor", icon: <Circle className="h-3 w-3" /> },
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
  onStartInlineEdit,
  onFork,
  onDuplicate,
  onDelete,
}: SelectionInspectorProps) {
  const pillRef = useRef<HTMLDivElement | null>(null);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pillSize, setPillSize] = useState({ width: 296, height: 36 });
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
    const node = pillRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setPillSize((prev) =>
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
      popoverWidth: pillSize.width,
      popoverHeight: pillSize.height,
      hasPredictionHud,
    });
  }, [
    element,
    allElements,
    ghostElements,
    viewport,
    screenSize.width,
    screenSize.height,
    pillSize.width,
    pillSize.height,
    hasPredictionHud,
  ]);

  if (!element || !placement || hiddenWhileInteracting) return null;

  const isShape =
    element.kind === "node" ||
    element.kind === "diamond" ||
    element.kind === "database" ||
    element.kind === "ellipse";

  const handleSwatchKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    if (
      e.key === "ArrowRight" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowUp"
    ) {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const nextIdx = (idx + delta + ALL_TONES.length) % ALL_TONES.length;
      const nextTone = ALL_TONES[nextIdx];
      onPatch(element.id, { tone: nextTone });
      swatchRefs.current[nextIdx]?.focus();
    }
  };

  return (
    <div
      ref={pillRef}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        transform: `translate3d(${placement.x}px, ${placement.y}px, 0)`,
      }}
      className="fixed left-0 top-0 z-30 flex items-center gap-1 rounded-full border border-border/90 bg-card/95 px-2 py-1 shadow-[0_8px_24px_-10px_rgba(15,23,42,0.28)] backdrop-blur-md transition-transform duration-150 ease-out"
    >
      {/* Keyboard-navigable color dots (← / → arrows) */}
      <div
        role="radiogroup"
        aria-label="Color (use Left and Right arrow keys)"
        className="flex items-center gap-1 pr-0.5"
      >
        {ALL_TONES.map((tone: ColorTone, idx) => {
          const swatch = getTonePalette(tone, theme).stroke;
          const active = element.tone === tone;
          return (
            <button
              key={tone}
              ref={(node) => {
                swatchRefs.current[idx] = node;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onPatch(element.id, { tone })}
              onKeyDown={(e) => handleSwatchKeyDown(e, idx)}
              title={`${tone} (← / → keys)`}
              className={`h-4 w-4 rounded-full transition-transform hover:scale-115 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D94E28] focus-visible:ring-offset-1 ${
                active
                  ? "scale-110 ring-2 ring-[#D94E28] ring-offset-1 ring-offset-card"
                  : "opacity-85 hover:opacity-100"
              }`}
              style={{ backgroundColor: swatch }}
            />
          );
        })}
      </div>

      {/* Shape kind icons (no clipped text!) */}
      {isShape && (
        <>
          <span className="h-3.5 w-px bg-border" />
          <div className="flex items-center gap-0.5">
            {SHAPE_KINDS.map((sk) => {
              const active = element.kind === sk.kind;
              return (
                <button
                  key={sk.kind}
                  type="button"
                  onClick={() => onPatch(element.id, { kind: sk.kind })}
                  title={sk.label}
                  className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                    active
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  {sk.icon}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Arrow quick toggles */}
      {element.kind === "arrow" && (
        <>
          <span className="h-3.5 w-px bg-border" />
          <button
            type="button"
            onClick={() => onPatch(element.id, { dashed: !element.dashed })}
            title="Toggle dashed"
            className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
              element.dashed
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            Dashed
          </button>
          <button
            type="button"
            onClick={() =>
              onPatch(element.id, { bidirectional: !element.bidirectional })
            }
            title="Toggle bidirectional"
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
              element.bidirectional
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <ArrowLeftRight className="h-3 w-3" />
          </button>
        </>
      )}

      {/* Fork It trigger for shapes & frames */}
      {(isShape || element.kind === "frame") && onFork && (
        <>
          <span className="h-3.5 w-px bg-border" />
          <button
            type="button"
            onClick={onFork}
            title="Fork into 3 architectural takes (F)"
            className="inline-flex items-center gap-1 rounded-full bg-[#D94E28]/12 px-2 py-0.5 text-[11px] font-semibold text-[#D94E28] transition-colors hover:bg-[#D94E28] hover:text-white"
          >
            <GitFork className="h-3 w-3" />
            <span>Fork it</span>
          </button>
        </>
      )}

      {/* Rename in-place, copy, delete */}
      <span className="h-3.5 w-px bg-border" />
      <div className="flex items-center gap-0.5">
        {element.kind !== "freedraw" && (
          <button
            type="button"
            onClick={() => onStartInlineEdit(element.id)}
            title="Edit title in place (double-click or Enter)"
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onDuplicate(element.id)}
          title="Duplicate (⌘D)"
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Copy className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(element.id)}
          title="Delete"
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
