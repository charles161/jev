"use client";

import { useCallback, useMemo, useState, type RefObject } from "react";
import { findFreeSpot, isShapeElement, uid } from "@/lib/jev/geometry";
import { isContainerKind } from "@/lib/jev/notation-kinds";
import {
  buildEstimateCard,
  buildStarter,
  parsePaletteInput,
  placeInsert,
  type PackId,
  type PackItem,
  type StarterCommand,
} from "@/lib/jev/notation-packs";
import { inferPackChips, packChipAction, tableEntityPatch, type PackChip } from "@/lib/jev/pack-inference";
import type { BoardEditDelta } from "@/lib/jev/semantic-graph";
import { shapeFromTool } from "@/lib/jev/shape-tools";
import type { JevElement, MorphNotation, Point, Viewport } from "@/lib/jev/types";

interface UsePacksDeps {
  elements: JevElement[];
  elementsRef: RefObject<JevElement[]>;
  selectedIds: string[];
  viewport: Viewport;
  viewportCenterWorld: Point;
  /** Inferred pack chips; practice mode turns this off. */
  chipsEnabled: boolean;
  updateElements: (updater: (prev: JevElement[]) => JevElement[]) => JevElement[];
  setSelectedIds: (ids: string[]) => void;
  morph: (notation: MorphNotation, ids?: string[]) => void;
  pushEditDelta: (delta: Omit<BoardEditDelta, "timestamp">) => void;
  announceStatus: (message: string) => void;
  ensureElementsVisible: (els: JevElement[]) => void;
}

const MORPH_COMMANDS: Partial<Record<StarterCommand, MorphNotation>> = { er: "er", seq: "sequence", state: "state" };

/** Packs: the `/` palette inserts, the side panel, and the quiet inferred-pack chips. */
export function usePacks(deps: UsePacksDeps) {
  const {
    elements,
    elementsRef,
    selectedIds,
    viewport,
    viewportCenterWorld,
    chipsEnabled,
    updateElements,
    setSelectedIds,
    morph,
    pushEditDelta,
    announceStatus,
    ensureElementsVisible,
  } = deps;
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPack, setPanelPack] = useState<PackId>("hld");
  const [settledChips, setSettledChips] = useState<ReadonlySet<string>>(() => new Set());

  const openPanel = useCallback((pack?: PackId) => {
    if (pack) setPanelPack(pack);
    setPanelOpen(true);
  }, []);

  const insert = useCallback(
    (els: JevElement[], summary: string) => {
      const placed = placeInsert(els, elementsRef.current);
      updateElements((prev) => [...placed.filter((e) => isContainerKind(e.kind)), ...prev, ...placed.filter((e) => !isContainerKind(e.kind))]);
      const shapeIds = placed.filter(isShapeElement).map((e) => e.id);
      setSelectedIds(shapeIds);
      ensureElementsVisible(placed);
      pushEditDelta({ op: "add", elementIds: shapeIds.slice(0, 16), summary });
      announceStatus(summary);
    },
    [elementsRef, updateElements, setSelectedIds, ensureElementsVisible, pushEditDelta, announceStatus]
  );

  const insertStarter = useCallback(
    (command: StarterCommand | "estimate", args = "") => {
      const now = Date.now();
      if (command === "estimate") {
        insert([buildEstimateCard(args, viewportCenterWorld, now)], "Inserted a numbers card");
        return;
      }
      insert(buildStarter(command, viewportCenterWorld, now), `Inserted a ${command} starter`);
    },
    [insert, viewportCenterWorld]
  );

  /** Runs a `/` command; false when the text is not one. */
  const runPaletteCommand = useCallback(
    (text: string): boolean => {
      const parsed = parsePaletteInput(text);
      if (!parsed) return false;
      const { command, args } = parsed;
      if (command === "estimate") {
        insertStarter("estimate", args);
        return true;
      }
      const current = elementsRef.current;
      const set = new Set(selectedIds);
      const picked = current.filter((e) => set.has(e.id) && isShapeElement(e) && !isContainerKind(e.kind));
      const notation = MORPH_COMMANDS[command];
      if (notation && picked.length >= 2) {
        morph(notation, picked.map((e) => e.id));
        return true;
      }
      if (command === "er" && picked.length === 1 && (picked[0].kind === "database" || picked[0].kind === "node")) {
        const target = picked[0];
        updateElements((prev) => prev.map((e) => (e.id === target.id ? { ...e, ...tableEntityPatch(e), updatedAt: Date.now() } : e)));
        pushEditDelta({ op: "update", elementIds: [target.id], summary: `Turned ${target.label || "a shape"} into an ER entity` });
        announceStatus("Turned the selection into an ER entity");
        return true;
      }
      insertStarter(command);
      return true;
    },
    [elementsRef, selectedIds, morph, updateElements, pushEditDelta, announceStatus, insertStarter]
  );

  const placeItem = useCallback(
    (item: PackItem, screen: Point | null) => {
      const world = screen
        ? { x: (screen.x - viewport.x) / viewport.zoom, y: (screen.y - viewport.y) / viewport.zoom }
        : viewportCenterWorld;
      const id = uid(item.kind === "frame" ? "frm" : "el");
      const placed = shapeFromTool(item.kind, world, world, id, Date.now());
      let el: JevElement = item.label ? { ...placed.element, label: item.label } : placed.element;
      if (!screen && !placed.behind) {
        const spot = findFreeSpot({ x: el.x, y: el.y, width: el.width, height: el.height }, elementsRef.current);
        el = { ...el, x: spot.x, y: spot.y };
      }
      updateElements((prev) => (placed.behind ? [el, ...prev] : [...prev, el]));
      setSelectedIds([id]);
      ensureElementsVisible([el]);
      pushEditDelta({ op: "add", elementIds: [id], summary: `Placed ${el.label || item.kind}` });
    },
    [viewport, viewportCenterWorld, elementsRef, updateElements, setSelectedIds, ensureElementsVisible, pushEditDelta]
  );

  const chips = useMemo(
    () => (chipsEnabled ? inferPackChips(elements, { dismissed: settledChips }) : []),
    [chipsEnabled, elements, settledChips]
  );

  const settle = useCallback((chip: PackChip) => {
    setSettledChips((prev) => new Set(prev).add(chip.id));
  }, []);

  const applyChip = useCallback(
    (chip: PackChip) => {
      settle(chip);
      const action = packChipAction(chip, elementsRef.current);
      if (!action) return;
      if (action.type === "patch") {
        updateElements((prev) => prev.map((e) => (e.id === action.id ? { ...e, ...action.patch, updatedAt: Date.now() } : e)));
        pushEditDelta({ op: "update", elementIds: [action.id], summary: chip.title });
        announceStatus(chip.kind === "crows-foot" ? "Converted the cardinality to crow's-foot ends" : "Converted the table to an ER entity");
        if (action.openPack) openPanel(action.openPack);
        return;
      }
      if (action.type === "morph") {
        morph(action.notation, action.ids);
        return;
      }
      openPanel(action.pack);
    },
    [settle, elementsRef, updateElements, pushEditDelta, announceStatus, openPanel, morph]
  );

  return {
    panelOpen,
    panelPack,
    setPanelPack,
    openPanel,
    closePanel: useCallback(() => setPanelOpen(false), []),
    insertStarter,
    runPaletteCommand,
    placeItem,
    chip: chips[0] ?? null,
    applyChip,
    dismissChip: settle,
  };
}
