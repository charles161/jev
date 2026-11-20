"use client";

import React from "react";
import {
  CornerDownLeft,
  Cpu,
  GitFork,
  Scale,
  X,
} from "lucide-react";
import type { ForkTake } from "@/lib/jev/fork-engine";

interface ForkHudProps {
  takes: ForkTake[];
  activeIndex: number;
  source: "typesafe-jev" | "llm-json" | "heuristic";
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
  if (takes.length === 0) return null;

  const isLiveAi = !isHeuristic && (source === "typesafe-jev" || source === "llm-json");

  return (
    <div
      role="region"
      aria-label="Fork It architectural takes"
      className="pointer-events-auto flex w-full max-w-[840px] flex-col items-center gap-2 px-3"
    >
      <div className="jev-glass w-full rounded-2xl border border-[#D94E28]/25 p-2 shadow-[0_16px_42px_-14px_rgba(15,23,42,0.3)]">
        {/* Header strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-mono font-semibold uppercase tracking-[0.08em] text-[#D94E28]">
              <GitFork className="h-3.5 w-3.5" />
              Fork It · {selectedCount} {selectedCount === 1 ? "node" : "nodes"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
                isLiveAi
                  ? "bg-[#0F766E]/12 text-[#0F766E] dark:bg-[#34D399]/15 dark:text-[#34D399]"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              <Cpu className="h-2.5 w-2.5" />
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
              <kbd className="ml-1 rounded border border-[#D94E28]/35 bg-[#D94E28]/10 px-1.5 py-0.5 font-semibold text-[#D94E28]">
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
              className="inline-flex items-center gap-1 rounded-xl bg-[#D94E28] px-2.5 py-1 text-[11px] font-semibold text-white shadow-xs transition-colors hover:bg-[#C0411E]"
            >
              Swap in place
              <CornerDownLeft className="h-3 w-3" />
            </button>

            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel Fork It"
              title="Cancel (Esc)"
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* 3 Distinct Architectural Take Cards */}
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {takes.map((take, idx) => {
            const isActive = idx === activeIndex;
            const pct =
              isLiveAi && typeof take.probability === "number"
                ? Math.max(1, Math.round(take.probability * 100))
                : null;

            return (
              <button
                key={take.id}
                type="button"
                aria-pressed={isActive}
                onMouseEnter={() => onSelectIndex(idx)}
                onClick={() => {
                  if (isActive) {
                    onApply(idx);
                  } else {
                    onSelectIndex(idx);
                  }
                }}
                className={`group relative flex flex-col justify-between gap-2 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-all ${
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
                              ? "bg-[#2563EB]/15 text-[#2563EB] dark:bg-[#38BDF8]/20 dark:text-[#38BDF8]"
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
                  <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-300">
                    <Scale className="h-2.5 w-2.5 shrink-0" />
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
