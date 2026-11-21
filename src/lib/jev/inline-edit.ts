import { makeSeed } from "./geometry";
import type { JevElement, Point } from "./types";

export type EditField = "label" | "sublabel";

export interface LabelEditSession {
  id: string;
  field: EditField;
  draft: string;
  /** True when the element was created by the double-click itself (empty canvas -> text). */
  createdForEdit: boolean;
}

const SUBLABEL_ZONE_START = 0.6;
export const TEXT_DEFAULT_SIZE = { width: 180, height: 42 } as const;

/** Which field a double-click at a world point edits: the sublabel line sits in the lower part of a shape. */
export function pickEditField(el: JevElement, world: Point): EditField {
  if (el.kind === "arrow" || !el.sublabel) return "label";
  return world.y - el.y > el.height * SUBLABEL_ZONE_START ? "sublabel" : "label";
}

export function beginLabelEdit(el: JevElement, field: EditField): LabelEditSession | null {
  if (el.kind === "freedraw") return null;
  const draft = field === "sublabel" ? el.sublabel ?? "" : el.label;
  return { id: el.id, field, draft, createdForEdit: false };
}

export function editKeyAction(e: { key: string; shiftKey: boolean }): "commit" | "cancel" | "type" {
  if (e.key === "Escape") return "cancel";
  if (e.key === "Enter" && !e.shiftKey) return "commit";
  return "type";
}

export function createTextAt(
  world: Point,
  now: number,
  id: string
): { element: JevElement; session: LabelEditSession } {
  const { width, height } = TEXT_DEFAULT_SIZE;
  const element: JevElement = {
    id,
    kind: "text",
    x: Math.round(world.x - width / 2),
    y: Math.round(world.y - height / 2),
    width,
    height,
    label: "",
    tone: "ink",
    seed: makeSeed(id),
    createdAt: now,
    updatedAt: now,
  };
  return { element, session: { id, field: "label", draft: "", createdForEdit: true } };
}

/** Applies the draft. Returns the same array when nothing changes so callers skip undo + broadcast. */
export function commitLabelEdit(
  elements: JevElement[],
  session: LabelEditSession,
  now: number
): JevElement[] {
  const target = elements.find((e) => e.id === session.id);
  if (!target) return elements;
  const next = session.draft.trim();

  if (session.createdForEdit && !next) {
    return elements.filter((e) => e.id !== session.id);
  }

  let updated: JevElement;
  if (session.field === "sublabel") {
    if ((target.sublabel ?? "") === next) return elements;
    const { sublabel: _drop, ...rest } = target;
    void _drop;
    updated = next ? { ...target, sublabel: next, updatedAt: now } : { ...rest, updatedAt: now };
  } else {
    const label = next || (target.kind === "arrow" ? "" : target.label || "Node");
    if (label === target.label) return elements;
    updated = { ...target, label, updatedAt: now };
  }
  return elements.map((e) => (e.id === session.id ? updated : e));
}

export function cancelLabelEdit(elements: JevElement[], session: LabelEditSession): JevElement[] {
  return session.createdForEdit ? elements.filter((e) => e.id !== session.id) : elements;
}
