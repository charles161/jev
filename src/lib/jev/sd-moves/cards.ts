import { computeBounds, getElementRect, isShapeElement, makeSeed, rectsOverlap, resolveArrowEndpoints, uid, type Rect } from "../geometry";
import { isContainerKind } from "../notation-kinds";
import { cardLayout } from "../shape-layout";
import type { ColorTone, JevElement } from "../types";
import type { BreakResult } from "./break-at-10x";
import type { ConsistencyResult } from "./consistency";
import type { FailureResult } from "./failure-steps";

export const RULE_SOURCE = "rule-based";

/** The last line of every move card: where its words came from. */
export function sourceLine(source: string): string {
  return source === RULE_SOURCE ? "Source: rule-based check" : `Source: AI (${source})`;
}

const GAP = 56;
const MAX_CONSISTENCY_LINES = 8;

function stamp(prefix: string, now: number) {
  const id = uid(prefix);
  return { id, seed: makeSeed(id), createdAt: now, updatedAt: now };
}

/** A note card whose height fits every line at this width. */
export function sizedCard(label: string, lines: string[], width: number, tone: ColorTone, now: number): JevElement {
  const sublabel = lines.join("\n");
  const probe = cardLayout({ label, sublabel, width, height: 10_000 });
  const height = Math.max(72, probe.top + probe.lines.length * probe.rowHeight + 14);
  return { ...stamp("mv", now), kind: "card", x: 0, y: 0, width, height, label, sublabel, tone };
}

const obstacles = (elements: JevElement[]) =>
  elements.filter((e) => isShapeElement(e) && !isContainerKind(e.kind)).map(getElementRect);

/** First free spot right of, left of, below, then above the anchor; else further down the right side. */
function besideAnchor(anchor: Rect, box: { width: number; height: number }, taken: Rect[]): { x: number; y: number } {
  const size = { width: box.width, height: box.height };
  const free = (p: { x: number; y: number }) => !taken.some((r) => rectsOverlap({ ...p, ...size }, r, 16));
  const tries = [
    { x: anchor.x + anchor.width + GAP, y: anchor.y },
    { x: anchor.x - GAP - size.width, y: anchor.y },
    { x: anchor.x, y: anchor.y + anchor.height + GAP },
    { x: anchor.x, y: anchor.y - GAP - size.height },
  ];
  const hit = tries.find(free);
  if (hit) return hit;
  let p = tries[0];
  for (let i = 0; i < 40 && !free(p); i++) p = { x: p.x, y: p.y + 48 };
  return p;
}

function at(card: JevElement, pos: { x: number; y: number }): JevElement {
  return { ...card, x: Math.round(pos.x), y: Math.round(pos.y) };
}

function pointer(fromId: string, toId: string, now: number): JevElement {
  return {
    ...stamp("mva", now),
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    fromId,
    toId,
    label: "",
    tone: "terracotta",
    dashed: true,
    arrowStyle: "straight",
    startEnd: "none",
    endEnd: "arrow",
  };
}

/** "Breaks at 10×" beside the culprit with a dashed pointer to it; empty when nothing was found. */
export function breakCard(result: BreakResult, elements: JevElement[], now: number, source = RULE_SOURCE): JevElement[] {
  const top = result.findings[0];
  const culprit = top && elements.find((e) => e.id === top.culpritId);
  if (!top || !culprit) return [];
  const also = result.findings.find((f) => f.culpritId !== top.culpritId);
  const lines = [top.headline, `Why: ${top.why}`, ...top.fixes.map((f) => `Fix: ${f}`), ...(also ? [`Also: ${also.headline}`] : []), sourceLine(source)];
  const card = sizedCard("Breaks at 10×", lines, 300, "terracotta", now);
  const placed = at(card, besideAnchor(getElementRect(culprit), card, obstacles(elements)));
  return [placed, pointer(placed.id, culprit.id, now)];
}

/** One note per flagged step: right of a sequence diagram at the message's height, or in a row under an HLD diagram. */
export function failureNotes(result: FailureResult, elements: JevElement[], now: number, source = RULE_SOURCE): JevElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const notes: JevElement[] = [];
  const shapes = elements.filter((e) => isShapeElement(e));
  const groupId = result.source === "sequence" ? byId.get(result.flags[0]?.anchorId ?? "")?.morphMeta?.groupId : undefined;
  const bounds = computeBounds(groupId ? shapes.filter((e) => e.morphMeta?.groupId === groupId) : shapes);
  if (!bounds) return [];
  for (const flag of result.flags) {
    const anchor = byId.get(flag.anchorId);
    if (!anchor) continue;
    const label = flag.step !== undefined ? `Step ${flag.step} · ${flag.title}` : `${flag.name} · ${flag.title}`;
    const card = sizedCard(label, [...flag.lines, sourceLine(source)], 260, "terracotta", now);
    const prev = notes[notes.length - 1];
    let pos: { x: number; y: number };
    if (groupId && anchor.fromPoint) {
      const below = prev ? prev.y + prev.height + 12 : -Infinity;
      pos = { x: bounds.x + bounds.width + GAP, y: Math.max(anchor.fromPoint.y - card.height / 2, below) };
    } else {
      const { control } = resolveArrowEndpoints(anchor, byId);
      const after = prev ? prev.x + prev.width + 16 : -Infinity;
      pos = { x: Math.max(control.x - card.width / 2, after), y: bounds.y + bounds.height + GAP };
    }
    notes.push(at(card, pos));
  }
  return notes;
}

/** One card listing the mismatches, numbered to match the pins on the shapes; null when there are none. */
export function consistencyCard(result: ConsistencyResult, elements: JevElement[], now: number, source = RULE_SOURCE): JevElement | null {
  if (result.mismatches.length === 0) return null;
  const shown = result.mismatches.slice(0, MAX_CONSISTENCY_LINES).map((m, i) => `${i + 1}. ${m.text}`);
  const more = result.mismatches.length - shown.length;
  const lines = [...shown, ...(more > 0 ? [`and ${more} more`] : []), sourceLine(source)];
  const card = sizedCard("Consistency check", lines, 340, "plum", now);
  const ids = new Set(result.mismatches.flatMap((m) => m.elementIds));
  const anchor = computeBounds(elements.filter((e) => ids.has(e.id)))!;
  return at(card, besideAnchor(anchor, card, obstacles(elements)));
}
