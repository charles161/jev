"use client";

import { editKeyAction, headerBandHeight } from "@/lib/jev/inline-edit";
import type { JevElement, Viewport } from "@/lib/jev/types";

interface MultilineSublabelEditorProps {
  element: JevElement;
  viewport: Viewport;
  draft: string;
  textColor: string;
  onChange: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

const ROW_EDIT_LABEL: Partial<Record<JevElement["kind"], string>> = {
  entity: "Edit entity rows",
  class: "Edit class members",
  fragment: "Edit fragment guards",
};

/** In-place textarea over the body of an ER entity, UML class or fragment: one line per row. */
export function MultilineSublabelEditor({
  element,
  viewport,
  draft,
  textColor,
  onChange,
  onCommit,
  onCancel,
}: MultilineSublabelEditorProps) {
  const { zoom } = viewport;
  const header = headerBandHeight(element);
  const lineCount = Math.max(2, draft.split("\n").length + 1);
  const fontSize = Math.max(11, Math.round(12 * zoom));
  const bodyHeight = (element.height - header - 6) * zoom;
  return (
    <div
      className="absolute z-30"
      style={{
        left: viewport.x + (element.x + 6) * zoom,
        top: viewport.y + (element.y + header + 2) * zoom,
        width: Math.max(140, (element.width - 12) * zoom),
      }}
    >
      <textarea
        key={`${element.id}:sublabel`}
        autoFocus
        aria-label={ROW_EDIT_LABEL[element.kind] ?? "Edit element sublabel"}
        value={draft}
        rows={lineCount}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          if (e.currentTarget.dataset.closed !== "1") onCommit();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          const action = editKeyAction(e);
          if (action === "commit") {
            e.preventDefault();
            e.currentTarget.dataset.closed = "1";
            onCommit();
          } else if (action === "cancel") {
            e.preventDefault();
            e.currentTarget.dataset.closed = "1";
            onCancel();
          }
        }}
        style={{ fontSize: `${fontSize}px`, color: textColor, minHeight: Math.max(48, bodyHeight) }}
        className="block w-full resize-none rounded-md bg-card/95 px-1.5 py-1 font-mono leading-[1.45] caret-[#D94E28] shadow-sm outline-none ring-1 ring-[#D94E28]/45"
      />
      <p className="mt-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
        Shift+Enter new row · Enter save
      </p>
    </div>
  );
}
