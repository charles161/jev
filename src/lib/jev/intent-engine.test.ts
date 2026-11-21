import { describe, expect, it } from "vitest";
import { detectCreationIntent, detectMoveIntent } from "@/lib/jev/intent-engine";
import type { JevElement } from "@/lib/jev/types";

function makeEl(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: overrides.id ?? "el_1",
    kind: overrides.kind ?? "node",
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 160,
    height: overrides.height ?? 72,
    label: overrides.label ?? "Service",
    tone: overrides.tone ?? "cobalt",
    seed: overrides.seed ?? 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeArrow(id: string, fromId: string, toId: string): JevElement {
  return makeEl({
    id,
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "",
    fromId,
    toId,
  });
}

describe("intent-engine (detectMoveIntent & detectCreationIntent)", () => {
  it("detects splice_into_edge when a node is dropped onto an existing arrow between two other nodes", () => {
    const a = makeEl({ id: "a", x: 0, y: 100, label: "Client" });
    const b = makeEl({ id: "b", x: 500, y: 100, label: "Postgres" });
    const edge = makeArrow("e1", "a", "b");
    const moved = makeEl({ id: "c", x: 250, y: 105, label: "Cache" });

    const intent = detectMoveIntent(
      moved,
      { x: 250, y: 300, width: 160, height: 72 },
      [a, b, edge, moved]
    );
    expect(intent.kind).toBe("splice_into_edge");
    expect(intent.subjectId).toBe("c");
    expect(intent.relatedIds).toEqual(["e1", "a", "b"]);
    expect(intent.headline).toContain("Cache");
  });

  it("does not detect splice_into_edge for frames or arrows connected to the moved node itself", () => {
    const a = makeEl({ id: "a", x: 0, y: 100, label: "Client" });
    const b = makeEl({ id: "b", x: 500, y: 100, label: "Postgres" });
    const edge = makeArrow("e1", "a", "b");
    const frame = makeEl({
      id: "f1",
      kind: "frame",
      x: 200,
      y: 80,
      width: 200,
      height: 120,
      label: "Zone",
    });

    const intent = detectMoveIntent(
      frame,
      { x: 200, y: 300, width: 200, height: 120 },
      [a, b, edge, frame]
    );
    expect(intent.kind).not.toBe("splice_into_edge");
  });

  it("detects open_pipeline_gap when a connected node is pulled far away from its peer", () => {
    const a = makeEl({ id: "a", x: 0, y: 100, label: "API" });
    const b = makeEl({ id: "b", x: 520, y: 100, label: "Postgres" });
    const edge = makeArrow("e1", "a", "b");

    const intent = detectMoveIntent(
      b,
      { x: 240, y: 100, width: 160, height: 72 },
      [a, b, edge]
    );
    expect(intent.kind).toBe("open_pipeline_gap");
    expect(intent.relatedIds).toEqual(["a", "e1"]);
    expect(intent.detail).toContain("gap widened");
  });

  it("detects encapsulate_group when moving into a frame and branch_out when extracting from a frame", () => {
    const frame = makeEl({
      id: "frm",
      kind: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      label: "Core",
    });
    const insideNode = makeEl({ id: "n1", x: 100, y: 100, label: "Worker" });
    const outsideBox = { x: 600, y: 100, width: 160, height: 72 };

    const entered = detectMoveIntent(insideNode, outsideBox, [frame, insideNode]);
    expect(entered.kind).toBe("encapsulate_group");
    expect(entered.relatedIds).toEqual(["frm"]);

    const extractedNode = makeEl({ id: "n1", x: 600, y: 100, label: "Worker" });
    const insideBox = { x: 100, y: 100, width: 160, height: 72 };
    const exited = detectMoveIntent(extractedNode, insideBox, [
      frame,
      extractedNode,
    ]);
    expect(exited.kind).toBe("branch_out");
    expect(exited.relatedIds).toEqual(["frm"]);
  });

  it("detects off-axis vertical branch_out, horizontal align_pipeline, vertical align_column, connect_nearby, and domain_continue", () => {
    const anchor = makeEl({ id: "a", x: 100, y: 100, label: "Gateway" });

    // Off-axis vertical drag with no horizontal peers -> branch_out
    const branched = makeEl({ id: "b", x: 220, y: 320, label: "Billing" });
    const branchIntent = detectMoveIntent(
      branched,
      { x: 210, y: 110, width: 160, height: 72 },
      [anchor, branched]
    );
    expect(branchIntent.kind).toBe("branch_out");
    expect(branchIntent.relatedIds).toEqual(["a"]);

    // Aligned horizontally with anchor -> align_pipeline
    const rowPeer = makeEl({ id: "r", x: 380, y: 106, label: "Auth" });
    const rowIntent = detectMoveIntent(
      rowPeer,
      { x: 260, y: 100, width: 160, height: 72 },
      [anchor, rowPeer]
    );
    expect(rowIntent.kind).toBe("align_pipeline");
    expect(rowIntent.relatedIds).toContain("a");

    // Aligned vertically with anchor (small vertical nudge) -> align_column
    const colPeer = makeEl({ id: "c", x: 108, y: 260, label: "Cache" });
    const colIntent = detectMoveIntent(
      colPeer,
      { x: 180, y: 260, width: 160, height: 72 },
      [anchor, colPeer]
    );
    expect(colIntent.kind).toBe("align_column");
    expect(colIntent.relatedIds).toContain("a");

    // Near unconnected neighbor without row/column alignment -> connect_nearby
    const nearby = makeEl({ id: "n", x: 260, y: 240, label: "Metrics" });
    const nearbyIntent = detectMoveIntent(
      nearby,
      { x: 250, y: 235, width: 160, height: 72 },
      [anchor, nearby]
    );
    expect(nearbyIntent.kind).toBe("connect_nearby");
    expect(nearbyIntent.relatedIds).toEqual(["a"]);

    // Far away isolated node -> domain_continue
    const far = makeEl({ id: "f", x: 1200, y: 1200, label: "Isolated" });
    const farIntent = detectMoveIntent(
      far,
      { x: 1198, y: 1199, width: 160, height: 72 },
      [anchor, far]
    );
    expect(farIntent.kind).toBe("domain_continue");
    expect(farIntent.relatedIds).toEqual([]);
  });

  it("detects creation intents for decisions, prompts, and standard elements", () => {
    const diamond = makeEl({ id: "d1", kind: "diamond", label: "Route" });
    expect(detectCreationIntent(diamond, [diamond]).kind).toBe("decision_branch");

    const questionNode = makeEl({ id: "q1", kind: "node", label: "Cache Hit?" });
    expect(detectCreationIntent(questionNode, [questionNode]).kind).toBe(
      "decision_branch"
    );

    const promptNode = makeEl({ id: "p1", kind: "node", label: "Gateway" });
    const promptIntent = detectCreationIntent(promptNode, [promptNode], true);
    expect(promptIntent.kind).toBe("prompt_follow_up");
    expect(promptIntent.relatedIds).toEqual(["p1"]);

    const manualNode = makeEl({ id: "m1", kind: "node", label: "" });
    const manualIntent = detectCreationIntent(manualNode, [manualNode], false);
    expect(manualIntent.kind).toBe("domain_continue");
    expect(manualIntent.headline).toContain("Untitled");
  });
});

describe("intent-engine: zones behave like frames", () => {
  it("dragging a zone over an arrow is not a splice, and a node dropped into a zone is grouped", () => {
    const a = makeEl({ id: "a", x: 0, y: 100, label: "Client" });
    const b = makeEl({ id: "b", x: 500, y: 100, label: "Postgres" });
    const edge = makeArrow("e1", "a", "b");
    const zone = makeEl({ id: "z1", kind: "zone", x: 200, y: 80, width: 200, height: 120, label: "VPC" });
    const spliced = detectMoveIntent(zone, { x: 200, y: 300, width: 200, height: 120 }, [a, b, edge, zone]);
    expect(spliced.kind).not.toBe("splice_into_edge");

    const region = makeEl({ id: "z2", kind: "zone", x: 0, y: 0, width: 400, height: 300, label: "Region" });
    const node = makeEl({ id: "n1", x: 100, y: 100, label: "Worker" });
    const entered = detectMoveIntent(node, { x: 600, y: 100, width: 160, height: 72 }, [region, node]);
    expect(entered.kind).toBe("encapsulate_group");
    expect(entered.relatedIds).toEqual(["z2"]);
  });
});
