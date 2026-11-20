import { describe, expect, it } from "vitest";
import { computeBounds, rectsOverlap } from "@/lib/jev/geometry";
import {
  buildPlacementPlan,
  createAutoConnectArrow,
  extractFlowLabels,
  positionElementsAtTopLeft,
} from "@/lib/jev/placement-engine";
import type { JevElement } from "@/lib/jev/types";

function makeNode(
  id: string,
  label: string,
  x: number,
  y: number,
  overrides: Partial<JevElement> = {}
): JevElement {
  return {
    id,
    kind: overrides.kind ?? "node",
    x,
    y,
    width: overrides.width ?? 160,
    height: overrides.height ?? 72,
    label,
    tone: overrides.tone ?? "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("placement-engine", () => {
  const viewport = { x: 0, y: 0, width: 1200, height: 800 };

  it("extractFlowLabels excludes arrows, frames, and blank labels and sorts left-to-right", () => {
    const els: JevElement[] = [
      makeNode("b", "Server", 300, 100),
      makeNode("a", "App", 100, 100),
      makeNode("f", "Zone", 0, 0, { kind: "frame" }),
      makeNode("empty", "   ", 50, 50),
      createAutoConnectArrow("a", "b", "arr_1"),
    ];
    expect(extractFlowLabels(els)).toEqual(["App", "Server"]);
  });

  it("positionElementsAtTopLeft translates shapes, freedraw points, and unbound arrows accurately", () => {
    const node = makeNode("n1", "API", 200, 300);
    const stroke = makeNode("s1", "", 200, 300, {
      kind: "freedraw",
      points: [
        { x: 200, y: 300 },
        { x: 260, y: 340 },
      ],
    });
    const freeArrow = makeNode("a1", "", 0, 0, {
      kind: "arrow",
      fromPoint: { x: 200, y: 320 },
      toPoint: { x: 360, y: 320 },
    });

    const moved = positionElementsAtTopLeft([node, stroke, freeArrow], {
      x: 50,
      y: 80,
    });
    const bounds = computeBounds(moved)!;
    expect(bounds.x).toBe(50);
    expect(bounds.y).toBe(80);

    const movedStroke = moved.find((e) => e.id === "s1")!;
    expect(movedStroke.points).toEqual([
      { x: 50, y: 80 },
      { x: 110, y: 120 },
    ]);
    const movedArrow = moved.find((e) => e.id === "a1")!;
    expect(movedArrow.fromPoint).toEqual({ x: 50, y: 100 });
    expect(movedArrow.toPoint).toEqual({ x: 210, y: 100 });

    // No-op when already at target or empty
    expect(positionElementsAtTopLeft([], { x: 10, y: 10 })).toEqual([]);
    expect(positionElementsAtTopLeft(moved, { x: 50, y: 80 })).toBe(moved);
  });

  it("places on viewport_center when canvas is empty and flags single-component prompts", () => {
    const gen = [makeNode("g1", "App", 0, 0)];
    const plan = buildPlacementPlan({
      prompt: "app",
      generatedElements: gen,
      existingElements: [],
      viewportWorld: viewport,
      lastPromptFlow: null,
      selectedIds: [],
    });

    expect(plan.defaultSlotId).toBe("viewport_center");
    expect(plan.isSingleComponent).toBe(true);
    expect(plan.connectTargets).toEqual([]);
    expect(plan.defaultConnectTargetId).toBeNull();
    expect(plan.stateSummary).toContain("Adding a SINGLE component");
  });

  it("plans single-component auto-connect spacing and downstream fan-out columns", () => {
    const app = makeNode("app", "App", 100, 200, { kind: "ellipse" });
    const server = makeNode("srv", "Server", 0, 0);

    // First child from focused App -> spaced 128px to the right, vertically aligned
    const firstPlan = buildPlacementPlan({
      prompt: "server",
      generatedElements: [server],
      existingElements: [app],
      viewportWorld: viewport,
      lastPromptFlow: null,
      selectedIds: ["app"],
    });

    expect(firstPlan.isSingleComponent).toBe(true);
    expect(firstPlan.defaultConnectTargetId).toBe("app");
    const appTarget = firstPlan.connectTargets.find((t) => t.id === "app")!;
    expect(appTarget.topLeft.x).toBe(100 + 160 + 128);
    expect(appTarget.topLeft.y).toBe(200);

    // Second child from App (which already connects to Server) -> fans 96px below Server in same column
    const placedServer = makeNode("srv_placed", "Server", 388, 200);
    const arrow = createAutoConnectArrow("app", "srv_placed", "arr_app_srv");
    const worker = makeNode("wrk", "Worker", 0, 0);

    const fanPlan = buildPlacementPlan({
      prompt: "worker",
      generatedElements: [worker],
      existingElements: [app, placedServer, arrow],
      viewportWorld: viewport,
      lastPromptFlow: null,
      selectedIds: ["app"],
    });

    expect(fanPlan.defaultConnectTargetId).toBe("app");
    const fanTarget = fanPlan.connectTargets.find((t) => t.id === "app")!;
    expect(fanTarget.topLeft.x).toBe(388);
    expect(fanTarget.topLeft.y).toBe(200 + 72 + 96);
  });

  it("prefers standalone placement for an unfocused fresh entry node like 'User'", () => {
    const db = makeNode("db", "Postgres", 300, 200, { kind: "database" });
    const user = makeNode("u", "User", 0, 0, { kind: "ellipse" });

    const plan = buildPlacementPlan({
      prompt: "user",
      generatedElements: [user],
      existingElements: [db],
      viewportWorld: viewport,
      lastPromptFlow: null,
      selectedIds: [],
    });

    expect(plan.defaultConnectTargetId).toBe("none");
  });

  it("stacks sequential flows below_previous on shared labels and right_of_previous on tail continuation", () => {
    const prevA = makeNode("p1", "App", 100, 100);
    const prevB = makeNode("p2", "Server", 350, 100);
    const prevArrow = createAutoConnectArrow("p1", "p2", "pa1");
    const existing = [prevA, prevB, prevArrow];
    const lastPromptFlow = {
      bounds: computeBounds(existing)!,
      labels: ["App", "Server"],
      prompt: "app -> server",
      elementIds: ["p1", "p2", "pa1"],
    };

    // Iteration starting with same first label ("App") -> below_previous dominates
    const iterGen = [
      makeNode("i1", "App", 0, 0),
      makeNode("i2", "Gateway", 250, 0),
      makeNode("i3", "Server", 500, 0),
    ];
    const iterPlan = buildPlacementPlan({
      prompt: "app -> gateway -> server",
      generatedElements: iterGen,
      existingElements: existing,
      viewportWorld: viewport,
      lastPromptFlow,
      selectedIds: ["p2"],
    });

    expect(iterPlan.defaultSlotId).toBe("below_previous");
    expect(iterPlan.sharedLabels).toEqual(["App", "Server"]);
    // Selection inside lastPromptFlow should not produce duplicate *_selected candidates
    expect(
      iterPlan.candidates.some((c) => c.id === "below_selected")
    ).toBe(false);

    // Continuation starting from last node ("Server") -> right_of_previous dominates
    const contGen = [
      makeNode("c1", "Server", 0, 0),
      makeNode("c2", "Postgres", 250, 0),
    ];
    const contPlan = buildPlacementPlan({
      prompt: "server -> postgres",
      generatedElements: contGen,
      existingElements: existing,
      viewportWorld: viewport,
      lastPromptFlow,
      selectedIds: [],
    });

    expect(contPlan.continuesFromLastEnd).toBe(true);
    expect(contPlan.defaultSlotId).toBe("right_of_previous");
  });

  it("uses spiral open_viewport_pocket without colliding when viewport center is occupied and includes selection slots", () => {
    // Occupy the viewport center with an existing shape and a freedraw stroke
    const blocker = makeNode("blk", "Center Box", 480, 340, {
      width: 240,
      height: 120,
    });
    const stroke = makeNode("fd", "", 0, 0, {
      kind: "freedraw",
      points: [
        { x: 460, y: 500 },
        { x: 740, y: 560 },
      ],
    });
    const gen = [makeNode("g1", "API", 0, 0), makeNode("g2", "DB", 250, 0)];

    const plan = buildPlacementPlan({
      prompt: "api -> db",
      generatedElements: gen,
      existingElements: [blocker, stroke],
      viewportWorld: viewport,
      lastPromptFlow: null,
      selectedIds: ["blk"],
    });

    const pocket = plan.candidates.find((c) => c.id === "open_viewport_pocket");
    expect(pocket).toBeDefined();
    expect(plan.candidates.some((c) => c.id === "below_selected")).toBe(true);
    expect(plan.candidates.some((c) => c.id === "right_of_selected")).toBe(true);

    // Every candidate must avoid overlapping the center blocker
    const genSize = computeBounds(gen)!;
    for (const cand of plan.candidates) {
      const placedRect = {
        x: cand.topLeft.x,
        y: cand.topLeft.y,
        width: genSize.width,
        height: genSize.height,
      };
      expect(
        rectsOverlap(
          placedRect,
          { x: blocker.x, y: blocker.y, width: blocker.width, height: blocker.height },
          0
        )
      ).toBe(false);
    }
  });
});
