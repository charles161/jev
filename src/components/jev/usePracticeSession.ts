"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postDecide } from "@/lib/jev/ai-quiet";
import { getPracticePrompt, type PracticePromptId } from "@/lib/jev/practice-prompts";
import { MAX_COMMENT_CHARS, mergeAiComments, reviewPracticeBoard } from "@/lib/jev/practice-review";
import {
  endPracticeClock,
  isTimeUp,
  pausePractice,
  practiceStorageKey,
  resumePractice,
  startPracticeSession,
  type PracticeSession,
} from "@/lib/jev/practice-session";
import { serializeBoardToGraph } from "@/lib/jev/semantic-graph";
import type { JevElement } from "@/lib/jev/types";

const TICK_MS = 500;

/** Practice session for one room: clock, persistence, and Review (rules first, AI comments when the gateway answers). */
export function usePracticeSession(
  roomId: string,
  getBoard: () => { elements: JevElement[]; boardTitle: string },
  onReviewStart: () => void
) {
  const [practice, setPractice] = useState<PracticeSession | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reviewPending, setReviewPending] = useState(false);
  const practiceRef = useRef<PracticeSession | null>(null);
  const getBoardRef = useRef(getBoard);
  const onReviewStartRef = useRef(onReviewStart);
  const reviewSeq = useRef(0);

  useEffect(() => {
    practiceRef.current = practice;
    getBoardRef.current = getBoard;
    onReviewStartRef.current = onReviewStart;
  });

  useEffect(() => {
    if (!roomId) return;
    try {
      const key = practiceStorageKey(roomId);
      if (practice) window.localStorage.setItem(key, JSON.stringify(practice));
      else window.localStorage.removeItem(key);
    } catch {
      // storage unavailable: the session still runs for this tab
    }
  }, [roomId, practice]);

  const review = useCallback(async () => {
    const current = practiceRef.current;
    const prompt = current ? getPracticePrompt(current.promptId) : null;
    if (!current || !prompt) return;
    onReviewStartRef.current();
    const { elements, boardTitle } = getBoardRef.current();
    const rules = reviewPracticeBoard(elements, prompt);
    const t = Date.now();
    setNow(t);
    setPractice((p) => (p ? { ...endPracticeClock(p, t), review: rules } : p));
    const token = ++reviewSeq.current;
    setReviewPending(true);
    try {
      const res = await postDecide(
        {
          mode: "practice_review",
          promptId: prompt.id,
          boardGraph: serializeBoardToGraph(elements, { boardTitle }),
          rubric: rules.lines.map((l) => ({ key: l.key, score: l.score, reason: l.reason.slice(0, 200) })),
          comments: rules.comments.map((c) => ({ anchorId: c.anchorId, text: c.text.slice(0, MAX_COMMENT_CHARS) })),
        },
        { aiQuiet: true }
      );
      const data = res?.ok ? ((await res.json()) as { source?: string; comments?: unknown }) : null;
      const merged = data?.source === "llm-json" ? mergeAiComments(rules, data.comments, elements) : null;
      if (merged && token === reviewSeq.current) {
        setPractice((p) => (p?.phase === "review" ? { ...p, review: merged } : p));
      }
    } catch {
      // network error: the rule-based review stays, labelled as such
    } finally {
      if (token === reviewSeq.current) setReviewPending(false);
    }
  }, []);

  const reviewRef = useRef(review);
  useEffect(() => {
    reviewRef.current = review;
  });

  useEffect(() => {
    if (!practice || practice.phase !== "drawing" || practice.pausedAt !== null) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (practiceRef.current && isTimeUp(practiceRef.current, t)) void reviewRef.current();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [practice]);

  const start = useCallback((promptId: PracticePromptId) => {
    const t = Date.now();
    reviewSeq.current += 1;
    setReviewPending(false);
    setNow(t);
    setPractice(startPracticeSession(promptId, t));
  }, []);

  const pause = useCallback(() => setPractice((p) => (p ? pausePractice(p, Date.now()) : p)), []);

  const resume = useCallback(() => {
    const t = Date.now();
    setNow(t);
    setPractice((p) => (p ? resumePractice(p, t) : p));
  }, []);

  const exit = useCallback(() => {
    reviewSeq.current += 1;
    setReviewPending(false);
    setPractice(null);
  }, []);

  const restore = useCallback((session: PracticeSession | null) => {
    setNow(Date.now());
    setPractice(session);
  }, []);

  return { practice, now, reviewPending, start, pause, resume, review, exit, restore };
}
