import { inferShapeKindFromLabel, isShapeKind } from "../notation-kinds";
import type { JevElement } from "../types";

export type ComponentRole = "client" | "lb" | "service" | "db" | "replica" | "cache" | "queue" | "blob" | "external";

export interface MoveNode {
  id: string;
  label: string;
  role: ComponentRole;
  el: JevElement;
}

export interface MoveEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  async: boolean;
  el: JevElement;
}

export interface MoveGraph {
  nodes: Map<string, MoveNode>;
  edges: MoveEdge[];
  out: (id: string) => MoveEdge[];
  in: (id: string) => MoveEdge[];
}

/** Notes, notation boxes and containers: never components on the request path. */
const NON_COMPONENT_KINDS = new Set([
  "frame",
  "zone",
  "fragment",
  "text",
  "card",
  "api",
  "activation",
  "initial",
  "final",
  "entity",
  "class",
]);

const REPLICA_RE = /\b(replica|replicas|follower|read[- ]only|secondary)\b/i;
const ASYNC_RE = /\b(async|publish|publishes|emit|emits|enqueue|enqueues|event|events|fire[- ]and[- ]forget|webhook|notify)\b/i;

export function displayName(el: JevElement): string {
  return el.label.split("\n").map((l) => l.trim()).filter((l) => l && !/^(«.*»|<<.*>>)$/.test(l)).join(" ") || el.kind;
}

export function componentRole(el: JevElement): ComponentRole {
  const label = displayName(el);
  const inferred = el.kind === "node" || el.kind === "diamond" ? inferShapeKindFromLabel(label) : el.kind;
  switch (inferred) {
    case "database":
      return REPLICA_RE.test(label) ? "replica" : "db";
    case "cache":
    case "queue":
    case "lb":
    case "blob":
    case "external":
      return inferred;
    case "actor":
    case "ellipse":
      return "client";
    default:
      return "service";
  }
}

function isComponent(el: JevElement): boolean {
  if (!isShapeKind(el.kind) || NON_COMPONENT_KINDS.has(el.kind)) return false;
  const notation = el.morphMeta?.notation;
  return !notation || notation === "sketch";
}

/** The HLD component graph: shapes that can sit on a request path, and the arrows joining two of them. */
export function buildHldGraph(elements: JevElement[]): MoveGraph {
  const nodes = new Map<string, MoveNode>();
  for (const el of elements) {
    if (isComponent(el)) nodes.set(el.id, { id: el.id, label: displayName(el), role: componentRole(el), el });
  }
  const edges: MoveEdge[] = [];
  for (const el of elements) {
    if (el.kind !== "arrow" || !el.fromId || !el.toId || el.fromId === el.toId) continue;
    if (!nodes.has(el.fromId) || !nodes.has(el.toId)) continue;
    const label = el.label.trim();
    const async = Boolean(el.dashed) || el.endEnd === "open" || ASYNC_RE.test(label) || nodes.get(el.toId)!.role === "queue";
    edges.push({ id: el.id, from: el.fromId, to: el.toId, label, async, el });
    if (el.bidirectional) edges.push({ id: el.id, from: el.toId, to: el.fromId, label, async, el });
  }
  const outMap = new Map<string, MoveEdge[]>();
  const inMap = new Map<string, MoveEdge[]>();
  for (const e of edges) {
    outMap.set(e.from, [...(outMap.get(e.from) ?? []), e]);
    inMap.set(e.to, [...(inMap.get(e.to) ?? []), e]);
  }
  return { nodes, edges, out: (id) => outMap.get(id) ?? [], in: (id) => inMap.get(id) ?? [] };
}

/** Neighbours of a node over arrows in either direction. */
export function neighbours(g: MoveGraph, id: string): MoveNode[] {
  const ids = new Set([...g.out(id).map((e) => e.to), ...g.in(id).map((e) => e.from)]);
  return [...ids].map((n) => g.nodes.get(n)!);
}

/** "couponCode", "- total_cents: int", "Coupon-Code" → snake_case field name. */
export function fieldKey(raw: string): string {
  const name = raw
    .trim()
    .replace(/^[+\-#~]\s*/, "")
    .split(/[:\s(]/)[0];
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function singular(word: string): string {
  if (/(ss|us|is)$/.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Class "OrderItem", table "order_items" and path "/order-items" share the key "order_item". */
export function entityKey(raw: string): string {
  const snake = fieldKey(raw);
  const parts = snake.split("_");
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return parts.join("_");
}
