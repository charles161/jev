import { resolveArrowEnds } from "./notation-kinds";
import type { ArrowEnd, JevElement } from "./types";

export const ARROW_END_GROUPS: readonly { title: string; ends: readonly ArrowEnd[] }[] = [
  { title: "Heads", ends: ["none", "arrow", "open"] },
  { title: "UML", ends: ["triangle", "diamond", "odiamond"] },
  { title: "Crow's foot", ends: ["er_one", "er_only_one", "er_zero_one", "er_many", "er_one_many", "er_zero_many"] },
];

export const ARROW_END_LABELS: Record<ArrowEnd, string> = {
  none: "None",
  arrow: "Arrow",
  open: "Open arrow",
  triangle: "Inheritance",
  diamond: "Composition",
  odiamond: "Aggregation",
  er_one: "One",
  er_only_one: "Only one",
  er_zero_one: "Zero or one",
  er_many: "Many",
  er_one_many: "One or many",
  er_zero_many: "Zero or many",
};

type ArrowEndFields = Pick<JevElement, "startEnd" | "endEnd" | "bidirectional" | "morphMeta">;

/** Sets one end and pins the other to what it currently renders as, so the pair is explicit. */
export function arrowEndPatch(
  el: ArrowEndFields,
  side: "start" | "end",
  end: ArrowEnd
): Pick<JevElement, "startEnd" | "endEnd"> {
  const current = resolveArrowEnds(el);
  return side === "start" ? { startEnd: end, endEnd: current.end } : { startEnd: current.start, endEnd: end };
}

export function isBidirectional(el: ArrowEndFields): boolean {
  return resolveArrowEnds(el).start !== "none";
}

export function bidirectionalTogglePatch(el: ArrowEndFields): Pick<JevElement, "bidirectional" | "startEnd"> {
  return isBidirectional(el) ? { bidirectional: false, startEnd: "none" } : { bidirectional: true, startEnd: "arrow" };
}
