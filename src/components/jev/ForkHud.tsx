"use client";

import React, { useRef } from "react";
import { IconClose, IconCpu, IconEnter, IconFork, IconScale } from "@/brand/icons";
import type { ForkTake } from "@/lib/jev/fork-engine";
import { isJevModelSource, type DecideSource } from "@/lib/jev/types";

interface ForkHudProps {
  takes: ForkTake[];
  activeIndex: number;
  source: DecideSource;
  model: string;
  isHeuristic: boolean;
  latencyMs: number;
  evaluating: boolean;
  selectedCount: number;
  onSelectIndex: (idx: number) => void;
  onApply: (idx: number) => void;
  onCancel: () => void;
}

export function ForkHud({
  takes,
  activeIndex,
  source,
  model,
  isHeuristic,
  latencyMs,
  evaluating,
  selectedCount,
  onSelectIndex,
  onApply,
  onCancel,
}: ForkHudProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  if (takes.length === 0) return null;

  const isLiveAi = !isHeuristic && (isJevModelSource(source) || source === "llm-json");

  const handleTakeKeyDown = (
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
      const nextIdx = (idx + delta + takes.length) % takes.length;
      onSelectIndex(nextIdx);
      tabRefs.current[nextIdx]?.focus();
    }
  };

  return (
    <div
      role="region"
      aria-label="Fork It architectural takes"
      className="pointer-events-auto flex w-full max-w-[min(840px,100vw)] flex-col items-center gap-2 px-3"
    >
      <div className="jev-glass max-h-[46dvh] w-full overflow-y-auto rounded-2xl border border-[#D94E28]/25 p-2 shadow-[0_16px_42px_-14px_rgba(15,23,42,0.3)] sm:max-h-none sm:overflow-visible">
        {/* Header strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-mono font-semibold uppercase tracking-[0.08em] text-[#C2411D] dark:text-[#FF8562]">
              <IconFork className="h-3.5 w-3.5" aria-hidden="true" />
              Fork It · {selectedCount} {selectedCount === 1 ? "node" : "nodes"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
                isLiveAi
                  ? "bg-[#0F766E]/12 text-[#0F766E] dark:bg-[#34D399]/15 dark:text-[#34D399]"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              <IconCpu className="h-2.5 w-2.5" aria-hidden="true" />
              {evaluating
                ? "Evaluating takes…"
                : isLiveAi
                  ? `AI · ${model}${latencyMs > 0 ? ` · ${latencyMs}ms` : ""}`
                  : "Heuristic"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1 font-mono text-[10.5px] text-muted-foreground md:flex">
              <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-semibold text-foreground">
                Tab
              </kbd>
              <span>cycle</span>
              <kbd className="ml-1 rounded border border-[#D94E28]/35 bg-[#D94E28]/10 px-1.5 py-0.5 font-semibold text-[#C2411D] dark:text-[#FF8562]">
                Enter ↵
              </kbd>
              <span>swap</span>
              <kbd className="ml-1 rounded border border-border bg-secondary px-1.5 py-0.5 font-semibold text-foreground">
                Esc
              </kbd>
              <span>cancel</span>
            </div>

            <button
              type="button"
              onClick={() => onApply(activeIndex)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-xl bg-[#D94E28] px-3 py-1 text-[11px] font-semibold text-white shadow-xs transition-colors hover:bg-[#C0411E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card sm:min-h-0 sm:px-2.5"
            >
              Swap in place
              <IconEnter className="h-3 w-3" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel Fork It"
              title="Cancel (Esc)"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:min-w-0"
            >
              <IconClose className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* 3 Distinct Architectural Take Tabs */}
        <div
          role="tablist"
          aria-label="Architectural fork takes"
          className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
        >
          {takes.map((take, idx) => {
            const isActive = idx === activeIndex;
            const pct =
              isLiveAi && typeof take.probability === "number"
                ? Math.max(1, Math.round(take.probability * 100))
                : null;

            return (
              <button
                key={take.id}
                ref={(node) => {
                  tabRefs.current[idx] = node;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onMouseEnter={() => onSelectIndex(idx)}
                onKeyDown={(e) => handleTakeKeyDown(e, idx)}
                onClick={() => {
                  if (isActive) {
                    onApply(idx);
                  } else {
                    onSelectIndex(idx);
                  }
                }}
                className={`group relative flex min-h-[44px] flex-col justify-between gap-2 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? "border-[#2563EB]/60 bg-[#2563EB]/10 shadow-xs dark:border-[#38BDF8]/60 dark:bg-[#38BDF8]/12"
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
                        {take.title}
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
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {take.rationale}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-900 dark:bg-amber-400/15 dark:text-amber-300">
                    <IconScale className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{take.tradeoffTag}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {take.graph.nodes.length}n · {take.graph.edges.length}e
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
