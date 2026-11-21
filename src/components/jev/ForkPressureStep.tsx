"use client";

import React, { useMemo, useState } from "react";
import { IconArrowRight, IconClose, IconFork } from "@/brand/icons";
import {
  describeForkConstraint,
  FORK_PRESSURE_LABELS,
  FORK_PRESSURES,
  parseForkConstraint,
  type ForkConstraint,
} from "@/lib/jev/fork-constraint";

interface ForkPressureStepProps {
  selectedCount: number;
  onChoose: (constraint: ForkConstraint) => void;
  onSkip: () => void;
  onCancel: () => void;
}

export function ForkPressureStep({ selectedCount, onChoose, onSkip, onCancel }: ForkPressureStepProps) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseForkConstraint(text), [text]);
  const typed = text.trim().length > 0;

  const submitText = () => {
    if (parsed) onChoose(parsed);
  };

  return (
    <div
      role="region"
      aria-label="Fork It pressure"
      className="pointer-events-auto flex w-full max-w-[min(640px,100vw)] flex-col items-center px-3"
    >
      <div className="jev-glass w-full rounded-2xl border border-[#D94E28]/25 p-3 shadow-[0_16px_42px_-14px_rgba(15,23,42,0.3)]">
        <div className="flex items-center justify-between gap-2 pb-2.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-[#C2411D] dark:text-[#FF8562]">
              <IconFork className="h-3.5 w-3.5" aria-hidden="true" />
              Fork It · {selectedCount} {selectedCount === 1 ? "node" : "nodes"}
            </span>
            <span className="text-[13px] font-semibold text-foreground">What has to give?</span>
          </div>
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

        <div role="group" aria-label="Pressure" className="flex flex-wrap gap-1.5">
          {FORK_PRESSURES.map((pressure, idx) => (
            <button
              key={pressure}
              type="button"
              onClick={() => onChoose({ pressure })}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-border bg-secondary/60 px-3 py-1 text-[12.5px] font-semibold text-foreground transition-colors hover:border-[#2563EB]/60 hover:bg-[#2563EB]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:border-[#38BDF8]/60 dark:hover:bg-[#38BDF8]/12"
            >
              <kbd className="font-mono text-[10px] font-medium text-muted-foreground">{idx + 1}</kbd>
              {FORK_PRESSURE_LABELS[pressure]}
            </button>
          ))}
        </div>

        <form
          className="mt-2.5 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submitText();
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
            maxLength={120}
            aria-label="Target"
            aria-describedby="fork-pressure-reading"
            placeholder="or a target: p99 < 100 ms · 10M writes/day · $500/mo · 99.99%"
            className="min-h-[36px] min-w-0 flex-1 rounded-xl border border-border bg-background/70 px-3 py-1.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/80 focus:border-[#2563EB]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:focus:border-[#38BDF8]/60"
          />
          <button
            type="submit"
            disabled={!parsed}
            aria-label="Fork for this target"
            className="inline-flex min-h-[36px] items-center justify-center rounded-xl bg-[#D94E28] px-3 text-white transition-colors hover:bg-[#C0411E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground"
          >
            <IconArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </form>

        <div className="mt-2 flex items-center justify-between gap-2">
          <p id="fork-pressure-reading" aria-live="polite" className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
            {typed
              ? parsed
                ? <>Reads as <span className="font-semibold text-foreground">{describeForkConstraint(parsed)}</span></>
                : "No pressure recognised yet"
              : "Pick a pressure, or state a number"}
          </p>
          <button
            type="button"
            onClick={onSkip}
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Skip: classic takes
          </button>
        </div>
      </div>
    </div>
  );
}
