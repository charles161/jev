import { applyMorphToBoard, morphSelectionToNotation } from "../../notation-morph";
import type { JevElement, MorphSemanticSpec, ShapeKind } from "../../types";

/** Hand-made boards for the move analyzers: shapes laid out left to right, arrows by label. */
export function board() {
  const els: JevElement[] = [];
  let n = 0;
  const byLabel = (label: string) => {
    const hit = els.find((e) => e.kind !== "arrow" && e.label === label);
    if (!hit) throw new Error(`no shape labelled ${label}`);
    return hit;
  };
  const api = {
    els,
    shape(kind: ShapeKind, label: string, extra: Partial<JevElement> = {}) {
      n += 1;
      const el: JevElement = {
        id: extra.id ?? `s${n}`,
        kind,
        x: (n - 1) * 240,
        y: 0,
        width: 160,
        height: 72,
        label,
        tone: "ink",
        seed: n,
        createdAt: n,
        updatedAt: n,
        ...extra,
      };
      els.push(el);
      return api;
    },
    arrow(from: string, to: string, label = "", extra: Partial<JevElement> = {}) {
      n += 1;
      els.push({
        id: extra.id ?? `a${n}`,
        kind: "arrow",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId: byLabel(from).id,
        toId: byLabel(to).id,
        label,
        tone: "ink",
        seed: n,
        createdAt: n,
        updatedAt: n,
        ...extra,
      });
      return api;
    },
    id: (label: string) => byLabel(label).id,
  };
  return api;
}

const EMPTY_SPEC: Omit<MorphSemanticSpec, "summary"> = {
  actors: [],
  messages: [],
  steps: [],
  states: [],
  transitions: [],
  entities: [],
  relations: [],
};

/** A real morphed diagram: one sketch box per spec item, morphed with a fixed spec (as the `/` starters do). */
export function morphed(
  notation: "sequence" | "state",
  labels: string[],
  spec: Partial<MorphSemanticSpec>
): JevElement[] {
  const sketch = board();
  labels.forEach((l) => sketch.shape("node", l));
  labels.slice(1).forEach((l, i) => sketch.arrow(labels[i], l));
  const morph = morphSelectionToNotation(
    sketch.els.filter((e) => e.kind !== "arrow").map((e) => e.id),
    sketch.els,
    notation,
    { specOverride: { ...EMPTY_SPEC, summary: "fixture", ...spec }, now: 1, isHeuristic: false }
  );
  if (!morph) throw new Error("morph failed");
  return applyMorphToBoard(sketch.els, morph);
}
