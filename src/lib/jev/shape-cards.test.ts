import { describe, expect, it } from "vitest";
import { generateShapePaths } from "@/lib/jev/rough-paths";
import { apiLayout, cardLayout, layoutShapeGlyphs, shapeLabelBox } from "@/lib/jev/shape-layout";
import { DEFAULT_KIND_SIZE } from "@/lib/jev/notation-kinds";
import { exportBoardToSvg } from "@/lib/jev/svg-export";
import type { JevElement } from "@/lib/jev/types";

function el(kind: "api" | "card", overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: `el_${kind}`,
    kind,
    x: 0,
    y: 0,
    ...DEFAULT_KIND_SIZE[kind],
    label: "",
    tone: "ink",
    seed: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const API = el("api", {
  label: "POST /orders",
  sublabel: "req: {item_id, qty}\nres: 201 {order_id}\nerr: 409 duplicate\nerr: 422 bad qty\nidem: Idempotency-Key",
  height: 150,
});

const texts = (e: JevElement) => layoutShapeGlyphs(e)!.texts;

describe("api card layout", () => {
  it("lays out its own text (no generic centred label)", () => {
    expect(shapeLabelBox(API)).toBeNull();
    expect(layoutShapeGlyphs(API)).not.toBeNull();
  });

  it("draws the method as a badge in the header and the path beside it", () => {
    const g = layoutShapeGlyphs(API)!;
    expect(g.badges).toHaveLength(1);
    expect(g.badges[0].text).toBe("POST");
    const path = g.texts.find((t) => t.text === "/orders")!;
    expect(path.font).toBe("mono");
    expect(path.x).toBeGreaterThan(g.badges[0].x + g.badges[0].w);
    expect(path.y).toBeLessThan(apiLayout(API).headerHeight);
  });

  it("labels each row group once: Request, Response, Errors (two rows), Idempotency key", () => {
    const t = texts(API);
    expect(t.filter((x) => x.tone === "subtext" && x.font === "label").map((x) => x.text)).toEqual([
      "Request",
      "Response",
      "Errors",
      "Idempotency key",
    ]);
    const values = t.filter((x) => x.tone === "text" && x.font === "mono").map((x) => x.text);
    expect(values).toEqual(["/orders", "{item_id, qty}", "201 {order_id}", "409 duplicate", "422 bad qty", "Idempotency-Key"]);
  });

  it("keeps every row inside the card and reports hidden rows", () => {
    const short = { ...API, height: 90 };
    const t = texts(short);
    for (const x of t) expect(x.y).toBeLessThanOrEqual(short.height);
    expect(t.some((x) => /^\+\d more$/.test(x.text))).toBe(true);
  });

  it("is a clean vector: header band, header rule, key column rule, outline", () => {
    const ps = generateShapePaths(API, "#E6E1D6", "#222", "sketch", false, "#11151D");
    expect(ps).toEqual(generateShapePaths(API, "#E6E1D6", "#222", "clean", false, "#11151D"));
    const l = apiLayout(API);
    expect(ps.some((p) => p.d === `M 0 ${l.headerHeight} L ${API.width} ${l.headerHeight}`)).toBe(true);
    expect(ps.some((p) => p.d === `M ${l.keyColWidth} ${l.headerHeight} L ${l.keyColWidth} ${API.height}`)).toBe(true);
  });

  it("without a method, the path starts at the left edge and no badge is drawn", () => {
    const g = layoutShapeGlyphs(el("api", { label: "/health" }))!;
    expect(g.badges).toEqual([]);
    expect(g.texts[0]).toMatchObject({ text: "/health", x: 10 });
  });
});

describe("note card layout", () => {
  const CARD = el("card", {
    label: "Requirements",
    sublabel: "- Shorten a URL\n- Redirect in < 50 ms p99\n- Links never expire unless deleted by their owner",
    width: 240,
    height: 150,
  });

  it("shows the title, then one bullet per line, wrapping long lines inside the card", () => {
    expect(shapeLabelBox(CARD)).toBeNull();
    const g = layoutShapeGlyphs(CARD)!;
    expect(g.texts[0]).toMatchObject({ text: "Requirements", weight: 700 });
    const bullets = g.texts.filter((t) => t.text === "•");
    expect(bullets).toHaveLength(3);
    const body = g.texts.filter((t) => t.text !== "•" && t.text !== "Requirements").map((t) => t.text);
    expect(body.join(" ")).toBe("Shorten a URL Redirect in < 50 ms p99 Links never expire unless deleted by their owner");
    for (const t of g.texts) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThanOrEqual(CARD.height);
    }
    expect(body.length).toBeGreaterThan(3);
  });

  it("is a UML note: folded top-right corner, with a rule under the title", () => {
    const ps = generateShapePaths(CARD, "#E6E1D6", "#222", "clean", false, "#11151D");
    const fold = cardLayout(CARD).fold;
    expect(ps[0].d).toContain(`L ${CARD.width - fold} 0 L ${CARD.width} ${fold}`);
    expect(ps.some((p) => p.d === `M ${CARD.width - fold} 0 L ${CARD.width - fold} ${fold} L ${CARD.width} ${fold}`)).toBe(true);
  });

  it("has a deterministic hand-drawn variant on a sketch board", () => {
    const a = generateShapePaths(CARD, "#E6E1D6", "#222", "sketch", false, "#11151D");
    expect(a).toEqual(generateShapePaths(CARD, "#E6E1D6", "#222", "sketch", false, "#11151D"));
    expect(a).not.toEqual(generateShapePaths(CARD, "#E6E1D6", "#222", "clean", false, "#11151D"));
  });

  it("an untitled card starts its bullets at the top", () => {
    const g = layoutShapeGlyphs(el("card", { label: "", sublabel: "only bullet" }))!;
    expect(g.texts.map((t) => t.text)).toEqual(["•", "only bullet"]);
    expect(g.texts[0].y).toBeLessThan(30);
  });
});

describe("svg export of the cards", () => {
  it("exports the api rows and the note bullets in both themes and styles", () => {
    const card = el("card", { x: 320, label: "Numbers", sublabel: "Writes ≈ 11.6K QPS" });
    for (const theme of ["midnight", "vellum"] as const) {
      for (const renderStyle of ["sketch", "clean"] as const) {
        const svg = exportBoardToSvg([API, card], { theme, renderStyle });
        for (const t of [">POST<", ">/orders<", ">Request<", ">Idempotency key<", ">Numbers<", "Writes ≈ 11.6K QPS"]) {
          expect(svg).toContain(t);
        }
      }
    }
  });
});
