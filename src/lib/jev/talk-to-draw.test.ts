import { describe, expect, it } from "vitest";
import {
  applyTalkToDrawAction,
  buildTalkToDrawPrediction,
  correlateUtteranceToStroke,
  MAX_STROKE_TIMELINE,
  parseTalkToDrawUtterance,
  recordStrokeEnd,
  recordStrokeMove,
  recordStrokeStart,
  STROKE_CORRELATION_WINDOW_MS,
  validateTalkToDrawLlmResult,
  type StrokeTimelineEntry,
} from "@/lib/jev/talk-to-draw";
import type { JevElement } from "@/lib/jev/types";

function makeBaseBoard(): JevElement[] {
  const now = 1_710_000_000_000;
  return [
    {
      id: "el_api",
      kind: "node",
      x: 120,
      y: 220,
      width: 170,
      height: 72,
      label: "API Server",
      tone: "cobalt",
      seed: 11,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "arr_free",
      kind: "arrow",
      x: 290,
      y: 256,
      width: 180,
      height: 0,
      fromId: "el_api",
      fromPoint: { x: 290, y: 256 },
      toPoint: { x: 470, y: 256 },
      label: "",
      tone: "ink",
      seed: 12,
      arrowStyle: "curved",
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
  ];
}

describe("Chunk 5b: Talk-to-Draw — stroke timeline & synchronized voice-to-sketch", () => {
  it("maintains a bounded rolling stroke timeline and correlates active & recent strokes accurately", () => {
    let timeline: StrokeTimelineEntry[] = [];
    for (let i = 0; i < MAX_STROKE_TIMELINE + 6; i++) {
      timeline = recordStrokeStart(timeline, {
        strokeId: `st_${i}`,
        kind: "arrow",
        startPoint: { x: i * 10, y: 100 },
        endPoint: { x: i * 10 + 80, y: 100 },
        startedAt: 1000 + i * 100,
      });
      timeline = recordStrokeEnd(timeline, `st_${i}`, {
        elementId: `arr_${i}`,
        endPoint: { x: i * 10 + 120, y: 100 },
        endedAt: 1050 + i * 100,
      });
    }
    expect(timeline.length).toBeLessThanOrEqual(MAX_STROKE_TIMELINE);

    // Active in-progress stroke wins over completed strokes
    const tNow = 20_000;
    let activeTimeline = recordStrokeStart([], {
      strokeId: "st_done",
      kind: "node",
      startPoint: { x: 100, y: 100 },
      endPoint: { x: 260, y: 170 },
      startedAt: tNow - 2000,
    });
    activeTimeline = recordStrokeEnd(activeTimeline, "st_done", {
      elementId: "el_done",
      endPoint: { x: 260, y: 170 },
      endedAt: tNow - 1000,
    });
    activeTimeline = recordStrokeStart(activeTimeline, {
      strokeId: "st_live",
      kind: "arrow",
      startPoint: { x: 260, y: 135 },
      endPoint: { x: 350, y: 135 },
      startedAt: tNow - 300,
    });
    activeTimeline = recordStrokeMove(activeTimeline, "st_live", {
      x: 420,
      y: 135,
    });

    const liveHit = correlateUtteranceToStroke(activeTimeline, tNow);
    expect(liveHit?.strokeId).toBe("st_live");
    expect(liveHit?.endPoint).toEqual({ x: 420, y: 135 });

    // Recently completed stroke within 6s window correlates
    const doneTimeline = recordStrokeEnd(activeTimeline, "st_live", {
      elementId: "arr_live",
      endPoint: { x: 440, y: 135 },
      endedAt: tNow,
    });
    const recentHit = correlateUtteranceToStroke(
      doneTimeline,
      tNow + STROKE_CORRELATION_WINDOW_MS - 500
    );
    expect(recentHit?.elementId).toBe("arr_live");

    // Stale stroke past window does NOT correlate
    const staleHit = correlateUtteranceToStroke(
      doneTimeline,
      tNow + STROKE_CORRELATION_WINDOW_MS + 2000
    );
    expect(staleHit).toBeNull();
  });

  it('handles arrow + "this caches the reads" -> labels arrow "caches reads" and ghosts Cache node at arrow head', () => {
    const board = makeBaseBoard();
    const stroke: StrokeTimelineEntry = {
      strokeId: "st_1",
      elementId: "arr_free",
      kind: "arrow",
      fromId: "el_api",
      startPoint: { x: 290, y: 256 },
      endPoint: { x: 470, y: 256 },
      startedAt: 1000,
      endedAt: 1800,
      inProgress: false,
    };

    const result = buildTalkToDrawPrediction({
      utterance: "this caches the reads",
      activeStroke: stroke,
      elements: board,
      now: 2200,
    });

    expect(result).not.toBeNull();
    expect(result!.isHeuristic).toBe(true);
    expect(result!.strokeLabel.toLowerCase()).toBe("caches reads");

    // Patches the arrow label and wires arrow to the ghost Cache node
    const arrowPatch = result!.action.patchElements?.find(
      (p) => p.id === "arr_free"
    );
    expect(arrowPatch).toBeDefined();
    expect(arrowPatch!.label?.toLowerCase()).toBe("caches reads");

    const ghostCache = result!.action.addElements.find(
      (e) => e.kind === "database"
    );
    expect(ghostCache).toBeDefined();
    expect(ghostCache!.label).toMatch(/cache|redis/i);
    expect(arrowPatch!.toId).toBe(ghostCache!.id);
    // Positioned cleanly near the arrow's head
    expect(Math.abs(ghostCache!.x - 470)).toBeLessThan(120);

    // Accepting commits both arrow label + new Cache node in one atomic step
    const nextBoard = applyTalkToDrawAction(board, result!.action, 2300);
    const committedArrow = nextBoard.find((e) => e.id === "arr_free")!;
    expect(committedArrow.label.toLowerCase()).toBe("caches reads");
    expect(committedArrow.toId).toBe(ghostCache!.id);
    expect(nextBoard.some((e) => e.id === ghostCache!.id)).toBe(true);
  });

  it('handles arrow + "sends events to Kafka queue" -> labels arrow "sends events" and ghosts Kafka Queue node', () => {
    const board = makeBaseBoard();
    const stroke: StrokeTimelineEntry = {
      strokeId: "st_2",
      elementId: "arr_free",
      kind: "arrow",
      fromId: "el_api",
      startPoint: { x: 290, y: 256 },
      endPoint: { x: 470, y: 256 },
      startedAt: 1000,
      endedAt: 1600,
      inProgress: false,
    };

    const result = buildTalkToDrawPrediction({
      utterance: "sends events to Kafka queue",
      activeStroke: stroke,
      elements: board,
      now: 2000,
    });

    expect(result).not.toBeNull();
    expect(result!.strokeLabel.toLowerCase()).toBe("sends events");
    const ghostQueue = result!.action.addElements.find((e) => e.kind === "node");
    expect(ghostQueue).toBeDefined();
    expect(ghostQueue!.label).toMatch(/kafka/i);
    expect(ghostQueue!.tone).toBe("ochre");

    const arrowPatch = result!.action.patchElements?.find(
      (p) => p.id === "arr_free"
    );
    expect(arrowPatch?.label?.toLowerCase()).toBe("sends events");
    expect(arrowPatch?.toId).toBe(ghostQueue!.id);
  });

  it('handles box + "validates JWT auth then hits Postgres" -> labels active box and ghosts connected Postgres node', () => {
    const now = 1_710_000_000_000;
    const box: JevElement = {
      id: "el_box_1",
      kind: "node",
      x: 200,
      y: 220,
      width: 172,
      height: 72,
      label: "Service",
      tone: "cobalt",
      seed: 21,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    const stroke: StrokeTimelineEntry = {
      strokeId: "st_3",
      elementId: "el_box_1",
      kind: "node",
      startPoint: { x: 200, y: 220 },
      endPoint: { x: 372, y: 292 },
      startedAt: 1000,
      endedAt: 1500,
      inProgress: false,
    };

    const result = buildTalkToDrawPrediction({
      utterance: "validates JWT auth then hits Postgres",
      activeStroke: stroke,
      elements: [box],
      now: 2000,
    });

    expect(result).not.toBeNull();
    const boxPatch = result!.action.patchElements?.find(
      (p) => p.id === "el_box_1"
    );
    expect(boxPatch).toBeDefined();
    expect(boxPatch!.label).toMatch(/jwt|auth/i);

    const dbNode = result!.action.addElements.find((e) => e.kind === "database");
    expect(dbNode).toBeDefined();
    expect(dbNode!.label).toMatch(/postgres/i);

    const connArrow = result!.action.addElements.find((e) => e.kind === "arrow");
    expect(connArrow).toBeDefined();
    expect(connArrow!.fromId).toBe("el_box_1");
    expect(connArrow!.toId).toBe(dbNode!.id);
  });

  it('handles shape + "API Gateway" or "rate limiter" -> labels shape cleanly and ghosts a natural next step', () => {
    const now = 1_710_000_000_000;
    const shape: JevElement = {
      id: "el_box_2",
      kind: "node",
      x: 160,
      y: 200,
      width: 172,
      height: 72,
      label: "Service",
      tone: "cobalt",
      seed: 31,
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    const stroke: StrokeTimelineEntry = {
      strokeId: "st_4",
      elementId: "el_box_2",
      kind: "node",
      startPoint: { x: 160, y: 200 },
      endPoint: { x: 332, y: 272 },
      startedAt: 1000,
      endedAt: 1400,
      inProgress: false,
    };

    const gwRes = buildTalkToDrawPrediction({
      utterance: "API Gateway",
      activeStroke: stroke,
      elements: [shape],
      now: 1800,
    });
    expect(gwRes).not.toBeNull();
    expect(
      gwRes!.action.patchElements?.find((p) => p.id === "el_box_2")?.label
    ).toBe("API Gateway");

    const rlRes = buildTalkToDrawPrediction({
      utterance: "rate limiter",
      activeStroke: stroke,
      elements: [shape],
      now: 1900,
    });
    expect(rlRes).not.toBeNull();
    expect(
      rlRes!.action.patchElements?.find((p) => p.id === "el_box_2")?.label
    ).toBe("Rate Limiter");
  });

  it("replaces auto-spawned 'New Step' placeholder node cleanly when speaking after drawing an arrow to open space", () => {
    const now = 1_710_000_000_000;
    const board: JevElement[] = [
      {
        id: "el_api",
        kind: "node",
        x: 120,
        y: 220,
        width: 170,
        height: 72,
        label: "API Server",
        tone: "cobalt",
        seed: 41,
        createdAt: now,
        updatedAt: now,
        rev: 1,
      },
      {
        id: "el_placeholder",
        kind: "node",
        x: 420,
        y: 220,
        width: 168,
        height: 72,
        label: "New Step",
        tone: "cobalt",
        seed: 42,
        createdAt: now,
        updatedAt: now,
        rev: 1,
      },
      {
        id: "arr_spawned",
        kind: "arrow",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId: "el_api",
        toId: "el_placeholder",
        label: "",
        tone: "ink",
        seed: 43,
        arrowStyle: "curved",
        createdAt: now,
        updatedAt: now,
        rev: 1,
      },
    ];
    const stroke: StrokeTimelineEntry = {
      strokeId: "st_5",
      elementId: "arr_spawned",
      kind: "arrow",
      fromId: "el_api",
      toId: "el_placeholder",
      startPoint: { x: 290, y: 256 },
      endPoint: { x: 504, y: 256 },
      startedAt: 1000,
      endedAt: 1500,
      inProgress: false,
    };

    const res = buildTalkToDrawPrediction({
      utterance: "this caches the reads",
      activeStroke: stroke,
      elements: board,
      now: 1800,
    });
    expect(res).not.toBeNull();
    const nextBoard = applyTalkToDrawAction(board, res!.action, 1900);
    // Placeholder "New Step" is removed or upgraded cleanly (no leftover "New Step"!)
    expect(nextBoard.some((e) => e.label === "New Step")).toBe(false);
    expect(nextBoard.some((e) => /cache|redis/i.test(e.label))).toBe(true);
    expect(
      nextBoard.find((e) => e.id === "arr_spawned")?.label.toLowerCase()
    ).toBe("caches reads");
  });

  it("validates LLM talk-to-draw structured JSON and rejects unsafe or malformed payloads", () => {
    const valid = validateTalkToDrawLlmResult({
      strokeLabel: "caches reads",
      summary: "Cache reads in Redis",
      targetNodes: [
        { label: "Redis Cache", kind: "database", tone: "teal" },
      ],
    });
    expect(valid.ok).toBe(true);

    const poisoned = JSON.parse(
      '{"__proto__":{"x":1},"strokeLabel":"bad","targetNodes":[]}'
    );
    expect(validateTalkToDrawLlmResult(poisoned).ok).toBe(false);
    expect(validateTalkToDrawLlmResult({ strokeLabel: "", targetNodes: "nope" }).ok).toBe(
      false
    );

    const parsed = parseTalkToDrawUtterance("this caches the reads", "arrow");
    expect(parsed.strokeLabel.toLowerCase()).toBe("caches reads");
    expect(parsed.targetNodes.length).toBeGreaterThanOrEqual(1);
  });
});
