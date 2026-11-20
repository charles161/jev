import { describe, expect, it } from "vitest";
import { parsePromptToElements } from "@/lib/jev/diagram-parser";
import { computeBounds } from "@/lib/jev/geometry";
import type { JevElement } from "@/lib/jev/types";

function shapesOf(els: JevElement[]): JevElement[] {
  return els.filter((e) => e.kind !== "arrow" && e.kind !== "frame");
}

function arrowsOf(els: JevElement[]): JevElement[] {
  return els.filter((e) => e.kind === "arrow");
}

function framesOf(els: JevElement[]): JevElement[] {
  return els.filter((e) => e.kind === "frame");
}

describe("diagram-parser (parsePromptToElements)", () => {
  it("returns empty output for empty or whitespace-only prompts", () => {
    expect(parsePromptToElements("", [])).toEqual({ elements: [], summary: "" });
    expect(parsePromptToElements("   \n\t  ", [])).toEqual({
      elements: [],
      summary: "",
    });
  });

  it("parses arrow shorthand with branches, labeled edges, bidirectional arrows, and title frame", () => {
    const { elements, summary, focusId } = parsePromptToElements(
      "Auth Pipeline: User --HTTPS--> API Gateway -> [Yes: Dashboard, No: Retry] <-> Postgres",
      []
    );

    const shapes = shapesOf(elements);
    const arrows = arrowsOf(elements);
    const frames = framesOf(elements);

    expect(summary).toBe("Auth Pipeline");
    expect(frames).toHaveLength(1);
    expect(frames[0].label).toBe("Auth Pipeline");
    expect(shapes.map((s) => s.label)).toEqual([
      "User",
      "API Gateway",
      "Dashboard",
      "Retry",
      "Postgres",
    ]);

    // Every arrow references valid created node IDs
    const idSet = new Set(shapes.map((s) => s.id));
    for (const arr of arrows) {
      expect(idSet.has(arr.fromId!)).toBe(true);
      expect(idSet.has(arr.toId!)).toBe(true);
    }

    const httpsArrow = arrows.find((a) => a.label === "HTTPS");
    expect(httpsArrow).toBeDefined();

    const noArrow = arrows.find((a) => a.label === "No");
    expect(noArrow?.dashed).toBe(true);
    expect(noArrow?.tone).toBe("terracotta");

    const bidiArrows = arrows.filter((a) => a.bidirectional);
    expect(bidiArrows).toHaveLength(2);

    expect(focusId).toBe(shapes[shapes.length - 1].id);
  });

  it("parses hyphenated inline edge labels like --read-only--> and multi-hop labeled arrows cleanly", () => {
    const { elements } = parsePromptToElements(
      "Client --read-only--> API --write-through--> Postgres",
      []
    );
    const shapes = shapesOf(elements);
    const arrows = arrowsOf(elements);

    expect(shapes.map((s) => s.label)).toEqual(["Client", "API", "Postgres"]);
    expect(arrows).toHaveLength(2);
    expect(arrows.map((a) => a.label)).toEqual(["read-only", "write-through"]);
  });

  it("parses parenthesized edge labels, unicode arrows, multi-line flows, and deduplicates repeated edges", () => {
    const { elements } = parsePromptToElements(
      "Client → (gRPC) Service => DB;\nClient -> Service",
      []
    );
    const shapes = shapesOf(elements);
    const arrows = arrowsOf(elements);

    expect(shapes.map((s) => s.label)).toEqual(["Client", "Service", "DB"]);
    expect(arrows).toHaveLength(2);
    expect(arrows[0].label).toBe("gRPC");
    expect(shapes[2].kind).toBe("database");
  });

  it("keeps single-word components as a single node for rapid Enter chaining", () => {
    const { elements, summary } = parsePromptToElements("postgres", []);
    expect(elements).toHaveLength(1);
    expect(elements[0].kind).toBe("database");
    expect(elements[0].label).toBe("Postgres");
    expect(summary).toBe("Postgres");

    const authSingle = parsePromptToElements("auth", []);
    expect(authSingle.elements).toHaveLength(1);
    expect(authSingle.elements[0].label).toBe("Auth");
  });

  it("generates domain blueprints via natural language and explicit patternHint", () => {
    const comparison = parsePromptToElements("WebRTC P2P vs Central Server", []);
    expect(framesOf(comparison.elements)).toHaveLength(2);
    expect(shapesOf(comparison.elements)).toHaveLength(6);
    expect(comparison.summary).toBe("WebRTC P2P vs Central Server");

    const hintedAuth = parsePromptToElements("login", [], undefined, "auth_flow");
    expect(hintedAuth.summary).toBe("Authentication Flow");
    expect(shapesOf(hintedAuth.elements).some((e) => e.kind === "diamond")).toBe(
      true
    );

    const webrtc = parsePromptToElements("WebRTC P2P whiteboard", []);
    expect(webrtc.summary).toBe("WebRTC P2P Architecture");
    expect(framesOf(webrtc.elements)).toHaveLength(1);

    const rag = parsePromptToElements("AI agent RAG pipeline", []);
    expect(rag.summary).toBe("AI Agent / RAG Pipeline");

    const micro = parsePromptToElements("microservices backend", []);
    expect(micro.summary).toBe("Microservices Architecture");

    const cicd = parsePromptToElements("CI/CD deploy pipeline", []);
    expect(cicd.summary).toBe("CI/CD Release Pipeline");

    const funnel = parsePromptToElements("user onboarding funnel", []);
    expect(funnel.summary).toBe("User Onboarding Funnel");
  });

  it("extracts hub-and-spoke ('with') and sequential ('then') natural-language diagrams", () => {
    const hub = parsePromptToElements(
      "Order Hub with Payments, Inventory, and Postgres",
      []
    );
    const hubShapes = shapesOf(hub.elements);
    expect(hubShapes.map((s) => s.label)).toEqual([
      "Order Hub",
      "Payments",
      "Inventory",
      "Postgres",
    ]);
    expect(arrowsOf(hub.elements)).toHaveLength(3);

    const seq = parsePromptToElements("Ingest then Transform into Warehouse", []);
    expect(shapesOf(seq.elements).map((s) => s.label)).toEqual([
      "Ingest",
      "Transform",
      "Warehouse",
    ]);
    expect(arrowsOf(seq.elements)).toHaveLength(2);
  });

  it("centers generated diagrams at anchorCenter or below existing elements and handles degenerate syntax safely", () => {
    const anchored = parsePromptToElements("A -> B -> C", [], { x: 1000, y: 500 });
    const bounds = computeBounds(anchored.elements);
    expect(bounds).not.toBeNull();
    const cx = bounds!.x + bounds!.width / 2;
    const cy = bounds!.y + bounds!.height / 2;
    expect(Math.abs(cx - 1000)).toBeLessThanOrEqual(2);
    expect(Math.abs(cy - 500)).toBeLessThanOrEqual(2);

    // Without anchorCenter, places below existing elements
    const below = parsePromptToElements("D -> E", anchored.elements);
    const belowBounds = computeBounds(below.elements);
    expect(belowBounds!.y).toBeGreaterThan(bounds!.y + bounds!.height);

    // Malformed / punctuation-only prompts do not throw
    expect(() => parsePromptToElements("-> ->", [])).not.toThrow();
    expect(() => parsePromptToElements("[]", [])).not.toThrow();
    expect(() => parsePromptToElements("A -> A", [])).not.toThrow();
    // Self-loop edge is suppressed
    const selfLoop = parsePromptToElements("A -> A", []);
    expect(arrowsOf(selfLoop.elements)).toHaveLength(0);
  });
});
