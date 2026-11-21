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
  MorphNotation,
  Viewport,
} from "@/lib/jev/types";
import { NotationMorphBar } from "./NotationMorphBar";

interface SelectionInspectorProps {
  element: JevElement | null;
  allElements: JevElement[];
  ghostElements: JevElement[];
  viewport: Viewport;
  theme: BoardTheme;
  hasPredictionHud: boolean;
  hiddenWhileInteracting?: boolean;
  activeNotation?: MorphNotation;
  isMorphedGroup?: boolean;
  morphEvaluating?: boolean;
  morphIsHeuristic?: boolean;
  onPatch: (id: string, patch: Partial<JevElement>) => void;
  onStartInlineEdit: (id: string) => void;
  onFork?: () => void;
  onMorphNotation?: (notation: MorphNotation) => void;
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
  activeNotation = "sketch",
  isMorphedGroup = false,
  morphEvaluating = false,
  morphIsHeuristic = true,
  onPatch,
  onStartInlineEdit,
  onFork,
  onMorphNotation,
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

  const safeY =
    screenSize.width < 640 ? Math.max(118, placement.y) : placement.y;

  return (
    <div
      ref={pillRef}
      role="toolbar"
      aria-label="Selected element controls"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        transform: `translate3d(${placement.x}px, ${safeY}px, 0)`,
      }}
      className="fixed left-0 top-0 z-30 flex max-w-[calc(100vw-28px)] flex-wrap items-center gap-1 rounded-2xl border border-border/90 bg-card/95 px-2 py-1 shadow-[0_8px_24px_-10px_rgba(15,23,42,0.28)] backdrop-blur-md transition-transform duration-150 ease-out"
    >
      {/* Keyboard-navigable color dots (← / → arrows) */}
      <div
        role="radiogroup"
        aria-label="Color (use Left and Right arrow keys)"
        className="flex items-center gap-0.5 pr-0.5 sm:gap-1"
      >
        {ALL_TONES.map((tone: ColorTone, idx) => {
          const palette = getTonePalette(tone, theme);
          const swatch = palette.stroke;
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
              aria-label={`Color: ${palette.label}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onPatch(element.id, { tone })}
              onKeyDown={(e) => handleSwatchKeyDown(e, idx)}
              title={`${palette.label} (← / → keys)`}
              className="flex h-7 w-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-5 sm:w-5"
            >
              <span
                className={`h-4 w-4 rounded-full transition-transform hover:scale-115 ${
                  active
                    ? "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-card"
                    : "opacity-85 hover:opacity-100"
                }`}
                style={{ backgroundColor: swatch }}
              />
            </button>
          );
        })}
      </div>

      {/* Shape kind icons (no clipped text!) */}
      {isShape && (
        <>
          <span className="h-3.5 w-px bg-border" aria-hidden="true" />
          <div className="flex items-center gap-0.5" role="group" aria-label="Shape type">
            {SHAPE_KINDS.map((sk) => {
              const active = element.kind === sk.kind;
              return (
                <button
                  key={sk.kind}
                  type="button"
                  aria-label={`Shape: ${sk.label}`}
                  aria-pressed={active}
                  onClick={() => onPatch(element.id, { kind: sk.kind })}
                  title={sk.label}
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-6 ${
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
          <span className="h-3.5 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            aria-pressed={Boolean(element.dashed)}
            onClick={() => onPatch(element.id, { dashed: !element.dashed })}
            title="Toggle dashed"
            className={`min-h-[36px] rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:px-2 sm:text-[10.5px] ${
              element.dashed
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            Dashed
          </button>
          <button
            type="button"
            aria-label="Toggle bidirectional arrow"
            aria-pressed={Boolean(element.bidirectional)}
            onClick={() =>
              onPatch(element.id, { bidirectional: !element.bidirectional })
            }
            title="Toggle bidirectional"
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-6 ${
              element.bidirectional
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </>
      )}

      {/* Fork It trigger for shapes & frames */}
      {(isShape || element.kind === "frame") && onFork && (
        <>
          <span className="h-3.5 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={onFork}
            title="Fork into 3 architectural takes (F)"
            className="inline-flex min-h-[36px] items-center gap-1 rounded-full bg-[#D94E28]/12 px-2.5 py-0.5 text-[11px] font-semibold text-[#C2411D] transition-colors hover:bg-[#D94E28] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-[#FF8562] dark:hover:text-white sm:min-h-0 sm:px-2"
          >
            <GitFork className="h-3 w-3" aria-hidden="true" />
            <span>Fork it</span>
          </button>
        </>
      )}

      {/* Reversible Notation Morph pill switcher */}
      {onMorphNotation && element.kind !== "freedraw" && (
        <>
          <span className="h-3.5 w-px bg-border" aria-hidden="true" />
          <NotationMorphBar
            activeNotation={activeNotation}
            isMorphedGroup={isMorphedGroup}
            evaluating={morphEvaluating}
            isHeuristic={morphIsHeuristic}
            compact
            onSelectNotation={onMorphNotation}
          />
        </>
      )}

      {/* Rename in-place, copy, delete */}
      <span className="h-3.5 w-px bg-border" aria-hidden="true" />
      <div className="flex items-center gap-0.5">
        {element.kind !== "freedraw" && (
          <button
            type="button"
            aria-label="Edit label in place"
            onClick={() => onStartInlineEdit(element.id)}
            title="Edit title in place (double-click or Enter)"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-6"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label="Duplicate element"
          onClick={() => onDuplicate(element.id)}
          title="Duplicate (⌘D)"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-6"
        >
          <Copy className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Delete element"
          onClick={() => onDelete(element.id)}
          title="Delete"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-6"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
