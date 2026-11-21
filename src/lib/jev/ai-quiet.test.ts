// Sensei feedback 21 Nov 2026: in practice mode the learner draws first and the AI stays silent until Review.
// Every client call to /api/jev/decide goes through postDecide, which refuses AI modes while aiQuiet is on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_QUIET_ALLOWED_MODES, DECIDE_MODES, postDecide } from "@/lib/jev/ai-quiet";

describe("postDecide: the one client path to /api/jev/decide", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("only the practice review may run while the AI is quiet", () => {
    expect([...AI_QUIET_ALLOWED_MODES]).toEqual(["practice_review"]);
  });

  it.each(DECIDE_MODES.filter((m) => m !== "practice_review"))("%s is refused without a network call when quiet", async (mode) => {
    expect(await postDecide({ mode }, { aiQuiet: true })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([...DECIDE_MODES])("%s posts JSON to the decide route when the AI is not quiet", async (mode) => {
    const signal = new AbortController().signal;
    const res = await postDecide({ mode, extra: 1 }, { aiQuiet: false, signal });
    expect(res?.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/jev/decide");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(JSON.parse(String(init.body))).toEqual({ mode, extra: 1 });
  });

  it("the practice review still runs when quiet", async () => {
    expect(await postDecide({ mode: "practice_review" }, { aiQuiet: true })).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
