import { describe, expect, it } from "vitest";
import {
  buildBoardSvgTree,
  computeExportBounds,
  escapeXml,
  exportBoardToSvg,
  sanitizeExportFilename,
  serializeSvgNode,
  wrapSvgText,
} from "@/lib/jev/svg-export";
import { createStarterElements } from "@/lib/jev/templates";
import type { ColorTone, ElementKind, JevElement } from "@/lib/jev/types";

function makeElement(
  kind: ElementKind,
  overrides: Partial<JevElement> = {}
): JevElement {
  return {
    id: overrides.id ?? `el_${kind}`,
    kind,
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    width: overrides.width ?? 160,
    height: overrides.height ?? 74,
    label: overrides.label ?? `Sample ${kind}`,
    tone: overrides.tone ?? "cobalt",
    seed: overrides.seed ?? 4242,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/**
 * Strict well-formedness validator for standalone XML/SVG documents.
 * Verifies XML prolog, balanced open/close tags, valid attribute quoting,
 * zero raw special characters in text/attributes, and zero invalid control chars.
 */
function assertWellFormedSvgXml(svg: string): void {
  // No XML 1.0 illegal control chars
  expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);

  let cursor = svg.trim();
  if (cursor.startsWith("<?xml")) {
    const prologEnd = cursor.indexOf("?>");
    expect(prologEnd).toBeGreaterThan(0);
    cursor = cursor.slice(prologEnd + 2).trim();
  }

  const stack: string[] = [];
  let rootCount = 0;
  let i = 0;

  while (i < cursor.length) {
    if (cursor[i] === "<") {
      const closeIdx = cursor.indexOf(">", i + 1);
      expect(closeIdx).toBeGreaterThan(i);
      const rawTag = cursor.slice(i + 1, closeIdx);
      expect(rawTag.length).toBeGreaterThan(0);
      expect(rawTag).not.toContain("<");

      if (rawTag.startsWith("/")) {
        const closingName = rawTag.slice(1).trim();
        expect(stack.length).toBeGreaterThan(0);
        const expected = stack.pop();
        expect(closingName).toBe(expected);
      } else {
        const selfClosing = rawTag.endsWith("/");
        const inner = (selfClosing ? rawTag.slice(0, -1) : rawTag).trim();
        const nameMatch = /^([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(inner);
        expect(nameMatch).not.toBeNull();
        const tagName = nameMatch![1];

        if (stack.length === 0) {
          rootCount += 1;
          expect(tagName).toBe("svg");
        }

        // Parse and validate every attribute in the tag
        let attrStr = inner.slice(tagName.length).trim();
        const seenAttrs = new Set<string>();
        while (attrStr.length > 0) {
          const attrMatch = /^([a-zA-Z][a-zA-Z0-9:_-]*)="([^"]*)"(?:\s+|$)/.exec(
            attrStr
          );
          expect(attrMatch).not.toBeNull();
          const [, attrName, attrVal] = attrMatch!;
          expect(seenAttrs.has(attrName)).toBe(false);
          expect(attrName.toLowerCase().startsWith("on")).toBe(false);
          expect(attrName.toLowerCase().startsWith("data-")).toBe(false);
          seenAttrs.add(attrName);
          // Validate no unescaped <, >, or raw & outside valid entities
          expect(attrVal).not.toContain("<");
          expect(attrVal).not.toContain(">");
          const strippedEntities = attrVal.replace(
            /&(amp|lt|gt|quot|apos|#39|#x[0-9a-fA-F]+|#[0-9]+);/g,
            ""
          );
          expect(strippedEntities).not.toContain("&");
          attrStr = attrStr.slice(attrMatch![0].length).trim();
        }

        if (!selfClosing) {
          stack.push(tagName);
        }
      }
      i = closeIdx + 1;
    } else {
      const nextTag = cursor.indexOf("<", i);
      const textChunk =
        nextTag === -1 ? cursor.slice(i) : cursor.slice(i, nextTag);
      expect(textChunk).not.toContain(">");
      const strippedEntities = textChunk.replace(
        /&(amp|lt|gt|quot|apos|#39|#x[0-9a-fA-F]+|#[0-9]+);/g,
        ""
      );
      expect(strippedEntities).not.toContain("&");
      i = nextTag === -1 ? cursor.length : nextTag;
    }
  }

  expect(rootCount).toBe(1);
  expect(stack).toEqual([]);
}

function parseViewBox(svg: string): [number, number, number, number] {
  const match = /viewBox="([^"]+)"/.exec(svg);
  expect(match).not.toBeNull();
  const parts = match![1].split(/\s+/).map(Number);
  expect(parts).toHaveLength(4);
  for (const n of parts) {
    expect(Number.isFinite(n)).toBe(true);
  }
  return parts as [number, number, number, number];
}

describe("svg-export — escaping & XSS/XML injection safety", () => {
  it("strictly escapes XML special characters and strips forbidden control chars", () => {
    const raw = `A & B <tag> "quoted" 'single'\u0000\u0007\u001B\u007F`;
    const escaped = escapeXml(raw);
    expect(escaped).toBe(
      "A &amp; B &lt;tag&gt; &quot;quoted&quot; &#39;single&#39;"
    );
    expect(escaped).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  });

  it("neutralizes XSS and XML breakout payloads in element labels, arrow labels, frame titles, and board title", () => {
    const xssPayload = `</text><script>alert(1)</script>`;
    const attrBreakout = `" onload="alert(1)" onclick='evil()' & < > ' "`;
    const elements: JevElement[] = [
      makeElement("frame", {
        id: "frm_xss",
        x: 0,
        y: 0,
        width: 420,
        height: 260,
        label: `Zone ${xssPayload}`,
        tone: "slate",
      }),
      makeElement("node", {
        id: "n_xss",
        x: 40,
        y: 60,
        width: 220,
        height: 80,
        label: `${xssPayload} ${attrBreakout}`,
        tone: "terracotta",
      }),
      makeElement("arrow", {
        id: "a_xss",
        x: 260,
        y: 100,
        width: 140,
        height: 0,
        fromPoint: { x: 260, y: 100 },
        toPoint: { x: 400, y: 100 },
        label: `${attrBreakout}`,
        tone: "ink",
      }),
      makeElement("text", {
        id: "t_xss",
        x: 40,
        y: 170,
        width: 240,
        height: 50,
        label: `Notes & <foreignObject><body onload="alert(2)"></body></foreignObject>\u0000`,
        tone: "ink",
      }),
    ];

    const svg = exportBoardToSvg(elements, {
      title: `Board ${attrBreakout} ${xssPayload}`,
      theme: "vellum",
      renderStyle: "sketch",
    });

    assertWellFormedSvgXml(svg);

    expect(svg.toLowerCase()).not.toContain("<script");
    expect(svg.toLowerCase()).not.toContain("<foreignobject");
    expect(svg.toLowerCase()).not.toContain('onload="');
    expect(svg.toLowerCase()).not.toContain("onclick='");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&#39;");
    expect(svg).toContain("&amp;");
  });

  it("rejects forbidden tags, event handlers, href, and data-* attributes in serializeSvgNode", () => {
    expect(() =>
      serializeSvgNode({ tag: "script", children: ["alert(1)"] })
    ).toThrow();
    expect(() =>
      serializeSvgNode({ tag: "foreignObject", children: [] })
    ).toThrow();
    expect(() =>
      serializeSvgNode({ tag: "style", children: ["body{}"] })
    ).toThrow();
    expect(() =>
      serializeSvgNode({
        tag: "rect",
        attrs: { width: 10, height: 10, onload: "alert(1)" },
      })
    ).toThrow();
    expect(() =>
      serializeSvgNode({
        tag: "g",
        attrs: { ONCLICK: "alert(1)" },
      })
    ).toThrow();
    expect(() =>
      serializeSvgNode({
        tag: "g",
        attrs: { href: "javascript:alert(1)" },
      })
    ).toThrow();
    expect(() =>
      serializeSvgNode({
        tag: "rect",
        attrs: { "xlink:href": "javascript:alert(1)" },
      })
    ).toThrow();
    expect(() =>
      serializeSvgNode({
        tag: "g",
        attrs: { "data-testid": "ui-chrome" },
      })
    ).toThrow();
  });
});

describe("svg-export — standalone cleanliness", () => {
  it("exports pure standalone SVG with zero foreignObject, zero CSS/Tailwind classes, zero UI chrome, and inline styles", () => {
    const starter = createStarterElements();
    const svg = exportBoardToSvg(starter, {
      title: "Architecture Overview",
      theme: "vellum",
      renderStyle: "sketch",
    });

    assertWellFormedSvgXml(svg);

    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("class=");
    expect(svg).not.toContain("data-");
    expect(svg).not.toContain("jev-ghost");
    expect(svg).not.toContain("Enter ↵");
    expect(svg).not.toContain("· P2P");
    expect(svg).not.toContain("cursor-nwse-resize");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");

    // Inline font family stack and theme background are present
    expect(svg).toContain('font-family="');
    expect(svg).toContain('fill="#F7F4ED"');

    // RGBA fills should be split into hex fill + fill-opacity for Illustrator/Inkscape/Figma compatibility
    expect(svg).not.toContain("rgba(");
    expect(svg).toContain('fill-opacity="');
  });
});

describe("svg-export — geometry, bounds, and tight viewBox cropping", () => {
  it("computes a tight cropped viewBox with padding for negative and large world coordinates", () => {
    const negNode = makeElement("node", {
      id: "neg_1",
      x: -1400,
      y: -920,
      width: 200,
      height: 80,
      label: "Negative Origin",
    });

    const svgNeg = exportBoardToSvg([negNode], {
      padding: 40,
      renderStyle: "clean",
    });
    assertWellFormedSvgXml(svgNeg);
    const [vx, vy, vw, vh] = parseViewBox(svgNeg);
    expect(vx).toBe(-1440);
    expect(vy).toBe(-960);
    expect(vw).toBe(280);
    expect(vh).toBe(160);
    // Background rect aligns with the viewBox origin and size
    expect(svgNeg).toContain(
      `x="${vx}" y="${vy}" width="${vw}" height="${vh}"`
    );

    const farNode = makeElement("ellipse", {
      id: "far_1",
      x: 8500,
      y: 6200,
      width: 150,
      height: 70,
      label: "Far World",
    });
    const svgFar = exportBoardToSvg([farNode], {
      padding: 50,
      renderStyle: "clean",
    });
    assertWellFormedSvgXml(svgFar);
    const [fx, fy, fw, fh] = parseViewBox(svgFar);
    expect(fx).toBe(8450);
    expect(fy).toBe(6150);
    expect(fw).toBe(250);
    expect(fh).toBe(170);
  });

  it("includes freedraw points, curved arrows, and mid-arrow labels in the exported viewBox", () => {
    const n1 = makeElement("node", {
      id: "n1",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const n2 = makeElement("node", {
      id: "n2",
      x: 260,
      y: 220,
      width: 100,
      height: 50,
    });
    const diagonalArrow = makeElement("arrow", {
      id: "arr_diag",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fromId: "n1",
      toId: "n2",
      arrowStyle: "curved",
      label: "very-long-asynchronous-stream-event-label",
    });
    const ink = makeElement("freedraw", {
      id: "ink_1",
      x: -250,
      y: 410,
      width: 0,
      height: 0,
      label: "",
      points: [
        { x: -250, y: 410 },
        { x: -120, y: 480 },
        { x: 520, y: 390 },
      ],
    });

    const bounds = computeExportBounds([n1, n2, diagonalArrow, ink]);
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeLessThanOrEqual(-250);
    expect(bounds!.x + bounds!.width).toBeGreaterThanOrEqual(520);
    expect(bounds!.y).toBeLessThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeGreaterThanOrEqual(480);

    const svg = exportBoardToSvg([n1, n2, diagonalArrow, ink], { padding: 32 });
    assertWellFormedSvgXml(svg);
    const [vx, vy, vw, vh] = parseViewBox(svg);
    expect(vx).toBeLessThanOrEqual(-282);
    expect(vx + vw).toBeGreaterThanOrEqual(552);
    expect(vy).toBeLessThanOrEqual(-32);
    expect(vy + vh).toBeGreaterThanOrEqual(512);
  });

  it("produces a valid non-zero fallback SVG for an empty board", () => {
    const svgEmpty = exportBoardToSvg([], {
      title: "Blank Canvas",
      theme: "midnight",
    });
    assertWellFormedSvgXml(svgEmpty);
    const [vx, vy, vw, vh] = parseViewBox(svgEmpty);
    expect(vx).toBe(0);
    expect(vy).toBe(0);
    expect(vw).toBeGreaterThan(0);
    expect(vh).toBeGreaterThan(0);
    expect(svgEmpty).toContain('fill="#11151D"');
    expect(svgEmpty).toContain("<title>Blank Canvas</title>");
  });

  it("allows omitting the background rect via includeBackground: false", () => {
    const node = makeElement("node", { id: "bg_off" });
    const svg = exportBoardToSvg([node], { includeBackground: false });
    assertWellFormedSvgXml(svg);
    expect(svg).not.toContain('fill="#F7F4ED"');
    expect(svg).not.toContain('fill="#11151D"');
  });
});

describe("svg-export — complete element coverage & edge cases", () => {
  it("renders every Jev element kind faithfully in both sketch and clean styles and both themes", () => {
    const gallery: JevElement[] = [
      makeElement("frame", {
        id: "f1",
        x: 20,
        y: 20,
        width: 680,
        height: 420,
        label: "Production Cluster",
        tone: "slate",
      }),
      makeElement("ellipse", {
        id: "e1",
        x: 60,
        y: 80,
        width: 140,
        height: 70,
        label: "Browser Actor",
        tone: "terracotta",
      }),
      makeElement("node", {
        id: "n1",
        x: 260,
        y: 80,
        width: 160,
        height: 74,
        label: "API Gateway",
        tone: "cobalt",
      }),
      makeElement("diamond", {
        id: "d1",
        x: 490,
        y: 68,
        width: 150,
        height: 98,
        label: "Token Valid?",
        tone: "plum",
      }),
      makeElement("database", {
        id: "db1",
        x: 260,
        y: 240,
        width: 160,
        height: 88,
        label: "Postgres Primary",
        tone: "teal",
      }),
      makeElement("text", {
        id: "t1",
        x: 60,
        y: 260,
        width: 160,
        height: 54,
        label: "Line 1\nLine 2 note",
        tone: "ochre",
      }),
      makeElement("arrow", {
        id: "a1",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId: "e1",
        toId: "n1",
        label: "HTTPS",
        tone: "ink",
        arrowStyle: "curved",
      }),
      makeElement("arrow", {
        id: "a2",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId: "n1",
        toId: "db1",
        label: "SQL",
        tone: "teal",
        arrowStyle: "straight",
        dashed: true,
        bidirectional: true,
      }),
      makeElement("freedraw", {
        id: "ink1",
        x: 480,
        y: 260,
        width: 0,
        height: 0,
        label: "",
        tone: "terracotta",
        points: [
          { x: 480, y: 260 },
          { x: 520, y: 290 },
          { x: 575, y: 255 },
          { x: 610, y: 300 },
        ],
      }),
      makeElement("freedraw", {
        id: "ink_dot",
        x: 630,
        y: 320,
        width: 0,
        height: 0,
        label: "",
        tone: "ink",
        points: [{ x: 630, y: 320 }],
      }),
    ];

    for (const theme of ["vellum", "midnight"] as const) {
      for (const renderStyle of ["sketch", "clean"] as const) {
        const svg = exportBoardToSvg(gallery, {
          title: "Full Gallery",
          theme,
          renderStyle,
        });
        assertWellFormedSvgXml(svg);
        expect(svg).toContain("PRODUCTION CLUSTER");
        expect(svg).toContain("Browser Actor");
        expect(svg).toContain("API Gateway");
        expect(svg).toContain("Token Valid?");
        expect(svg).toContain("Postgres Primary");
        expect(svg).toContain("Line 1");
        expect(svg).toContain("Line 2 note");
        expect(svg).toContain("HTTPS");
        expect(svg).toContain("SQL");
        expect(svg).toContain("<path");
        expect(svg).toContain("<text");
        expect(svg).toContain("<tspan");
        expect(svg).toContain("<circle");
      }
    }
  });

  it("wraps long and explicit-newline labels into multiple <tspan> lines", () => {
    const lines = wrapSvgText(
      "Distributed Consensus Coordinator Service\nSecond line here",
      120,
      14
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const el = makeElement("node", {
      id: "multi",
      x: 0,
      y: 0,
      width: 140,
      height: 90,
      label: "Distributed Consensus Coordinator\nRaft Log",
    });
    const svg = exportBoardToSvg([el], { renderStyle: "clean" });
    assertWellFormedSvgXml(svg);
    const tspanCount = (svg.match(/<tspan\b/g) ?? []).length;
    expect(tspanCount).toBeGreaterThanOrEqual(3);
  });

  it("falls back safely on unknown/corrupted tones and non-finite coordinates without throwing or emitting NaN", () => {
    const corrupted: JevElement[] = [
      makeElement("node", {
        id: "bad_tone_1",
        tone: "neon-purple" as unknown as ColorTone,
        label: "Unknown Tone",
      }),
      makeElement("node", {
        id: "bad_tone_2",
        tone: "__proto__" as unknown as ColorTone,
        x: Number.NaN,
        y: Number.POSITIVE_INFINITY,
        width: -40,
        height: Number.NaN,
        seed: Number.NaN,
        label: "Corrupted Geometry",
      }),
      makeElement("node", {
        id: "bad_kind",
        kind: "unknown-future-kind" as unknown as ElementKind,
        label: "Ignored",
      }),
    ];

    const svg = exportBoardToSvg(corrupted, { theme: "vellum" });
    assertWellFormedSvgXml(svg);
    expect(svg).toContain("Unknown Tone");
    // Even after wrapping a clamped degenerate box, the full label text is preserved across tspans
    const plainText = svg.replace(/<[^>]+>/g, "");
    expect(plainText).toContain("CorruptedGeometry");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");

    const tree = buildBoardSvgTree(corrupted);
    expect(tree.tag).toBe("svg");
  });

  it("sanitizes board titles into safe download filenames", () => {
    expect(sanitizeExportFilename("System Sketch")).toBe("system-sketch.svg");
    expect(sanitizeExportFilename("../../etc/passwd<script>")).toBe(
      "etc-passwd-script.svg"
    );
    expect(sanitizeExportFilename("   !!!   ")).toBe("skot-board.svg");
    expect(sanitizeExportFilename("")).toBe("skot-board.svg");
    expect(sanitizeExportFilename("Q4 Architecture / Plan", "svg")).toBe(
      "q4-architecture-plan.svg"
    );
  });
});
