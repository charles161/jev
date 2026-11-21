import { buildHldGraph, type ComponentRole, type MoveEdge, type MoveGraph } from "./board";
import type { JevElement } from "../types";

export type TracePath = "read" | "write";

export interface TraceStep {
  n: number;
  edgeId: string;
  fromId: string;
  toId: string;
  label: string;
}

export interface TraceResult {
  path: TracePath;
  startId: string | null;
  steps: TraceStep[];
  /** Why there is nothing to trace; set only when `steps` is empty. */
  reason?: string;
}

const WRITE_RE =
  /\b(write|writes|post|put|patch|delete|insert|create|update|save|store|persist|publish|enqueue|emit|produce|upload|send|charge|pay|set|incr)\b/i;
const READ_RE = /\b(read|reads|get|fetch|query|lookup|load|list|search|view|serve|hit|miss|select)\b/i;

const ROLE_SCORE: Record<TracePath, Partial<Record<ComponentRole, number>>> = {
  read: { cache: 3, replica: 3, db: 1, blob: 1, queue: -3, external: -1 },
  write: { queue: 2, db: 2, blob: 1, cache: -2, replica: -4 },
};
const STORES = new Set<ComponentRole>(["db", "replica", "blob"]);
const MAX_STEPS = 16;

function reachesStore(g: MoveGraph, from: string): boolean {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id !== from && STORES.has(g.nodes.get(id)!.role)) return true;
    for (const e of g.out(id)) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return false;
}

function edgeScore(g: MoveGraph, e: MoveEdge, path: TracePath): number {
  const wantRe = path === "read" ? READ_RE : WRITE_RE;
  const avoidRe = path === "read" ? WRITE_RE : READ_RE;
  let score = 0;
  if (wantRe.test(e.label)) score += 4;
  else if (avoidRe.test(e.label)) score -= 4;
  const role = g.nodes.get(e.to)!.role;
  score += ROLE_SCORE[path][role] ?? 0;
  if (!STORES.has(role) && reachesStore(g, e.to)) score += 1;
  return score;
}

function defaultStart(g: MoveGraph): string | null {
  const nodes = [...g.nodes.values()];
  const client = nodes.find((n) => n.role === "client" && g.out(n.id).length > 0);
  if (client) return client.id;
  const source = nodes.find((n) => g.in(n.id).length === 0 && g.out(n.id).length > 0);
  return source?.id ?? nodes.find((n) => g.out(n.id).length > 0)?.id ?? null;
}

/** Walks the read or write path from a start node (or the client) along the arrows, best-matching edge first. */
export function traceRequest(elements: JevElement[], opts: { path: TracePath; startId?: string | null }): TraceResult {
  const g = buildHldGraph(elements);
  const startId = opts.startId && g.out(opts.startId).length > 0 ? opts.startId : defaultStart(g);
  if (!startId) {
    return { path: opts.path, startId: null, steps: [], reason: "Connect components with arrows first, then trace a request." };
  }
  const steps: TraceStep[] = [];
  const visited = new Set([startId]);
  let at = startId;
  while (steps.length < MAX_STEPS) {
    const options = g.out(at).filter((e) => !visited.has(e.to));
    if (options.length === 0) break;
    const best = options.reduce((a, b) => (edgeScore(g, b, opts.path) > edgeScore(g, a, opts.path) ? b : a));
    steps.push({ n: steps.length + 1, edgeId: best.id, fromId: best.from, toId: best.to, label: best.label });
    visited.add(best.to);
    at = best.to;
    if (STORES.has(g.nodes.get(at)!.role)) break;
  }
  if (steps.length === 0) {
    return { path: opts.path, startId, steps, reason: `No arrows leave ${g.nodes.get(startId)!.label}: connect it to trace a request.` };
  }
  return { path: opts.path, startId, steps };
}
