import { describe, expect, it } from "vitest";
import { PRACTICE_PROMPTS, PRACTICE_PROMPT_IDS, getPracticePrompt } from "@/lib/jev/practice-prompts";

describe("practice prompts", () => {
  it("has the six classic problems under the ids the starter boards share", () => {
    expect([...PRACTICE_PROMPT_IDS]).toEqual(["url-shortener", "chat", "feed", "rate-limiter", "payments", "notifications"]);
    expect(PRACTICE_PROMPTS.map((p) => p.id)).toEqual([...PRACTICE_PROMPT_IDS]);
  });

  it.each(PRACTICE_PROMPTS)("$id has a brief, requirements to elicit, a 35 or 45 minute slot and review hints", (p) => {
    expect(p.title.length).toBeGreaterThan(2);
    expect(p.brief.length).toBeGreaterThan(30);
    expect(p.functional.length).toBeGreaterThanOrEqual(2);
    expect(p.nonFunctional.length).toBeGreaterThanOrEqual(2);
    expect([35, 45]).toContain(p.minutes);
    const [lo, hi] = p.qpsRange;
    expect(lo).toBeGreaterThan(0);
    expect(hi / lo).toBeGreaterThanOrEqual(100);
    expect(p.bottleneck.words.length).toBeGreaterThan(0);
    for (const hint of [p.dataModelHint, p.tradeoffHint, p.bottleneck.question, p.followUp]) {
      expect(hint.length).toBeGreaterThan(10);
    }
  });

  it("looks prompts up by id and rejects unknown ids", () => {
    expect(getPracticePrompt("chat")?.title).toBe("Chat");
    expect(getPracticePrompt("nope")).toBeNull();
  });
});
