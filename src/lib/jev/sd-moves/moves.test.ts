import { describe, expect, it } from "vitest";
import { PALETTE_COMMANDS } from "../notation-packs";
import { board } from "./__fixtures__/boards";
import { estimateText, matchMoveCommands, MOVE_COMMANDS, MOVES, parseMoveCommand, quietReason } from "./moves";

describe("move registry and / commands", () => {
  it("lists the seven Sensei moves, each with a slash command", () => {
    expect(MOVES.map((m) => m.command)).toEqual(["break", "trace", "estimate", "schema", "failure", "transitions", "consistency"]);
  });

  it("/estimate stays the palette's command: moves add only the six new ones, none clashing", () => {
    expect(MOVE_COMMANDS.map((m) => m.command)).toEqual(["break", "trace", "schema", "failure", "transitions", "consistency"]);
    const palette = new Set(PALETTE_COMMANDS.map((c) => c.command as string));
    expect(MOVE_COMMANDS.filter((m) => palette.has(m.command))).toEqual([]);
    expect(palette.has("estimate")).toBe(true);
  });

  it("parses /trace write and /break, and ignores other text", () => {
    expect(parseMoveCommand("/trace write")).toEqual({ move: "trace", args: "write" });
    expect(parseMoveCommand(" /BREAK ")).toEqual({ move: "break", args: "" });
    expect(parseMoveCommand("/estimate 1M DAU")).toBeNull();
    expect(parseMoveCommand("break the db")).toBeNull();
  });

  it("matches by prefix", () => {
    expect(matchMoveCommands("/tr").map((m) => m.command)).toEqual(["trace", "transitions"]);
    expect(matchMoveCommands("/").length).toBe(6);
    expect(matchMoveCommands("hello")).toEqual([]);
  });
});

describe("estimateText: the DAU stated on the selection", () => {
  it("reads a selected card or note that states a DAU", () => {
    const b = board().shape("card", "Requirements", { id: "c", sublabel: "50M DAU\n10 writes/user/day\n1KB per post" });
    expect(estimateText(b.els, ["c"])).toContain("50M DAU");
  });

  it("is null when the selection states no DAU, so the user is asked", () => {
    const b = board().shape("node", "API", { id: "n" });
    expect(estimateText(b.els, ["n"])).toBeNull();
    expect(estimateText(b.els, [])).toBeNull();
  });
});

describe("practice mode (aiQuiet)", () => {
  it("keeps every critique move quiet; trace and estimate only show the learner's own board", () => {
    const quiet = MOVES.filter((m) => quietReason(m.id, true)).map((m) => m.id);
    expect(quiet).toEqual(["break", "schema", "failure", "transitions", "consistency"]);
    expect(MOVES.filter((m) => quietReason(m.id, false))).toEqual([]);
  });
});
