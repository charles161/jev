import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArrowEndMenu, ARROW_END_GLYPHS } from "@/components/jev/ArrowEndPicker";
import { KIND_SWAP_GROUPS, MORE_SHAPE_ICONS, MoreShapesButton, MoreShapesPanel } from "@/components/jev/MoreShapesMenu";
import { SelectionInspector } from "@/components/jev/SelectionInspector";
import { ARROW_END_LABELS } from "@/lib/jev/arrow-end-options";
import { KIND_LABELS } from "@/lib/jev/notation-kinds";
import { MORE_SHAPE_GROUPS } from "@/lib/jev/shape-tools";
import { ARROW_ENDS, HLD_SHAPE_KINDS, LLD_SHAPE_KINDS, type JevElement } from "@/lib/jev/types";

type Props = { onClick?: () => void; "aria-label"?: string; "aria-pressed"?: boolean; children?: ReactNode };

/** Host <button> elements in a hook-free component's output, in document order. */
function buttons(node: ReactNode): ReactElement<Props>[] {
  const out: ReactElement<Props>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement<Props>(n)) return;
    if (n.type === "button") out.push(n);
    walk(n.props.children);
  };
  walk(node);
  return out;
}

describe("More shapes panel", () => {
  it("renders both groups with a heading and one labelled button per kind", () => {
    const html = renderToStaticMarkup(<MoreShapesPanel groups={MORE_SHAPE_GROUPS} onPick={() => {}} />);
    expect(html).toContain("System design");
    expect(html).toContain("LLD notation");
    for (const kind of [...HLD_SHAPE_KINDS, ...LLD_SHAPE_KINDS]) {
      expect(html).toContain(`aria-label="${KIND_LABELS[kind]}"`);
    }
  });

  it("each entry picks its own kind", () => {
    const onPick = vi.fn();
    const list = buttons(MoreShapesPanel({ groups: MORE_SHAPE_GROUPS, onPick }));
    expect(list).toHaveLength(HLD_SHAPE_KINDS.length + LLD_SHAPE_KINDS.length);
    list.forEach((b) => b.props.onClick?.());
    expect(onPick.mock.calls.map((c) => c[0])).toEqual([...HLD_SHAPE_KINDS, ...LLD_SHAPE_KINDS]);
  });

  it("marks the active kind as pressed", () => {
    const list = buttons(MoreShapesPanel({ groups: MORE_SHAPE_GROUPS, activeKind: "cache", onPick: () => {} }));
    expect(list.filter((b) => b.props["aria-pressed"]).map((b) => b.props["aria-label"])).toEqual([KIND_LABELS.cache]);
  });

  it("has a distinct custom icon for every flyout kind", () => {
    const kinds = [...HLD_SHAPE_KINDS, ...LLD_SHAPE_KINDS];
    const icons = kinds.map((k) => MORE_SHAPE_ICONS[k]);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(kinds.length);
  });

  it("the dock trigger is labelled, and names the armed kind while a flyout tool is active", () => {
    const idle = renderToStaticMarkup(<MoreShapesButton tool="select" onPick={() => {}} />);
    expect(idle).toContain('aria-label="More shapes"');
    expect(idle).toContain('aria-pressed="false"');
    const armed = renderToStaticMarkup(<MoreShapesButton tool="entity" onPick={() => {}} />);
    expect(armed).toContain('aria-label="More shapes (ER entity)"');
    expect(armed).toContain('aria-pressed="true"');
  });

  it("kind swap offers box-like kinds only (no containers, bars or pseudo-states)", () => {
    const kinds = KIND_SWAP_GROUPS.flatMap((g) => g.kinds);
    expect(kinds).toEqual(["queue", "cache", "lb", "blob", "external", "actor", "entity", "class"]);
  });
});

describe("Arrow end menu", () => {
  it("lists every end with its name and a glyph", () => {
    const html = renderToStaticMarkup(<ArrowEndMenu value="arrow" onPick={() => {}} />);
    for (const end of ARROW_ENDS) expect(html).toContain(`aria-label="${ARROW_END_LABELS[end]}"`);
    expect(Object.keys(ARROW_END_GLYPHS).sort()).toEqual([...ARROW_ENDS].sort());
    expect(new Set(Object.values(ARROW_END_GLYPHS)).size).toBe(ARROW_ENDS.length);
  });

  it("picking an entry reports that end, and the current one is pressed", () => {
    const onPick = vi.fn();
    const list = buttons(ArrowEndMenu({ value: "er_many", onPick }));
    list.forEach((b) => b.props.onClick?.());
    expect([...onPick.mock.calls.map((c) => c[0])].sort()).toEqual([...ARROW_ENDS].sort());
    expect(list.filter((b) => b.props["aria-pressed"]).map((b) => b.props["aria-label"])).toEqual(["Many"]);
  });
});

function el(overrides: Partial<JevElement>): JevElement {
  return {
    id: "e1",
    kind: "node",
    x: 400,
    y: 300,
    width: 200,
    height: 136,
    label: "users",
    tone: "ink",
    seed: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const renderInspector = (element: JevElement, all: JevElement[] = [element]) =>
  renderToStaticMarkup(
    <SelectionInspector
      element={element}
      allElements={all}
      ghostElements={[]}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      theme="midnight"
      hasPredictionHud={false}
      onPatch={() => {}}
      onStartInlineEdit={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
    />
  );

describe("Selection inspector", () => {
  it("shows Start end / End end pickers for an arrow, naming the resolved ends", () => {
    const a = el({ id: "a1", kind: "arrow", label: "", fromId: "n1", toId: "n2", startEnd: "er_only_one" });
    const html = renderInspector(a, [el({ id: "n1", x: 100 }), el({ id: "n2", x: 600 }), a]);
    expect(html).toContain('aria-label="Start end: Only one"');
    expect(html).toContain('aria-label="End end: Arrow"');
  });

  it("offers the full kind swap on new kinds too", () => {
    const html = renderInspector(el({ kind: "queue", label: "Queue" }));
    expect(html).toContain('aria-label="Shape: Box"');
    expect(html).toContain('aria-label="More shape types"');
  });

  it("entity, class and fragment get a rows editor button; bars and pseudo-states get no text edit", () => {
    expect(renderInspector(el({ kind: "entity" }))).toMatch(/aria-label="Edit rows"[^>]*>Rows</);
    expect(renderInspector(el({ kind: "class", label: "Order" }))).toContain('aria-label="Edit members"');
    expect(renderInspector(el({ kind: "fragment", label: "alt" }))).toContain('aria-label="Edit guards"');
    for (const kind of ["activation", "initial", "final"] as const) {
      const html = renderInspector(el({ kind, label: "", width: 30, height: 30 }));
      expect(html).not.toContain("Edit label in place");
      expect(html).not.toContain('aria-label="More shape types"');
    }
  });
});
