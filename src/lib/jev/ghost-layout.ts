/**
 * Layered left-to-right layout for the new nodes of a next-action option (the ghost graph). Board nodes never
 * move. Each new node hangs off one parent (a board node, or the bounds of several board nodes for a hub)
 * in the next column; siblings stack around the parent's centre, so every tree edge crosses only the empty
 * gap between two columns. Gaps widen to fit the edge labels and steep fans. A tree that would collide with
 * the board slides up or down as a block until it is clear.
 *
 * Hand-written instead of dagre/elkjs: those lay out the whole graph and route edges through waypoints,
 * while Skot's arrows are drawn boundary to boundary with one gentle bend and the board must not move.
 */
import type { Rect } from "./geometry";
import { arrowHitsShape, labelWidth, rectsIntersect } from "./ghost-geometry";
import type { JevElement, Point } from "./types";

export interface GhostNode {
  id: string;
  width: number;
  height: number;
}
export interface GhostEdge {
  from: string;
  to: string;
  label: string;
}

const GAP_Y = 44;
const MIN_GAP_X = 150;
const NODE_PAD = 28;

type ParentKey = string;

interface Tree {
  /** A board node id, or "hub:<id>" for a new node joined to several board nodes. */
  root: ParentKey;
  rootRect: Rect;
  nodes: string[];
}

export function layeredGhostLayout(params: {
  nodes: GhostNode[];
  edges: GhostEdge[];
  board: JevElement[];
  origin: Point;
}): { positions: Map<string, Point>; treeEdges: Set<string> } {
  const { nodes, edges, board, origin } = params;
  const fresh = new Map(nodes.map((n) => [n.id, n]));
  const boardShapes = board.filter((e) => e.kind !== "arrow" && e.kind !== "freedraw");
  const boardById = new Map(boardShapes.map((e) => [e.id, e]));
  const parent = new Map<string, ParentKey>();
  const hubRects = new Map<string, Rect>();
  const order: string[] = [];
  const treeEdges = new Set<string>();
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const labelBetween = (a: string, b: string) =>
    edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))?.label ?? "";

  // 1. Parents: hubs first, then breadth-first from the board, then from roots on a blank board.
  for (const n of nodes) {
    const onBoard = edges
      .filter((e) => e.from === n.id || e.to === n.id)
      .map((e) => (e.from === n.id ? e.to : e.from))
      .filter((id, i, all) => boardById.has(id) && all.indexOf(id) === i)
      .map((id) => boardById.get(id)!);
    if (onBoard.length >= 2) {
      const left = Math.min(...onBoard.map((s) => s.x));
      const top = Math.min(...onBoard.map((s) => s.y));
      const right = Math.max(...onBoard.map((s) => s.x + s.width));
      const bottom = Math.max(...onBoard.map((s) => s.y + s.height));
      hubRects.set(`hub:${n.id}`, { x: right, y: top, width: 0, height: bottom - top });
      void left;
      parent.set(n.id, `hub:${n.id}`);
      order.push(n.id);
      for (const s of onBoard) treeEdges.add(edgeKey(n.id, s.id));
    }
  }
  for (const e of edges) {
    const [b, f] = boardById.has(e.from) && fresh.has(e.to) ? [e.from, e.to] : boardById.has(e.to) && fresh.has(e.from) ? [e.to, e.from] : [null, null];
    if (b && f && !parent.has(f)) {
      parent.set(f, b);
      order.push(f);
      treeEdges.add(edgeKey(b, f));
    }
  }
  // Follow arrows forward first, so a flow reads left to right; nodes only reachable backwards come after.
  const grow = (from: number, directed: boolean) => {
    for (let i = from; i < order.length; i++) {
      const cur = order[i];
      for (const e of edges) {
        const other = e.from === cur ? e.to : !directed && e.to === cur ? e.from : null;
        if (other && fresh.has(other) && !parent.has(other)) {
          parent.set(other, cur);
          order.push(other);
          treeEdges.add(edgeKey(cur, other));
        }
      }
    }
  };
  grow(0, true);
  grow(0, false);
  const roots: string[] = [];
  const fedByFresh = (id: string) => edges.some((e) => e.to === id && fresh.has(e.from) && e.from !== id);
  while (nodes.some((n) => !parent.has(n.id))) {
    const left = nodes.filter((n) => !parent.has(n.id));
    const root = left.find((n) => !fedByFresh(n.id)) ?? left[0];
    roots.push(root.id);
    parent.set(root.id, `root:${root.id}`);
    const at = order.length;
    order.push(root.id);
    grow(at, true);
    grow(at, false);
  }

  const children = new Map<ParentKey, string[]>();
  for (const id of order) {
    const p = parent.get(id)!;
    if (p === `root:${id}`) continue;
    children.set(p, [...(children.get(p) ?? []), id]);
  }

  // 2. Sizes: a subtree is as tall as its stacked children (or the node itself).
  const heightOf = new Map<string, number>();
  const subtree = (id: string): number => {
    if (heightOf.has(id)) return heightOf.get(id)!;
    const kids = children.get(id) ?? [];
    const own = fresh.get(id)!.height;
    const stacked = kids.reduce((s, k) => s + subtree(k), 0) + GAP_Y * Math.max(0, kids.length - 1);
    const h = Math.max(own, stacked);
    heightOf.set(id, h);
    return h;
  };

  const gapFor = (p: ParentKey, kids: string[], scale: number) => {
    const pid = p.startsWith("hub:") ? p.slice(4) : p;
    const widest = Math.max(0, ...kids.map((k) => labelWidth(labelBetween(pid, k))));
    // The farthest child's centre from the parent's centre: steep fans need a wider gap, a single child none.
    const total = kids.reduce((s, k) => s + subtree(k), 0) + GAP_Y * Math.max(0, kids.length - 1);
    const spread = kids.length > 1 ? (total - subtree(kids[0])) / 2 : 0;
    return Math.round(Math.max(MIN_GAP_X, widest + 60, spread * 0.8) * scale);
  };

  // 3. Place one tree from its root rectangle.
  const placeTree = (rootKey: ParentKey, rootRect: Rect, scale: number, pos: Map<string, Point>) => {
    const placeKids = (p: ParentKey, rect: Rect) => {
      const kids = children.get(p) ?? [];
      if (kids.length === 0) return;
      const x = rect.x + rect.width + gapFor(p, kids, scale);
      const total = kids.reduce((s, k) => s + subtree(k), 0) + GAP_Y * (kids.length - 1);
      let y = rect.y + rect.height / 2 - total / 2;
      for (const k of kids) {
        const n = fresh.get(k)!;
        const h = subtree(k);
        const top = y + h / 2 - n.height / 2;
        pos.set(k, { x: Math.round(x), y: Math.round(top) });
        placeKids(k, { x, y: top, width: n.width, height: n.height });
        y += h + GAP_Y;
      }
    };
    placeKids(rootKey, rootRect);
  };

  const trees: Tree[] = [];
  const seenRoots = new Set<ParentKey>();
  for (const id of order) {
    const p = parent.get(id)!;
    const rootKey = p.startsWith("root:") ? p : p.startsWith("hub:") ? p : fresh.has(p) ? null : p;
    if (!rootKey || seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    if (rootKey.startsWith("root:")) {
      const rid = rootKey.slice(5);
      const n = fresh.get(rid)!;
      trees.push({ root: rootKey, rootRect: { x: 0, y: 0, width: n.width, height: n.height }, nodes: [] });
    } else if (rootKey.startsWith("hub:")) {
      trees.push({ root: rootKey, rootRect: hubRects.get(rootKey)!, nodes: [] });
    } else {
      const b = boardById.get(rootKey)!;
      trees.push({ root: rootKey, rootRect: { x: b.x, y: b.y, width: b.width, height: b.height }, nodes: [] });
    }
  }

  const positions = new Map<string, Point>();
  const placedRects: Rect[] = [];
  const obstacles = boardShapes.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));
  let blankRow = 0;

  for (const tree of trees) {
    const isBlankRoot = tree.root.startsWith("root:");
    const rid = isBlankRoot ? tree.root.slice(5) : null;
    const attempt = (scale: number, dy: number) => {
      const pos = new Map<string, Point>();
      if (rid) {
        const n = fresh.get(rid)!;
        const depthGuess = Math.min(3, Math.max(1, nodes.length > 1 ? 2 : 0));
        const top = { x: Math.round(origin.x - (n.width + depthGuess * 330) / 2), y: Math.round(origin.y - n.height / 2 + blankRow * 220 + dy) };
        pos.set(rid, top);
        placeTree(rid, { x: top.x, y: top.y, width: n.width, height: n.height }, scale, pos);
      } else {
        placeTree(tree.root, { ...tree.rootRect, y: tree.rootRect.y + dy }, scale, pos);
      }
      return pos;
    };
    const clean = (pos: Map<string, Point>) => {
      const rects = [...pos].map(([id, p]) => ({ id, r: { x: p.x, y: p.y, width: fresh.get(id)!.width, height: fresh.get(id)!.height } }));
      for (const { r } of rects) {
        if (obstacles.some((o) => rectsIntersect(r, o, NODE_PAD)) || placedRects.some((o) => rectsIntersect(r, o, NODE_PAD))) return false;
      }
      const temp: JevElement[] = [
        ...boardShapes,
        ...[...positions].map(([id, p]) => fakeShape(id, p, fresh.get(id)!)),
        ...rects.map(({ id }) => fakeShape(id, pos.get(id)!, fresh.get(id)!)),
      ];
      const byId = new Map(temp.map((e) => [e.id, e]));
      for (const id of pos.keys()) {
        const p = parent.get(id)!;
        const ends = p.startsWith("hub:")
          ? edges.filter((e) => (e.from === id && boardById.has(e.to)) || (e.to === id && boardById.has(e.from)))
          : p.startsWith("root:")
            ? []
            : [{ from: p, to: id, label: "" }];
        for (const e of ends) {
          const a = fakeArrow(e.from, e.to);
          if (arrowHitsShape(a, byId, temp, 6)) return false;
        }
      }
      return true;
    };
    let chosen: Map<string, Point> | null = null;
    for (const scale of [1, 1.35, 1.8]) {
      for (let k = 0; k <= 24 && !chosen; k++) {
        const dy = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 60;
        const pos = attempt(scale, dy);
        if (clean(pos)) chosen = pos;
      }
      if (chosen) break;
    }
    const final = chosen ?? attempt(1, 0);
    for (const [id, p] of final) {
      positions.set(id, p);
      placedRects.push({ x: p.x, y: p.y, width: fresh.get(id)!.width, height: fresh.get(id)!.height });
    }
    if (isBlankRoot) blankRow += 1;
  }

  return { positions, treeEdges };
}

function fakeShape(id: string, p: Point, n: GhostNode): JevElement {
  return { id, kind: "node", x: p.x, y: p.y, width: n.width, height: n.height, label: id, tone: "ink", seed: 0, createdAt: 0, updatedAt: 0 };
}

function fakeArrow(from: string, to: string): JevElement {
  return {
    id: `fa_${from}_${to}`,
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "",
    tone: "ink",
    seed: 0,
    fromId: from,
    toId: to,
    arrowStyle: "curved",
    createdAt: 0,
    updatedAt: 0,
  };
}
