import { z } from "zod";
import type { JevElement } from "../types";
import { buildHldGraph } from "./board";

/** Moves whose card text the AI may rewrite. The others are exact name or graph checks with nothing to add. */
export const ENRICHABLE_MOVES = ["break", "failure"] as const;
export type EnrichableMove = (typeof ENRICHABLE_MOVES)[number];

export interface MoveFinding {
  id: string;
  title: string;
  lines: string[];
}

const findingSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(80),
    lines: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
  })
  .strict();

const digestSchema = z
  .object({
    nodes: z.array(z.object({ id: z.string().max(96), label: z.string().max(120), kind: z.string().max(24) }).strict()).max(64),
    edges: z.array(z.object({ from: z.string().max(96), to: z.string().max(96), label: z.string().max(120) }).strict()).max(96),
  })
  .strict();

export const enrichRequestSchema = z
  .object({
    move: z.enum(ENRICHABLE_MOVES),
    findings: z.array(findingSchema).min(1).max(8),
    board: digestSchema,
  })
  .strict();
export type EnrichRequest = z.infer<typeof enrichRequestSchema>;

const llmOutputSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string().trim().min(1).max(80),
      lines: z.array(z.string().trim().min(1).max(160)).min(1).max(4),
    })
  ),
});

/**
 * Validates AI output against the rule findings: a rewrite is kept only for an id the rules produced, so the AI
 * can sharpen wording but never add or drop a problem. Null when no rewrite survives.
 */
export function mergeEnriched(rule: MoveFinding[], output: unknown): MoveFinding[] | null {
  const parsed = llmOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  const byId = new Map(parsed.data.findings.map((f) => [f.id, f]));
  let used = 0;
  const merged = rule.map((f) => {
    const ai = byId.get(f.id);
    if (!ai) return f;
    used += 1;
    return { id: f.id, title: ai.title, lines: ai.lines };
  });
  return used > 0 ? merged : null;
}

/** What the AI sees of the board: component labels, kinds and arrows. */
export function boardDigest(elements: JevElement[]): z.infer<typeof digestSchema> {
  const g = buildHldGraph(elements);
  const seen = new Set<string>();
  return {
    nodes: [...g.nodes.values()].slice(0, 64).map((n) => ({ id: n.id, label: n.label.slice(0, 120), kind: n.el.kind })),
    edges: g.edges
      .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
      .slice(0, 96)
      .map((e) => ({ from: e.from, to: e.to, label: e.label.slice(0, 120) })),
  };
}
