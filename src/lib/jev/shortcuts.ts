import type { HLD_SHAPE_KINDS, LLD_SHAPE_KINDS, ToolType } from "./types";

export type DockTool = Exclude<ToolType, (typeof HLD_SHAPE_KINDS)[number] | (typeof LLD_SHAPE_KINDS)[number]>;

/** Single-letter tool shortcuts for the dock. Flyout kinds have no key. */
export const TOOL_SHORTCUT_KEYS: Readonly<Record<DockTool, string>> = {
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

const KEY_TO_TOOL = new Map<string, DockTool>(
  (Object.entries(TOOL_SHORTCUT_KEYS) as Array<[DockTool, string]>).map(([tool, key]) => [
    key.toLowerCase(),
    tool,
  ])
);

export function toolForShortcutKey(key: string): ToolType | null {
  return KEY_TO_TOOL.get(key.toLowerCase()) ?? null;
}
