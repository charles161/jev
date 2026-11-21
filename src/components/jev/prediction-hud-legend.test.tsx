// Judges, 21 Nov: with partial text Tab completes the word first, but the legend only said "Tab cycle".
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PredictionHud } from "@/components/jev/PredictionHud";
import type { PredictedAction } from "@/lib/jev/types";

const pred = (id: string): PredictedAction => ({ id, title: id, subtitle: "s", category: "extend", addElements: [], tier: "minimal", nodeCount: 1 });
const base = { intent: null, predictions: [pred("a"), pred("b"), pred("c")], activeIndex: 0, telemetry: null, onHoverIndex: () => {}, onApply: () => {}, onDismiss: () => {} };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the Tab legend says what Tab will do", () => {
  it("while a completion is pending: Tab complete · Tab cycle", () => {
    expect(text(renderToStaticMarkup(<PredictionHud {...base} completion="API Gateway" />))).toMatch(/Tab complete · Tab cycle/);
  });
  it("otherwise: Tab cycle", () => {
    const t = text(renderToStaticMarkup(<PredictionHud {...base} />));
    expect(t).toMatch(/Tab cycle/);
    expect(t).not.toMatch(/complete/);
  });
});
