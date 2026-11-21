import { describe, expect, it } from "vitest";
import {
  buildBoardSvgTree,
  computeExportBounds,
  escapeXml,
  exportBoardToSvg,
  sanitizeExportFilename,
  serializeSvgNode,
  wrapSvgText,
  type SvgNode,
} from "@/lib/jev/svg-export";
import { computeArrowHeadPath } from "@/lib/jev/rough-paths";
import { createStarterElements } from "@/lib/jev/templates";
import { ELEMENT_KINDS, type ColorTone, type ElementKind, type JevElement } from "@/lib/jev/types";

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

describe("svg-export — notation kinds and end markers", () => {
  const entityA = makeElement("entity", {
    id: "users",
    x: 0,
    y: 0,
    width: 200,
    height: 136,
    label: "users",
    sublabel: "id uuid PK\norg_id uuid FK\nemail text UK",
    tone: "ink",
  });
  const entityB = makeElement("entity", {
    id: "orders",
    x: 400,
    y: 0,
    width: 200,
    height: 136,
    label: "orders",
    sublabel: "id uuid PK\nuser_id uuid FK",
    tone: "ink",
  });
  const relation = makeElement("arrow", {
    id: "rel",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    fromId: "users",
    toId: "orders",
    label: "",
    tone: "ink",
    arrowStyle: "straight",
    startEnd: "er_only_one",
    endEnd: "er_zero_many",
  });

  it("exports every element kind (no kind is silently dropped)", () => {
    for (const kind of ELEMENT_KINDS) {
      const el = makeElement(kind, {
        id: `k_${kind}`,
        label: `Label ${kind}`,
        ...(kind === "arrow" ? { fromPoint: { x: 0, y: 0 }, toPoint: { x: 100, y: 0 } } : {}),
        ...(kind === "freedraw" ? { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] } : {}),
      });
      const tree = buildBoardSvgTree([el], { includeBackground: false });
      const drawn = (tree.children ?? []).filter((c) => typeof c !== "string");
      expect(drawn.length, kind).toBe(1);
    }
  });

  it("draws crow's-foot ends with a board-coloured circle and three prongs at the entity edge", () => {
    for (const theme of ["midnight", "vellum"] as const) {
      const tree = buildBoardSvgTree([entityA, entityB, relation], { theme, renderStyle: "sketch" });
      const svg = serializeSvgNode(tree);
      assertWellFormedSvgXml(svg);
      const paper = theme === "midnight" ? "#11151D" : "#F7F4ED";
      const groups = (tree.children ?? []).filter(
        (c): c is SvgNode => typeof c !== "string" && c.tag === "g" && !c.attrs?.transform
      );
      expect(groups).toHaveLength(1);
      const paths = (groups[0].children ?? []).filter(
        (c): c is SvgNode & { attrs: Record<string, unknown> } => typeof c !== "string" && c.tag === "path"
      );
      // line + two bars + three prongs + one circle
      expect(paths).toHaveLength(7);
      expect(paths.filter((p) => p.attrs.fill === paper)).toHaveLength(1);
      // the prongs reach the entity's left edge (x = 400)
      const prongTips = paths
        .map((p) => String(p.attrs.d))
        .filter((d) => /^M [\d.]+ [\d.-]+ L 400\.0 /.test(d));
      expect(prongTips).toHaveLength(3);
    }
  });

  it("exports entity tables with PK/FK/UK badges and column names", () => {
    const svg = exportBoardToSvg([entityA], { theme: "midnight", renderStyle: "clean" });
    assertWellFormedSvgXml(svg);
    for (const t of [">users<", ">PK<", ">FK<", ">UK<", ">org_id<", ">email<", ">uuid<"]) {
      expect(svg).toContain(t);
    }
    expect(svg).toContain('text-decoration="underline"');
  });

  it("renders LLD shapes as clean vectors even on a sketch board", () => {
    const shapeGroup = (renderStyle: "sketch" | "clean") =>
      serializeSvgNode(buildBoardSvgTree([entityA], { renderStyle, includeBackground: false }).children!.at(-1) as never);
    expect(shapeGroup("sketch")).toBe(shapeGroup("clean"));
    expect(shapeGroup("sketch")).not.toContain("Architects Daughter");
  });

  it("exports class compartments, fragment operator and guards, zone labels, and glyph-only pseudo-states", () => {
    const board = [
      makeElement("zone", { id: "z", x: 0, y: 0, width: 600, height: 400, label: "VPC us-east-1", tone: "teal" }),
      makeElement("fragment", { id: "f", x: 20, y: 40, width: 300, height: 160, label: "alt", sublabel: "[cache hit]\n[else]" }),
      makeElement("class", { id: "c", x: 340, y: 40, width: 200, height: 148, label: "ParkingLot", sublabel: "- id: UUID\n--\n+ park(car): Ticket" }),
      makeElement("initial", { id: "i", x: 20, y: 300, width: 26, height: 26, label: "START_SHOULD_NOT_SHOW" }),
      makeElement("final", { id: "fi", x: 80, y: 300, width: 30, height: 30, label: "END_SHOULD_NOT_SHOW" }),
      makeElement("actor", { id: "a", x: 160, y: 260, width: 72, height: 104, label: "Customer" }),
      makeElement("queue", { id: "q", x: 260, y: 280, width: 176, height: 64, label: "Kafka" }),
    ];
    for (const theme of ["midnight", "vellum"] as const) {
      for (const renderStyle of ["sketch", "clean"] as const) {
        const svg = exportBoardToSvg(board, { theme, renderStyle });
        assertWellFormedSvgXml(svg);
        for (const t of ["VPC us-east-1", ">alt<", "[cache hit]", "[else]", "ParkingLot", "- id: UUID", "+ park(car): Ticket", "Customer", "Kafka"]) {
          expect(svg).toContain(t);
        }
        expect(svg).not.toContain("START_SHOULD_NOT_SHOW");
        expect(svg).not.toContain("END_SHOULD_NOT_SHOW");
        expect(svg).toContain('stroke-dasharray="12 5 2 5"');
        expect(svg).toContain('stroke-dasharray="6 4"');
      }
    }
  });

  it("draws zones and fragments in the container layer, behind arrows and shapes", () => {
    const tree = buildBoardSvgTree(
      [
        makeElement("node", { id: "n", x: 50, y: 50, label: "Svc" }),
        makeElement("arrow", { id: "ar", fromPoint: { x: 0, y: 0 }, toPoint: { x: 40, y: 0 }, label: "go" }),
        makeElement("fragment", { id: "f", x: 0, y: 0, width: 300, height: 200, label: "loop", sublabel: "[each]" }),
        makeElement("zone", { id: "z", x: -20, y: -20, width: 400, height: 300, label: "Trust zone" }),
      ],
      { includeBackground: false }
    );
    const order = (tree.children ?? []).map((c) => JSON.stringify(c));
    const idx = (needle: string) => order.findIndex((s) => s.includes(needle));
    expect(idx("Trust zone")).toBeLessThan(idx('"go"'));
    expect(idx("[each]")).toBeLessThan(idx('"go"'));
    expect(idx('"go"')).toBeLessThan(idx("Svc"));
  });

  it("pulls lines back under hollow UML markers and fills them with the paper colour", () => {
    const a = makeElement("arrow", {
      id: "inh",
      fromPoint: { x: 0, y: 0 },
      toPoint: { x: 200, y: 0 },
      arrowStyle: "straight",
      label: "",
      endEnd: "triangle",
      startEnd: "diamond",
      tone: "ink",
    });
    const svg = exportBoardToSvg([a], { theme: "vellum", renderStyle: "clean" });
    expect(svg).toContain('fill="#F7F4ED"');
    expect(svg).toMatch(/d="M 20 0 Q 100 0 186 0"/);
  });

  it("keeps legacy arrows byte-identical: same open chevrons, same line", () => {
    const legacy = makeElement("arrow", {
      id: "old",
      fromPoint: { x: 0, y: 0 },
      toPoint: { x: 200, y: 0 },
      arrowStyle: "straight",
      label: "",
      bidirectional: true,
      tone: "ink",
    });
    const svg = exportBoardToSvg([legacy], { theme: "vellum", renderStyle: "clean" });
    expect(svg).toContain('d="M 0 0 Q 100 0 200 0"');
    expect(svg).toContain(`d="${computeArrowHeadPath({ x: 100, y: 0 }, { x: 200, y: 0 }, 8.5)}"`);
    expect(svg).toContain(`d="${computeArrowHeadPath({ x: 100, y: 0 }, { x: 0, y: 0 }, 8.5)}"`);
    expect(svg).not.toContain('fill="#1F232B"');
  });

  it("escapes hostile text in entity rows, class members and fragment guards", () => {
    const evil = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
    const svg = exportBoardToSvg(
      [
        makeElement("entity", { id: "e", label: evil, sublabel: `${evil} PK` }),
        makeElement("class", { id: "c", x: 300, label: evil, sublabel: `${evil}\n--\n${evil}` }),
        makeElement("fragment", { id: "f", x: 600, label: evil, sublabel: evil }),
      ],
      { theme: "midnight" }
    );
    assertWellFormedSvgXml(svg);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(svg).not.toMatch(/<[^>]*\sonerror=/);
    expect(svg).not.toContain("foreignObject");
  });
});
