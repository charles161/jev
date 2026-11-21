import { describe, expect, it } from "vitest";
import { getPracticePrompt, type PracticePrompt } from "@/lib/jev/practice-prompts";
import { reviewPracticeBoard } from "@/lib/jev/practice-review";
import {
  endPracticeClock,
  formatClock,
  isTimeUp,
  parsePracticeSession,
  pausePractice,
  practiceStorageKey,
  remainingMs,
  resumePractice,
  startPracticeSession,
} from "@/lib/jev/practice-session";

const MIN = 60_000;

describe("practice session clock", () => {
  it("starts with the prompt's suggested duration and counts down", () => {
    const s = startPracticeSession("url-shortener", 1_000);
    expect(s.durationMs).toBe(35 * MIN);
    expect(s.phase).toBe("drawing");
    expect(remainingMs(s, 1_000)).toBe(35 * MIN);
    expect(remainingMs(s, 1_000 + 5 * MIN)).toBe(30 * MIN);
    expect(startPracticeSession("chat", 0).durationMs).toBe(45 * MIN);
  });

  it("pause freezes the clock and resume does not count the paused time", () => {
    let s = startPracticeSession("url-shortener", 0);
    s = pausePractice(s, 2 * MIN);
    expect(remainingMs(s, 20 * MIN)).toBe(33 * MIN);
    s = resumePractice(s, 20 * MIN);
    expect(remainingMs(s, 21 * MIN)).toBe(32 * MIN);
    expect(pausePractice(pausePractice(s, 22 * MIN), 30 * MIN)).toEqual(pausePractice(s, 22 * MIN));
  });

  it("is up at zero, never goes negative, and the review phase freezes it", () => {
    const s = startPracticeSession("url-shortener", 0);
    expect(isTimeUp(s, 35 * MIN)).toBe(true);
    expect(remainingMs(s, 99 * MIN)).toBe(0);
    const ended = endPracticeClock(s, 10 * MIN);
    expect(ended.phase).toBe("review");
    expect(remainingMs(ended, 30 * MIN)).toBe(25 * MIN);
    expect(isTimeUp(ended, 99 * MIN)).toBe(false);
  });

  it("formats mm:ss", () => {
    expect(formatClock(35 * MIN)).toBe("35:00");
    expect(formatClock(61_500)).toBe("01:02");
    expect(formatClock(0)).toBe("00:00");
  });
});

describe("practice session storage", () => {
  it("keys per room", () => {
    expect(practiceStorageKey("r1")).toBe("jev_practice_r1");
  });

  it("round-trips a session with its review and rejects junk", () => {
    const prompt = getPracticePrompt("feed") as PracticePrompt;
    const s = { ...endPracticeClock(startPracticeSession("feed", 0), MIN), review: reviewPracticeBoard([], prompt) };
    expect(parsePracticeSession(JSON.stringify(s))).toEqual(s);
    expect(parsePracticeSession("not json")).toBeNull();
    expect(parsePracticeSession(JSON.stringify({ ...s, promptId: "tiktok" }))).toBeNull();
    expect(parsePracticeSession(JSON.stringify({ ...s, durationMs: -5 }))).toBeNull();
    expect(parsePracticeSession(null)).toBeNull();
  });
});
