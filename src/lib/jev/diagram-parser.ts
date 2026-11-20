import {
  buildLocalSemanticGraphFromPrompt,
  layoutSemanticGraphToElements,
  type SemanticGraph,
  type SemanticPatternHint,
} from "./semantic-graph";
import { JevElement } from "./types";

export type DiagramPatternHint = SemanticPatternHint;

/**
 * Turns any validated SemanticGraph into fully laid-out, collision-free JevElements
 * positioned neatly relative to existing elements on the canvas.
 */
export function layoutGraphToPromptElements(
  graph: SemanticGraph,
  existingElements: JevElement[],
  anchorCenter?: { x: number; y: number }
): { elements: JevElement[]; summary: string; focusId?: string } {
  const laidOut = layoutSemanticGraphToElements(graph, {
    anchorCenter,
    existingElements,
  });
  return {
    elements: laidOut.elements,
    summary: laidOut.summary,
    focusId: laidOut.focusId,
  };
}

/**
 * Turns any prompt string into fully laid-out, collision-free JevElements
 * through the validated SemanticGraph pipeline.
 */
export function parsePromptToElements(
  prompt: string,
  existingElements: JevElement[],
  anchorCenter?: { x: number; y: number },
  patternHint?: DiagramPatternHint | null
): {
  elements: JevElement[];
  summary: string;
  focusId?: string;
  graph?: SemanticGraph;
  isHeuristic?: boolean;
} {
  const trimmed = prompt.trim();
  if (!trimmed) return { elements: [], summary: "" };

  const local = buildLocalSemanticGraphFromPrompt(trimmed, patternHint);
  const laidOut = layoutSemanticGraphToElements(local.graph, {
    anchorCenter,
    existingElements,
  });

  return {
    elements: laidOut.elements,
    summary: laidOut.summary,
    focusId: laidOut.focusId,
    graph: local.graph,
    isHeuristic: local.isHeuristic,
  };
}
