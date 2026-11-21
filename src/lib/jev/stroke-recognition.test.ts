// Charles (21 Nov 2026): a freehand pen stroke gets interpreted and offered as predictions in the same top-3
// panel. Connect A → B (→ C), turn a closed loop into a node of the inferred shape, lasso → group. The stroke is
// only ever removed by an accepted conversion; a stroke that matches nothing is left alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPredictionToElements,
  generateCandidatePool,
  generateSelectionPredictions,
  generateStrokePredictions,
  GENERIC_SUGGESTION_LABELS,
  isContextNamed,
  selectTopSuggestions,
} from "@/lib/jev/prediction-engine";
import { SelectionSuggestTrigger } from "@/lib/jev/selection-trigger";
import { recognizeStroke, strokeUnit } from "@/lib/jev/stroke-recognition";
import type { JevElement, Point, PredictedAction } from "@/lib/jev/types";

const el = (o: Partial<JevElement> & { id: string; label: string }): JevElement => ({
  kind: "node",
  x: 100,
  y: 100,
  width: 160,
  height: 72,
  tone: "cobalt",
  seed: 1,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});
const arrow = (id: string, fromId: string, toId: string): JevElement =>
  el({ id, kind: "arrow", label: "", fromId, toId, x: 0, y: 0, width: 0, height: 0 });
const ink = (id: string, points: Point[]): JevElement =>
  el({ id, kind: "freedraw", label: "", tone: "ink", x: points[0].x, y: points[0].y, width: 0, height: 0, points });

/** Densify a polyline to ~6px steps (the canvas records a point every >3px) with a deterministic hand wobble. */
function hand(corners: Point[], wobble = 0, step = 6): Point[] {
  const out: Point[] = [];
  let i = 0;
  for (let s = 0; s < corners.length - 1; s++) {
    const a = corners[s];
    const b = corners[s + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / step));
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const w = wobble * Math.sin(i++ * 0.7);
      out.push({ x: a.x + (b.x - a.x) * t + nx * w, y: a.y + (b.y - a.y) * t + ny * w });
    }
  }
  out.push(corners[corners.length - 1]);
  return out;
}
const arc = (cx: number, cy: number, rx: number, ry: number, from: number, to: number, n = 48): Point[] =>
  Array.from({ length: n + 1 }, (_, k) => {
    const t = from + ((to - from) * k) / n;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
const rectLoop = (x: number, y: number, w: number, h: number, wobble = 2.5) =>
  hand([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x: x + 4, y: y + 3 }], wobble);
const rhombusLoop = (x: number, y: number, w: number, h: number) =>
  hand([
    { x: x + w / 2, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 },
    { x: x + w / 2 + 3, y: y + 2 },
  ], 2);
function roundedRect(x: number, y: number, w: number, h: number, r: number): Point[] {
  const P = Math.PI;
  return [
    ...arc(x + w - r, y + r, r, r, -P / 2, 0, 10),
    ...arc(x + w - r, y + h - r, r, r, 0, P / 2, 10),
    ...arc(x + r, y + h - r, r, r, P / 2, P, 10),
    ...arc(x + r, y + r, r, r, P, 1.5 * P, 10),
    ...hand([{ x: x + r, y }, { x: x + w - r, y }]),
  ];
}
/** A database cylinder outline: elliptical top cap, two sides, elliptical bottom. */
function cylinder(x: number, y: number, w: number, h: number, cap: number): Point[] {
  const P = Math.PI;
  const cx = x + w / 2;
  return [
    ...arc(cx, y + cap, w / 2, cap, P, 2 * P, 20),
    ...hand([{ x: x + w, y: y + cap }, { x: x + w, y: y + h - cap }]),
    ...arc(cx, y + h - cap, w / 2, cap, 0, P, 20),
    ...hand([{ x, y: y + h - cap }, { x, y: y + cap + 2 }]),
  ];
}
function stickFigure(cx: number, top: number): Point[] {
  const P = Math.PI;
  const r = 18;
  const neck = { x: cx, y: top + 2 * r };
  return [
    ...arc(cx, top + r, r, r, P / 2, P / 2 + 2 * P, 32),
    ...hand([
      neck,
      { x: cx, y: top + 2 * r + 22 },
      { x: cx - 28, y: top + 2 * r + 36 },
      { x: cx, y: top + 2 * r + 22 },
      { x: cx + 28, y: top + 2 * r + 36 },
      { x: cx, y: top + 2 * r + 22 },
      { x: cx, y: top + 2 * r + 70 },
      { x: cx - 24, y: top + 2 * r + 110 },
      { x: cx, y: top + 2 * r + 70 },
      { x: cx + 24, y: top + 2 * r + 110 },
    ]),
  ];
}
function zigzag(x: number, y: number): Point[] {
  const corners: Point[] = [];
  for (let k = 0; k < 16; k++) corners.push({ x: x + (k % 2 ? 120 : 0), y: y + k * 8 });
  return hand(corners, 1.5);
}
function randomWalk(x: number, y: number, seed: number, steps = 90): Point[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pts: Point[] = [{ x, y }];
  let angle = 0;
  for (let k = 0; k < steps; k++) {
    angle += (rnd() - 0.5) * 2.6;
    const p = pts[pts.length - 1];
    pts.push({ x: p.x + 7 * Math.cos(angle), y: p.y + 7 * Math.sin(angle) });
  }
  return pts;
}

const shapesOf = (a: PredictedAction) => a.addElements.filter((e) => e.kind !== "arrow");
const arrowsOf = (a: PredictedAction) => a.addElements.filter((e) => e.kind === "arrow");

const shop = [
  el({ id: "co", label: "Checkout", x: 100, y: 100 }),
  el({ id: "db", label: "Orders DB", kind: "database", x: 500, y: 100, width: 156, height: 86 }),
  el({ id: "pay", label: "Payment Service", x: 900, y: 100 }),
];
const row = [
  el({ id: "web", label: "Web App", x: 100, y: 100 }),
  el({ id: "gw", label: "API Gateway", x: 400, y: 100 }),
  el({ id: "odb", label: "Orders DB", kind: "database", x: 700, y: 100, width: 160, height: 72 }),
];

describe("stroke recognition: connect", () => {
  it("a wobbly line from node A to node B offers Connect A → B in stroke direction, labelled, removing the stroke", () => {
    const stroke = ink("ink1", hand([{ x: 190, y: 140 }, { x: 575, y: 145 }], 8));
    expect(recognizeStroke(stroke.points!, shop)).toEqual({ kind: "connect", path: ["co", "db"] });
    const res = generateStrokePredictions(stroke, [...shop, stroke], { boardTitle: "Shop" })!;
    const first = res.pool[0];
    expect(first.title).toBe("Connect Checkout → Orders DB");
    expect(first.removeIds).toEqual(["ink1"]);
    const [a] = arrowsOf(first);
    expect([a.fromId, a.toId]).toEqual(["co", "db"]);
    expect(a.label).toBe("writes to");
    expect(first.subtitle).toBe("Checkout writes to Orders DB");
  });

  it("the stroke direction wins over meaning: drawn from the DB to Checkout points that way", () => {
    const stroke = ink("ink2", hand([{ x: 575, y: 145 }, { x: 190, y: 140 }], 8));
    const res = generateStrokePredictions(stroke, [...shop, stroke])!;
    expect(res.pool[0].title).toBe("Connect Orders DB → Checkout");
    expect(arrowsOf(res.pool[0]).map((x) => [x.fromId, x.toId])).toEqual([["db", "co"]]);
  });

  it("an endpoint just outside the node edge still counts", () => {
    const stroke = ink("ink3", hand([{ x: 280, y: 136 }, { x: 485, y: 140 }], 4));
    expect(recognizeStroke(stroke.points!, shop)).toEqual({ kind: "connect", path: ["co", "db"] });
  });

  it("a line through A, B and C offers the path A → B → C with one labelled arrow per hop", () => {
    const stroke = ink("ink4", hand([{ x: 180, y: 136 }, { x: 780, y: 138 }], 6));
    expect(recognizeStroke(stroke.points!, row)).toEqual({ kind: "connect", path: ["web", "gw", "odb"] });
    const res = generateStrokePredictions(stroke, [...row, stroke])!;
    const path = res.pool[0];
    expect(path.title).toBe("Connect Web App → API Gateway → Orders DB");
    expect(arrowsOf(path).map((a) => [a.fromId, a.toId, a.label])).toEqual([
      ["web", "gw", "calls"],
      ["gw", "odb", "writes to"],
    ]);
    expect(path.removeIds).toEqual(["ink4"]);
    expect(res.pool.some((a) => a.title === "Connect Web App → Orders DB")).toBe(true);
  });

  it("does not offer a link that already exists", () => {
    const board = [...shop, arrow("x", "co", "db")];
    const stroke = ink("ink5", hand([{ x: 190, y: 140 }, { x: 575, y: 145 }], 8));
    expect(generateStrokePredictions(stroke, [...board, stroke])).toBeNull();
  });

  it("connect options count as context-named and stay in the visible top 3", () => {
    const stroke = ink("ink6", hand([{ x: 180, y: 136 }, { x: 780, y: 138 }], 6));
    const res = generateStrokePredictions(stroke, [...row, stroke])!;
    expect(res.pool.every(isContextNamed)).toBe(true);
    expect(selectTopSuggestions(res.pool)[0].title).toBe(res.pool[0].title);
  });
});

describe("stroke recognition: closed loop → node", () => {
  const ctx = [
    el({ id: "co", label: "Checkout", x: 100, y: 100 }),
    el({ id: "pay", label: "Payment Service", x: 420, y: 100 }),
  ];
  const turnInto = (points: Point[], board = ctx, boardTitle = "Shop") => {
    const stroke = ink("loop", points);
    return { stroke, res: generateStrokePredictions(stroke, [...board, stroke], { boardTitle }) };
  };

  it.each([
    ["a wobbly rectangle", "node", rectLoop(300, 450, 180, 90)],
    ["a rhombus with corners at the edge midpoints", "diamond", rhombusLoop(300, 450, 170, 120)],
    ["a tall rounded box", "database", roundedRect(300, 420, 90, 150, 35)],
    ["a cylinder", "database", cylinder(300, 420, 100, 150, 20)],
    ["a circle", "ellipse", arc(380, 500, 50, 50, 0, 2 * Math.PI, 60)],
    ["a stick figure", "ellipse", stickFigure(380, 420)],
  ] as const)("%s in empty space becomes a %s", (_name, shape, points) => {
    expect(recognizeStroke(points, ctx)).toMatchObject({ kind: "shape", shape });
    const { res } = turnInto(points);
    const first = res!.pool[0];
    expect(first.title.startsWith("Turn into")).toBe(true);
    expect(first.removeIds).toEqual(["loop"]);
    const [node] = shapesOf(first);
    expect(node.kind).toBe(shape);
    expect(first.focusId).toBe(node.id);
  });

  it("names the new node from the nearest nodes and the board title, never a generic label", () => {
    for (const points of [rectLoop(300, 450, 180, 90), rhombusLoop(300, 450, 170, 120), roundedRect(300, 420, 90, 150, 35)]) {
      const { res } = turnInto(points);
      for (const a of res!.pool) {
        const [node] = shapesOf(a);
        expect(node.label).not.toBe("Next Step");
        expect(GENERIC_SUGGESTION_LABELS.has(node.label)).toBe(false);
        expect(isContextNamed(a)).toBe(true);
      }
    }
    const { res } = turnInto(rectLoop(300, 450, 180, 90));
    expect(shapesOf(res!.pool[0])[0].label).toMatch(/Payment|Checkout|Order|Refund|Fraud|Invoice|Cart/);
  });

  it("an empty board falls back to the board title, then to a plain shape noun", () => {
    const titled = turnInto(rectLoop(300, 450, 180, 90), [], "Payments Platform").res!;
    expect(shapesOf(titled.pool[0])[0].label).not.toBe("Next Step");
    expect(isContextNamed(titled.pool[0])).toBe(true);
    const bare = turnInto(rhombusLoop(300, 450, 170, 120), [], "Untitled Sheet").res!;
    expect(shapesOf(bare.pool[0])[0].label).toBe("Decision");
  });

  it("places the node where the stroke was drawn (its bounding box)", () => {
    const { res } = turnInto(rectLoop(300, 450, 180, 90, 0));
    const [node] = shapesOf(res!.pool[0]);
    expect(node.x).toBe(300);
    expect(node.y).toBe(450);
    expect(node.width).toBe(180);
    expect(node.height).toBe(90);
  });

  it("an actor is centred on the figure with the normal actor size", () => {
    const { res } = turnInto(stickFigure(380, 420));
    const [node] = shapesOf(res!.pool[0]);
    expect(Math.abs(node.x + node.width / 2 - 380)).toBeLessThanOrEqual(2);
    expect(res!.pool[0].title).toMatch(/^Turn into an actor/);
  });

  it("a loop around a single node is left alone", () => {
    expect(recognizeStroke(rectLoop(80, 80, 200, 112), ctx)).toEqual({ kind: "none" });
  });
});

describe("stroke recognition: lasso → group", () => {
  const board = [
    el({ id: "co", label: "Checkout", x: 100, y: 100 }),
    el({ id: "inv", label: "Inventory", x: 320, y: 100 }),
    el({ id: "pay", label: "Payment Service", x: 210, y: 240 }),
    el({ id: "far", label: "Search", x: 900, y: 600 }),
  ];
  const lasso = arc(290, 210, 290, 170, -Math.PI / 2, 1.4 * Math.PI, 80);

  it("a lasso around three nodes offers Group these plus the group suggestions, none removing a node", () => {
    expect(recognizeStroke(lasso, board)).toEqual({ kind: "lasso", enclosedIds: ["co", "inv", "pay"] });
    const stroke = ink("lasso", lasso);
    const res = generateStrokePredictions(stroke, [...board, stroke], { boardTitle: "Shop" })!;
    expect(res.pool[0].title).toMatch(/^Group these/);
    expect(res.pool[0].addElements[0].kind).toBe("frame");
    const selection = generateSelectionPredictions(["co", "inv", "pay"], board, { boardTitle: "Shop" })!;
    const groupTitles = selection.pool.filter((a) => a.category !== "structure").map((a) => a.title);
    expect(res.pool.map((a) => a.title)).toEqual(expect.arrayContaining(groupTitles));
    for (const a of res.pool) expect(a.removeIds).toEqual(["lasso"]);
  });
});

describe("stroke recognition: no match", () => {
  const board = [el({ id: "co", label: "Checkout", x: 100, y: 100 }), el({ id: "db", label: "Orders DB", x: 500, y: 100 })];

  it.each([
    ["a zigzag scribble", zigzag(300, 500)],
    ["a random scribble", randomWalk(400, 600, 7)],
    ["another random scribble", randomWalk(250, 450, 42)],
    ["a tiny tick", hand([{ x: 600, y: 600 }, { x: 610, y: 612 }])],
    ["a scribble from A to B", hand([190, 260, 330, 400, 470].flatMap((x, k) => [{ x, y: 140 }, { x: x + 35, y: k % 2 ? 60 : 230 }]).concat([{ x: 560, y: 140 }]), 3)],
  ])("%s gives no conversion and leaves the stroke alone", (_name, points) => {
    expect(recognizeStroke(points, board)).toEqual({ kind: "none" });
    const stroke = ink("scr", points);
    expect(generateStrokePredictions(stroke, [...board, stroke])).toBeNull();
  });
});

describe("stroke recognition: scale and purity", () => {
  it("thresholds follow node size, not zoom: the same drawing at 2x scale reads the same", () => {
    const scale = (e: JevElement): JevElement => ({ ...e, x: e.x * 2, y: e.y * 2, width: e.width * 2, height: e.height * 2 });
    const s2 = (pts: Point[]) => pts.map((p) => ({ x: p.x * 2, y: p.y * 2 }));
    expect(strokeUnit(shop.map(scale))).toBe(2 * strokeUnit(shop));
    const fixtures = [
      hand([{ x: 280, y: 136 }, { x: 485, y: 140 }], 4),
      rhombusLoop(300, 450, 170, 120),
      roundedRect(300, 420, 90, 150, 35),
      zigzag(300, 500),
    ];
    const gist = (r: ReturnType<typeof recognizeStroke>) => (r.kind === "shape" ? { ...r, box: undefined } : r);
    for (const f of fixtures) expect(gist(recognizeStroke(s2(f), shop.map(scale)))).toEqual(gist(recognizeStroke(f, shop)));
  });

  it("is deterministic and does not mutate its inputs", () => {
    const pts = rectLoop(300, 450, 180, 90);
    const before = JSON.stringify([pts, shop]);
    expect(recognizeStroke(pts, shop)).toEqual(recognizeStroke(pts, shop));
    expect(JSON.stringify([pts, shop])).toBe(before);
  });
});

describe("stroke predictions never delete the stroke unless accepted", () => {
  const strokes = {
    connect: hand([{ x: 190, y: 140 }, { x: 575, y: 145 }], 8),
    shape: rectLoop(300, 450, 180, 90),
    scribble: zigzag(300, 500),
  };

  it("only an accepted stroke conversion removes the stroke, and it removes nothing else", () => {
    for (const points of Object.values(strokes)) {
      const stroke = ink("pen", points);
      const board = [...shop, stroke];
      const res = generateStrokePredictions(stroke, board);
      for (const a of res?.pool ?? []) {
        expect(a.removeIds).toEqual(["pen"]);
        const after = applyPredictionToElements(board, a);
        expect(after.some((e) => e.id === "pen")).toBe(false);
        for (const n of shop) expect(after.some((e) => e.id === n.id)).toBe(true);
      }
    }
  });

  it("no other prediction source ever carries the stroke in removeIds", () => {
    const stroke = ink("pen", strokes.connect);
    const board = [...shop, stroke];
    const intent = { kind: "domain_continue" as const, headline: "h", detail: "d", subjectId: "co", relatedIds: [], timestamp: 1 };
    const others = [
      ...generateCandidatePool(intent, board),
      ...generateSelectionPredictions(["co", "db"], board)!.pool,
      ...generateSelectionPredictions(["co"], board)!.pool,
    ];
    for (const a of others) expect(a.removeIds ?? []).not.toContain("pen");
  });

  it("dismissing applies nothing: the board keeps the stroke", () => {
    const stroke = ink("pen", strokes.shape);
    const board = [...shop, stroke];
    expect(applyPredictionToElements(board, null)).toBe(board);
  });
});

describe("a pen stroke does not also fire selection predictions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("once the stroke consumes the selection, the canvas settling does not fire", () => {
    const fired: string[] = [];
    const trigger = new SelectionSuggestTrigger({ delayMs: 500, onFire: (key) => fired.push(key) });
    trigger.select(["co"]);
    trigger.setBusy(true);
    trigger.consume();
    trigger.setBusy(false);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual([]);
  });
});
