"use client";

import React, { useState } from "react";
import { IconChevronRight, IconPause, IconPlay, IconReview, IconSpinner, IconStop, IconTarget, IconTimer } from "@/brand/icons";
import type { PracticePrompt } from "@/lib/jev/practice-prompts";
import { formatClock, remainingMs, type PracticeSession } from "@/lib/jev/practice-session";

const LOW_TIME_MS = 5 * 60_000;

interface PracticeHudProps {
  prompt: PracticePrompt;
  session: PracticeSession;
  now: number;
  reviewPending: boolean;
  onPause: () => void;
  onResume: () => void;
  onReview: () => void;
  onExit: () => void;
}

function wideScreen() {
  return typeof window !== "undefined" && window.matchMedia?.("(min-width: 640px)").matches === true;
}

export function PracticeHud({ prompt, session, now, reviewPending, onPause, onResume, onReview, onExit }: PracticeHudProps) {
  const [briefOpen, setBriefOpen] = useState(wideScreen);
  const left = remainingMs(session, now);
  const paused = session.pausedAt !== null;
  const reviewing = session.phase === "review";
  const low = !reviewing && left <= LOW_TIME_MS;

  return (
    <>
      <section
        role="region"
        aria-label="Practice prompt"
        className={`jev-glass pointer-events-auto fixed left-3 right-3 top-[124px] z-20 rounded-2xl px-3.5 py-2.5 shadow-sm sm:left-4 sm:right-auto sm:top-[76px] sm:w-[300px] ${reviewing ? "hidden sm:block" : ""}`}
      >
        <button
          type="button"
          aria-expanded={briefOpen}
          onClick={() => setBriefOpen((o) => !o)}
          className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#D94E28]/12 text-[#C2411D] dark:bg-[#F0643E]/16 dark:text-[#FF8562]">
            <IconTarget className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Practice · {prompt.minutes} min
            </span>
            <span className="block truncate text-[13.5px] font-semibold text-foreground">{prompt.title}</span>
          </span>
          <IconChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${briefOpen ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          <span className="sr-only">{briefOpen ? "Hide brief" : "Show brief"}</span>
        </button>

        {briefOpen && (
          <div className="mt-2 max-h-[38dvh] overflow-y-auto pr-0.5 sm:max-h-[calc(100dvh-280px)]">
            <p className="text-[12px] leading-snug text-foreground/90">{prompt.brief}</p>
            <h3 className="mt-2.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Functional, to pin down
            </h3>
            <ul className="mt-1 space-y-0.5 text-[11.5px] leading-snug text-foreground/85">
              {prompt.functional.map((f) => (
                <li key={f} className="flex gap-1.5">
                  <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
                  {f}
                </li>
              ))}
            </ul>
            <h3 className="mt-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Non-functional
            </h3>
            <ul className="mt-1 space-y-0.5 text-[11.5px] leading-snug text-foreground/85">
              {prompt.nonFunctional.map((f) => (
                <li key={f} className="flex gap-1.5">
                  <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11px] text-muted-foreground">AI is off until you press Review.</p>
          </div>
        )}
      </section>

      <div
        role="toolbar"
        aria-label="Practice controls"
        className="jev-glass pointer-events-auto flex max-w-[calc(100vw-24px)] items-center gap-1 rounded-2xl p-1.5 shadow-sm"
      >
        <span
          role="timer"
          aria-label={`Time left ${formatClock(left)}${paused ? ", paused" : ""}`}
          className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 font-mono text-[13px] font-semibold tabular-nums ${
            low ? "text-[#C2411D] dark:text-[#FF8562]" : "text-foreground"
          }`}
        >
          <IconTimer className="h-3.5 w-3.5" aria-hidden="true" />
          {formatClock(left)}
          {paused && <span className="font-sans text-[10.5px] font-medium text-muted-foreground">paused</span>}
        </span>

        {!reviewing && (
          <button
            type="button"
            onClick={paused ? onResume : onPause}
            aria-label={paused ? "Resume timer" : "Pause timer"}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
          >
            {paused ? <IconPlay className="h-3.5 w-3.5" aria-hidden="true" /> : <IconPause className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        )}

        <button
          type="button"
          onClick={onReview}
          disabled={reviewPending}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[#D94E28] px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[#C0411E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 sm:min-h-0"
        >
          {reviewPending ? (
            <IconSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <IconReview className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {reviewing ? "Review again" : "Review"}
        </button>

        <button
          type="button"
          onClick={onExit}
          aria-label="End practice"
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
        >
          <IconStop className="h-3.5 w-3.5" aria-hidden="true" />
          End<span className="hidden sm:inline">practice</span>
        </button>
      </div>
    </>
  );
}
