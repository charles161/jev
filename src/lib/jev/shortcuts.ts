import type { ToolType } from "./types";

/** Single-letter tool shortcuts. The toolbar renders these keys and the keyboard handler resolves through them. */
export const TOOL_SHORTCUT_KEYS: Readonly<Record<ToolType, string>> = {
  select: "S",
  hand: "H",
  node: "R",
  diamond: "D",
  database: "O",
  ellipse: "C",
  arrow: "A",
  frame: "F",
  freedraw: "P",
  text: "T",
};

const KEY_TO_TOOL = new Map<string, ToolType>(
  (Object.entries(TOOL_SHORTCUT_KEYS) as Array<[ToolType, string]>).map(([tool, key]) => [
    key.toLowerCase(),
    tool,
  ])
);

export function toolForShortcutKey(key: string): ToolType | null {
  return KEY_TO_TOOL.get(key.toLowerCase()) ?? null;
}
