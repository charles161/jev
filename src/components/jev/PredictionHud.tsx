"use client";

import React from "react";
import { IconArrowRight, IconBranch, IconClose, IconCpu, IconLayers, IconSpark } from "@/brand/icons";
import { isJevModelSource, JevTelemetry, PredictedAction, SpatialIntent } from "@/lib/jev/types";

interface PredictionHudProps {
  intent: SpatialIntent | null;
  predictions: PredictedAction[];
  activeIndex: number;
  telemetry: JevTelemetry | null;
  onHoverIndex: (idx: number) => void;
  onApply: (idx: number) => void;
  onDismiss: () => void;
}

function categoryIcon(cat: PredictedAction["category"]) {
  switch (cat) {
    case "connect":
      return <IconBranch className="h-3.5 w-3.5" />;
    case "structure":
      return <IconLayers className="h-3.5 w-3.5" />;
    default:
      return <IconArrowRight className="h-3.5 w-3.5" />;
  }
}

export function PredictionHud({
  intent,
  predictions,
  activeIndex,
  telemetry,
  onHoverIndex,
  onApply,
  onDismiss,
}: PredictionHudProps) {
  if (!intent && predictions.length === 0) return null;

  const isLiveJev =
    (isJevModelSource(telemetry?.source) || telemetry?.source === "llm-json") &&
    telemetry?.isHeuristic !== true;

  return (
    <div
      role="region"
      aria-label="Predictive drafting suggestions"
      className="pointer-events-auto flex w-full max-w-[min(780px,100vw)] flex-col items-center gap-2 px-3"
    >
      {/* Compact Spatial Intent Understanding Pill */}
      {intent && (
        <div className="jev-glass inline-flex max-w-full items-center gap-2 rounded-full px-3.5 py-1.5 text-xs shadow-sm">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#D94E28]/15 text-[#C2411D] dark:text-[#FF8562]">
            <IconSpark className="h-2.5 w-2.5" aria-hidden="true" />
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

      {/* 3-Option Tab + Enter Predictive Strip powered by TypeSafe System One */}
      {predictions.length > 0 && (
        <div className="jev-glass max-h-[38dvh] w-full overflow-y-auto rounded-2xl p-1.5 shadow-[0_12px_36px_-12px_rgba(15,23,42,0.22)] sm:max-h-none sm:overflow-visible">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1.5 pt-0.5">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono font-semibold uppercase tracking-[0.08em] text-[#1D4ED8] dark:text-[#38BDF8]">
                Top 3 Decisions
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
                  isLiveJev
                    ? "bg-[#0F766E]/12 text-[#0F766E] dark:bg-[#34D399]/15 dark:text-[#34D399]"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                <IconCpu className="h-2.5 w-2.5" aria-hidden="true" />
                {telemetry?.evaluating
                  ? "TypeSafe System One deciding…"
                  : isLiveJev
                    ? `TypeSafe ${telemetry.model} · ${telemetry.latencyMs}ms`
                    : "Heuristic"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-1 font-mono text-[10.5px] text-muted-foreground sm:flex">
                <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-semibold text-foreground">
                  Tab
                </kbd>
                <span>cycle</span>
                <kbd className="ml-1 rounded border border-[#2563EB]/30 bg-[#2563EB]/10 px-1.5 py-0.5 font-semibold text-[#1D4ED8] dark:border-[#38BDF8]/30 dark:bg-[#38BDF8]/15 dark:text-[#38BDF8]">
                  Enter ↵
                </kbd>
                <span>apply</span>
              </div>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss predictions"
                className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0 sm:p-0.5"
              >
                <IconClose className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className={`grid grid-cols-1 gap-1.5 ${predictions.length > 1 ? "sm:grid-cols-3" : ""}`}>
            {predictions.map((pred, idx) => {
              const isActive = idx === activeIndex;
              const pct =
                isLiveJev && typeof pred.probability === "number"
                  ? Math.max(1, Math.round(pred.probability * 100))
                  : null;

              return (
                <button
                  key={pred.id}
                  type="button"
                  aria-pressed={isActive}
                  onMouseEnter={() => onHoverIndex(idx)}
                  onClick={() => onApply(idx)}
                  className={`group relative flex min-h-[44px] flex-col gap-1.5 overflow-hidden rounded-xl border px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isActive
                      ? "border-[#2563EB]/55 bg-[#2563EB]/10 shadow-xs dark:border-[#38BDF8]/55 dark:bg-[#38BDF8]/12"
                      : "border-transparent bg-transparent hover:border-border hover:bg-secondary/60"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
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
                      <div className="flex items-center justify-between gap-1.5">
                        <span
                          className={`truncate text-[12.5px] font-semibold leading-snug ${
                            isActive ? "text-foreground" : "text-foreground/85"
                          }`}
                        >
                          {pred.title}
                        </span>
                        {pct !== null && (
                          <span
                            className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] font-semibold ${
                              isActive
                                ? "bg-[#2563EB]/15 text-[#1D4ED8] dark:bg-[#38BDF8]/20 dark:text-[#38BDF8]"
                                : "text-muted-foreground"
                            }`}
                          >
                            {pct}%
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                        <span className="shrink-0 opacity-75" aria-hidden="true">
                          {categoryIcon(pred.category)}
                        </span>
                        <span className="truncate">{pred.subtitle}</span>
                      </p>
                    </div>
                  </div>

                  {/* Subtle probability calibration bar */}
                  {pct !== null && (
                    <div className="h-[2px] w-full overflow-hidden rounded-full bg-border/60">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          isActive
                            ? "bg-[#2563EB] dark:bg-[#38BDF8]"
                            : "bg-muted-foreground/35"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(6, pct))}%` }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
