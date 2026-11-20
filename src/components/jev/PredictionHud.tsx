"use client";

import React from "react";
import {
  ArrowRight,
  GitBranch,
  Layers,
  Sparkles,
  X,
} from "lucide-react";
import { PredictedAction, SpatialIntent } from "@/lib/jev/types";

interface PredictionHudProps {
  intent: SpatialIntent | null;
  predictions: PredictedAction[];
  activeIndex: number;
  onHoverIndex: (idx: number) => void;
  onApply: (idx: number) => void;
  onDismiss: () => void;
}

function categoryIcon(cat: PredictedAction["category"]) {
  switch (cat) {
    case "connect":
      return <GitBranch className="h-3.5 w-3.5" />;
    case "structure":
      return <Layers className="h-3.5 w-3.5" />;
    default:
      return <ArrowRight className="h-3.5 w-3.5" />;
  }
}

export function PredictionHud({
  intent,
  predictions,
  activeIndex,
  onHoverIndex,
  onApply,
  onDismiss,
}: PredictionHudProps) {
  if (!intent && predictions.length === 0) return null;

  return (
    <div className="pointer-events-auto flex w-full max-w-[760px] flex-col items-center gap-2 px-3">
      {/* Compact Spatial Intent Understanding Pill */}
      {intent && (
        <div className="jev-glass inline-flex max-w-full items-center gap-2 rounded-full px-3.5 py-1.5 text-xs shadow-sm">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#D94E28]/15 text-[#D94E28]">
            <Sparkles className="h-2.5 w-2.5" />
          </span>
          <span className="truncate font-medium text-foreground">
            {intent.headline}
          </span>
          <span className="hidden text-muted-foreground sm:inline">·</span>
          <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
            {intent.detail}
          </span>
        </div>
      )}

      {/* 3-Option Tab + Enter Predictive Strip */}
      {predictions.length > 0 && (
        <div className="jev-glass w-full rounded-2xl p-1.5 shadow-[0_12px_36px_-12px_rgba(15,23,42,0.22)]">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono font-semibold uppercase tracking-[0.08em] text-[#2563EB] dark:text-[#38BDF8]">
                Next Action
              </span>
              <span className="hidden sm:inline">
                Ghost preview on canvas
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
                <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-semibold text-foreground">
                  Tab
                </kbd>
                <span>cycle</span>
                <kbd className="ml-1 rounded border border-[#2563EB]/30 bg-[#2563EB]/10 px-1.5 py-0.5 font-semibold text-[#2563EB] dark:border-[#38BDF8]/30 dark:bg-[#38BDF8]/15 dark:text-[#38BDF8]">
                  Enter ↵
                </kbd>
                <span>apply</span>
              </div>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss predictions"
                className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            {predictions.map((pred, idx) => {
              const isActive = idx === activeIndex;
              return (
                <button
                  key={pred.id}
                  type="button"
                  onMouseEnter={() => onHoverIndex(idx)}
                  onClick={() => onApply(idx)}
                  className={`group flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-all ${
                    isActive
                      ? "border-[#2563EB]/55 bg-[#2563EB]/10 shadow-xs dark:border-[#38BDF8]/55 dark:bg-[#38BDF8]/12"
                      : "border-transparent bg-transparent hover:border-border hover:bg-secondary/60"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-semibold transition-colors ${
                      isActive
                        ? "bg-[#2563EB] text-white dark:bg-[#38BDF8] dark:text-[#0F172A]"
                        : "bg-secondary text-muted-foreground group-hover:text-foreground"
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`truncate text-[12.5px] font-semibold leading-snug ${
                          isActive ? "text-foreground" : "text-foreground/85"
                        }`}
                      >
                        {pred.title}
                      </span>
                    </div>
                    <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <span className="shrink-0 opacity-75">
                        {categoryIcon(pred.category)}
                      </span>
                      <span className="truncate">{pred.subtitle}</span>
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
