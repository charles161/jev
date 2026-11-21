import { makeSeed } from "./geometry";
import type { JevElement, Point } from "./types";

/**
 * Clones `sources` with new ids, offset by `offset`. Arrows whose endpoints were duplicated too are
 * rebound to the clones; free arrow points and ink points move with the offset.
 */
export function duplicateElements(
  sources: JevElement[],
  makeId: (src: JevElement) => string,
  offset: Point,
  now: number
): JevElement[] {
  const idMap = new Map(sources.map((src) => [src.id, makeId(src)]));
  const shift = (p: Point) => ({ x: p.x + offset.x, y: p.y + offset.y });
  return sources.map((src) => {
    const id = idMap.get(src.id)!;
    const clone: JevElement = {
      ...src,
      id,
      x: src.x + offset.x,
      y: src.y + offset.y,
      seed: makeSeed(id),
      createdAt: now,
      updatedAt: now,
    };
    if (src.kind === "arrow") {
      if (src.fromId) clone.fromId = idMap.get(src.fromId) ?? src.fromId;
      if (src.toId) clone.toId = idMap.get(src.toId) ?? src.toId;
      if (src.fromPoint) clone.fromPoint = shift(src.fromPoint);
      if (src.toPoint) clone.toPoint = shift(src.toPoint);
    }
    if (src.points) clone.points = src.points.map(shift);
    return clone;
  });
}
