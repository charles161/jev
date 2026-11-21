import { describe, expect, it } from "vitest";
import { BoardHistoryController } from "@/lib/jev/board-history";
import { applyLocalElementsChange, mergeRemoteBoardState } from "@/lib/jev/board-sync";
import {
  beginLabelEdit,
  cancelLabelEdit,
  commitLabelEdit,
  createTextAt,
  editKeyAction,
  isMultilineField,
  pickEditField,
} from "@/lib/jev/inline-edit";
import type { JevElement } from "@/lib/jev/types";

function node(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: "n1",
    kind: "node",
    x: 100,
    y: 100,
    width: 172,
    height: 72,
    label: "Orders API",
    sublabel: "REST / gRPC",
    tone: "cobalt",
    seed: 1,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 2,
    ...overrides,
  };
}

describe("inline label editing (double-click, Excalidraw-style)", () => {
  it("double-click on the lower sublabel line edits the sublabel, anywhere else edits the title", () => {
    const el = node();
    expect(pickEditField(el, { x: 186, y: 125 })).toBe("label");
    expect(pickEditField(el, { x: 186, y: 152 })).toBe("sublabel");
    expect(pickEditField(node({ sublabel: undefined }), { x: 186, y: 152 })).toBe("label");
    expect(pickEditField(node({ kind: "arrow" }), { x: 0, y: 0 })).toBe("label");
  });

  it("begin seeds the draft from the chosen field; freedraw is not editable", () => {
    expect(beginLabelEdit(node(), "label")).toEqual({ id: "n1", field: "label", draft: "Orders API", createdForEdit: false });
    expect(beginLabelEdit(node(), "sublabel")?.draft).toBe("REST / gRPC");
    expect(beginLabelEdit(node({ kind: "freedraw" }), "label")).toBeNull();
  });

  it("Enter commits, Shift+Enter does not, Esc cancels, other keys are typing", () => {
    expect(editKeyAction({ key: "Enter", shiftKey: false })).toBe("commit");
    expect(editKeyAction({ key: "Enter", shiftKey: true })).toBe("type");
    expect(editKeyAction({ key: "Escape", shiftKey: false })).toBe("cancel");
    expect(editKeyAction({ key: "a", shiftKey: false })).toBe("type");
  });

  it("commit writes the trimmed draft into the field; empty title falls back, empty sublabel is removed", () => {
    const board = [node()];
    const s = beginLabelEdit(board[0], "label")!;
    expect(commitLabelEdit(board, { ...s, draft: "  Checkout API " }, 5000)[0]).toMatchObject({
      label: "Checkout API",
      updatedAt: 5000,
    });
    expect(commitLabelEdit(board, { ...s, draft: "   " }, 5000)[0].label).toBe("Orders API");
    const sub = beginLabelEdit(board[0], "sublabel")!;
    expect(commitLabelEdit(board, { ...sub, draft: "" }, 5000)[0].sublabel).toBeUndefined();
  });

  it("an unchanged draft is a no-op (returns the same array, so no undo step or broadcast)", () => {
    const board = [node()];
    const s = beginLabelEdit(board[0], "label")!;
    expect(commitLabelEdit(board, s, 5000)).toBe(board);
  });

  it("Esc cancels: the label is untouched", () => {
    const board = [node()];
    const s = beginLabelEdit(board[0], "label")!;
    expect(cancelLabelEdit(board, { ...s, draft: "typo" })).toBe(board);
  });

  it("double-click on empty canvas creates a text element centred at the point, editing an empty draft", () => {
    const { element, session } = createTextAt({ x: 400, y: 300 }, 7000, "txt_1");
    expect(element).toMatchObject({ id: "txt_1", kind: "text", label: "" });
    expect(element.x + element.width / 2).toBe(400);
    expect(element.y + element.height / 2).toBe(300);
    expect(session).toEqual({ id: "txt_1", field: "label", draft: "", createdForEdit: true });
  });

  it("a new text element committed empty, or cancelled, is removed (no blank litter)", () => {
    const { element, session } = createTextAt({ x: 0, y: 0 }, 7000, "txt_1");
    const board = [node(), element];
    expect(commitLabelEdit(board, session, 8000).map((e) => e.id)).toEqual(["n1"]);
    expect(cancelLabelEdit(board, { ...session, draft: "half typed" }).map((e) => e.id)).toEqual(["n1"]);
    expect(commitLabelEdit(board, { ...session, draft: "Hello" }, 8000)[1].label).toBe("Hello");
  });

  it("undo reverts a committed edit in one step", () => {
    const board = [node()];
    const history = new BoardHistoryController(board);
    const s = beginLabelEdit(board[0], "label")!;
    const edited = commitLabelEdit(board, { ...s, draft: "Checkout API" }, 5000);
    const stamped = applyLocalElementsChange(board, edited, {}, "peer_a", 5000, 0);
    history.commitLocal(stamped.elements, { recordUndo: true });
    expect(history.undo()![0].label).toBe("Orders API");
  });

  it("the committed edit syncs to a peer (rev bumps and the peer merge adopts the new label)", () => {
    const board = [node()];
    const s = beginLabelEdit(board[0], "label")!;
    const edited = commitLabelEdit(board, { ...s, draft: "Checkout API" }, 5000);
    const stamped = applyLocalElementsChange(board, edited, {}, "peer_a", 5000, 0);
    expect(stamped.elements[0].rev).toBeGreaterThan(2);
    const merged = mergeRemoteBoardState(
      { elements: board, boardTitle: "B", tombstones: {}, hasLocalEdits: true },
      {
        elements: stamped.elements,
        boardTitle: "B",
        tombstones: stamped.tombstones,
        hasLocalEdits: true,
        senderPeerId: "peer_a",
      },
      "peer_b"
    );
    expect(merged.state.elements[0].label).toBe("Checkout API");
  });
});

describe("multi-line sublabels: ER rows, class compartments, fragment guards", () => {
  const entity = (overrides: Partial<JevElement> = {}) =>
    node({ kind: "entity", width: 200, height: 136, label: "users", sublabel: "id uuid PK\nemail text UK", ...overrides });

  it("entity, class and fragment sublabels edit as multi-line text; every other field is single-line", () => {
    expect(isMultilineField("entity", "sublabel")).toBe(true);
    expect(isMultilineField("class", "sublabel")).toBe(true);
    expect(isMultilineField("fragment", "sublabel")).toBe(true);
    expect(isMultilineField("entity", "label")).toBe(false);
    expect(isMultilineField("node", "sublabel")).toBe(false);
    expect(isMultilineField("arrow", "label")).toBe(false);
  });

  it("double-click in the header band edits the name; anywhere below edits the rows, even when there are none yet", () => {
    expect(pickEditField(entity(), { x: 150, y: 112 })).toBe("label");
    expect(pickEditField(entity(), { x: 150, y: 150 })).toBe("sublabel");
    expect(pickEditField(entity({ sublabel: undefined }), { x: 150, y: 150 })).toBe("sublabel");
    expect(pickEditField(node({ kind: "class", height: 148, sublabel: undefined }), { x: 150, y: 200 })).toBe("sublabel");
  });

  it("Shift+Enter in a multi-line field types a new row; Enter still commits", () => {
    expect(editKeyAction({ key: "Enter", shiftKey: true })).toBe("type");
    expect(editKeyAction({ key: "Enter", shiftKey: false })).toBe("commit");
  });

  it("commit keeps every row, trims trailing spaces per row and drops blank rows at the ends", () => {
    const board = [entity()];
    const s = beginLabelEdit(board[0], "sublabel")!;
    expect(s.draft).toBe("id uuid PK\nemail text UK");
    const next = commitLabelEdit(
      board,
      { ...s, draft: "\nid uuid PK  \nemail text UK\nuser_id uuid FK   \n\n" },
      5000
    );
    expect(next[0].sublabel).toBe("id uuid PK\nemail text UK\nuser_id uuid FK");
  });

  it("keeps the class `--` separator and blank-free compartments intact", () => {
    const cls = node({ kind: "class", label: "Order", sublabel: "- id: UUID" });
    const s = beginLabelEdit(cls, "sublabel")!;
    const next = commitLabelEdit([cls], { ...s, draft: "- id: UUID\n--\n+ pay(): Receipt" }, 5000);
    expect(next[0].sublabel).toBe("- id: UUID\n--\n+ pay(): Receipt");
  });
});

describe("API and note cards edit their rows in the multi-line editor", () => {
  it.each(["api", "card"] as const)("%s sublabel is multi-line", (kind) => {
    expect(isMultilineField(kind, "sublabel")).toBe(true);
    expect(isMultilineField(kind, "label")).toBe(false);
  });
});
