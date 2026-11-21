"use client";

import React, { useState } from "react";
import { IconChevronRight, IconReview, IconSpinner } from "@/brand/icons";
import type { PracticePrompt } from "@/lib/jev/practice-prompts";
import {
  RUBRIC_LABELS,
  reviewSourceLabel,
  type PracticeReview,
  type ReviewComment,
} from "@/lib/jev/practice-review";
import type { JevElement, Viewport } from "@/lib/jev/types";

const PIN = 22;

function verdict(total: number) {
  if (total >= 8) return "Strong";
  if (total >= 5) return "Getting there";
  return "Needs work";
}

function ScoreDots({ score }: { score: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
      {[0, 1].map((i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full border ${
            i < score ? "border-[#0F766E] bg-[#0F766E] dark:border-[#34D399] dark:bg-[#34D399]" : "border-muted-foreground/50"
          }`}
        />
      ))}
    </span>
  );
}

function PinBadge({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold shadow-sm ring-2 ${
        active
          ? "bg-[#1C2028] text-[#F8F6F1] ring-[#D94E28] dark:bg-[#F1EDE4] dark:text-[#11151D] dark:ring-[#FF8562]"
          : "bg-[#D94E28] text-white ring-background dark:bg-[#F0643E]"
      }`}
    >
      {n}
    </span>
  );
}

interface PracticeReviewPanelProps {
  review: PracticeReview;
  prompt: PracticePrompt;
  pending: boolean;
  activeCommentId: string | null;
  onSelectComment: (comment: ReviewComment) => void;
}

export function PracticeReviewPanel({ review, prompt, pending, activeCommentId, onSelectComment }: PracticeReviewPanelProps) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  return (
    <section
      role="region"
      aria-label="Practice review"
      className="jev-glass pointer-events-auto fixed inset-x-3 bottom-[72px] z-20 flex max-h-[44dvh] flex-col rounded-2xl shadow-[0_14px_36px_-12px_rgba(15,23,42,0.32)] sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[76px] sm:max-h-[calc(100dvh-160px)] sm:w-[340px]"
    >
      <header className="flex items-start gap-3 border-b border-border/70 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <IconReview className="h-3 w-3" aria-hidden="true" />
            {prompt.title} · review
          </span>
          <p className="mt-0.5 flex items-baseline gap-2">
            <span className="text-[24px] font-semibold leading-none tracking-tight text-foreground" aria-label={`Score ${review.total} out of ${review.max}`}>
              {review.total}
              <span className="text-[14px] font-medium text-muted-foreground">/{review.max}</span>
            </span>
            <span className="text-[12px] font-medium text-foreground/80">{verdict(review.total)}</span>
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <span data-testid="review-source" className="rounded-md border border-border px-1.5 py-0.5 font-mono font-semibold text-foreground/85">
              {reviewSourceLabel(review.source)}
            </span>
            {pending && (
              <span className="inline-flex items-center gap-1">
                <IconSpinner className="h-3 w-3 animate-spin" aria-hidden="true" />
                Asking AI for comments
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((o) => !o)}
          className="flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:py-1"
        >
          {detailsOpen ? "Hide" : "Details"}
          <IconChevronRight className={`h-3 w-3 transition-transform ${detailsOpen ? "-rotate-90" : "rotate-90"}`} aria-hidden="true" />
        </button>
      </header>

      {detailsOpen && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
          <ul aria-label="Rubric" className="space-y-1.5">
            {review.lines.map((line) => (
              <li key={line.key} className="flex items-start gap-2.5">
                <span className="mt-[3px]">
                  <ScoreDots score={line.score} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2 text-[12px] font-semibold text-foreground">
                    {RUBRIC_LABELS[line.key]}
                    <span className="font-mono text-[10.5px] font-medium text-muted-foreground">{line.score}/2</span>
                  </span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{line.reason}</span>
                </span>
              </li>
            ))}
          </ul>

          <h3 className="mt-3 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Comments</h3>
          <ol aria-label="Review comments" className="mt-1.5 space-y-1">
            {review.comments.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={c.anchorId === null}
                  onClick={() => onSelectComment(c)}
                  aria-current={activeCommentId === c.id ? "true" : undefined}
                  className={`flex w-full items-start gap-2 rounded-xl px-1.5 py-1.5 text-left text-[12px] leading-snug text-foreground/90 transition-colors enabled:hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${
                    activeCommentId === c.id ? "bg-secondary" : ""
                  }`}
                >
                  {c.anchorId ? (
                    <PinBadge n={i + 1} active={activeCommentId === c.id} />
                  ) : (
                    <span className="mt-[2px] shrink-0 rounded-md border border-dashed border-muted-foreground/60 px-1 font-mono text-[9.5px] font-semibold uppercase text-muted-foreground">
                      Board
                    </span>
                  )}
                  <span className="min-w-0 flex-1">{c.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

interface PracticePinsProps {
  comments: ReviewComment[];
  elements: JevElement[];
  viewport: Viewport;
  activeCommentId: string | null;
  onSelectComment: (comment: ReviewComment) => void;
}

/** Numbered review pins on the anchored shapes, in screen space so they follow pan and zoom. Never board elements. */
export function PracticePins({ comments, elements, viewport, activeCommentId, onSelectComment }: PracticePinsProps) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const perAnchor = new Map<string, number>();
  return (
    <div aria-label="Review pins" className="pointer-events-none fixed inset-0 z-[15]">
      {comments.map((c, i) => {
        const el = c.anchorId ? byId.get(c.anchorId) : undefined;
        if (!el) return null;
        const stack = perAnchor.get(el.id) ?? 0;
        perAnchor.set(el.id, stack + 1);
        const x = (el.x + el.width) * viewport.zoom + viewport.x - PIN / 2 + stack * (PIN + 4);
        const y = el.y * viewport.zoom + viewport.y - PIN / 2;
        return (
          <button
            key={c.id}
            type="button"
            data-anchor-id={el.id}
            aria-label={`Review comment ${i + 1}: ${c.text}`}
            title={c.text}
            onClick={() => onSelectComment(c)}
            style={{ transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)` }}
            className="pointer-events-auto absolute left-0 top-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PinBadge n={i + 1} active={activeCommentId === c.id} />
          </button>
        );
      })}
    </div>
  );
}
