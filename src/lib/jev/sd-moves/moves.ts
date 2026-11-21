import { parseEstimateText } from "../sd-estimate";
import type { JevElement } from "../types";

export const MOVE_IDS = ["break", "trace", "estimate", "schema", "failure", "transitions", "consistency"] as const;
export type MoveId = (typeof MOVE_IDS)[number];

export interface MoveDef {
  id: MoveId;
  command: MoveId;
  title: string;
  hint: string;
}

export const MOVES: readonly MoveDef[] = [
  { id: "break", command: "break", title: "Where does this break at 10×?", hint: "Names the bottleneck on the board and pins 1-3 fixes beside it." },
  { id: "trace", command: "trace", title: "Trace request", hint: "Animates the read or write path along the arrows. Esc stops." },
  { id: "estimate", command: "estimate", title: "Estimate", hint: "Numbers card from a stated DAU: QPS, storage, bandwidth." },
  { id: "schema", command: "schema", title: "API → schema", hint: "ER entities with PK/FK rows from an API card." },
  { id: "failure", command: "failure", title: "Find the failure step", hint: "Where a retry, timeout or idempotency key is needed." },
  { id: "transitions", command: "transitions", title: "Missing transitions", hint: "Cancel, timeout, retry, refund on a state diagram, as ghosts." },
  { id: "consistency", command: "consistency", title: "Consistency check", hint: "Class, API and table that disagree, pinned on the shapes." },
];

/** `/estimate` is already a palette command, so the moves add the other six. */
export const MOVE_COMMANDS: readonly MoveDef[] = MOVES.filter((m) => m.id !== "estimate");
const COMMAND_SET = new Set<string>(MOVE_COMMANDS.map((m) => m.command));

/** Moves that critique or draw part of the answer; practice mode keeps them quiet until Review. */
const AI_MOVES: ReadonlySet<MoveId> = new Set<MoveId>(["break", "schema", "failure", "transitions", "consistency"]);

/** Why a move may not run now (practice mode), or null when it may. */
export function quietReason(move: MoveId, aiQuiet: boolean): string | null {
  return aiQuiet && AI_MOVES.has(move) ? "Moves stay quiet while you practise: draw first, then press Review." : null;
}

export function parseMoveCommand(text: string): { move: MoveId; args: string } | null {
  const m = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (!m || !COMMAND_SET.has(m[1].toLowerCase())) return null;
  return { move: m[1].toLowerCase() as MoveId, args: (m[2] ?? "").trim() };
}

export function matchMoveCommands(text: string): MoveDef[] {
  const m = text.trimStart().match(/^\/([a-z]*)/i);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return MOVE_COMMANDS.filter((c) => c.command.startsWith(prefix));
}

/** The text of the selected shapes when it states a DAU, for the estimator; null means ask the user. */
export function estimateText(elements: JevElement[], selectedIds: string[]): string | null {
  const selected = new Set(selectedIds);
  const text = elements
    .filter((e) => selected.has(e.id) && e.kind !== "arrow")
    .map((e) => [e.label, e.sublabel ?? ""].join(" "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return parseEstimateText(text).assumed.includes("dau") ? null : text;
}
