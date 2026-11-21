"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { appUrl } from "@/lib/base-path";
import { isShapeElement } from "@/lib/jev/geometry";
import type { BoardEditDelta } from "@/lib/jev/semantic-graph";
import { apiSources, buildSchemaElements, proposeSchema } from "@/lib/jev/sd-moves/api-schema";
import { findBreakAt10x } from "@/lib/jev/sd-moves/break-at-10x";
import { breakCard, consistencyCard, failureNotes, RULE_SOURCE, sizedCard, sourceLine } from "@/lib/jev/sd-moves/cards";
import { checkConsistency } from "@/lib/jev/sd-moves/consistency";
import { boardDigest, ENRICH_CLIENT_TIMEOUT_MS, enrichResponseSchema, type EnrichableMove, type MoveFinding } from "@/lib/jev/sd-moves/enrich";
import { findFailureSteps } from "@/lib/jev/sd-moves/failure-steps";
import { buildTransitionGhosts, findMissingTransitions } from "@/lib/jev/sd-moves/missing-transitions";
import { estimateText, parseMoveCommand, quietReason, type MoveId } from "@/lib/jev/sd-moves/moves";
import { traceRequest, type TracePath, type TraceStep } from "@/lib/jev/sd-moves/trace";
import type { JevElement, PredictedAction } from "@/lib/jev/types";

export type MoveSource = "AI" | "Rule-based";

export interface MoveNotice {
  id: number;
  title: string;
  text: string;
  source: MoveSource | null;
}

export interface TraceState {
  path: TracePath;
  startId: string | null;
  steps: TraceStep[];
}

export interface MoveHighlight {
  id: string;
  /** Pin text on the shape ("1", "2,3"): the numbered lines of the move's card that name it. */
  pin?: string;
  /** The card the move added: when it leaves the board (undo, delete) the pin goes with it. */
  ownerId: string;
}

interface UseMovesDeps {
  elementsRef: RefObject<JevElement[]>;
  selectedIds: string[];
  /** Practice mode: moves that critique or draw part of the answer stay quiet until Review. */
  aiQuiet: boolean;
  updateElements: (updater: (prev: JevElement[]) => JevElement[], opts?: { recordUndo?: boolean }) => JevElement[];
  pushEditDelta: (delta: Omit<BoardEditDelta, "timestamp">) => void;
  announceStatus: (message: string) => void;
  ensureElementsVisible: (els: JevElement[]) => void;
  insertEstimate: (text: string) => void;
  promptEstimate: () => void;
  showGhosts: (action: PredictedAction, headline: string, detail: string) => void;
}

const NOTICE_MS = 7000;
const HIGHLIGHT_MS = 14000;

interface EnrichTarget {
  cardId: string;
  finding: MoveFinding;
  render: (f: MoveFinding, source: string) => { label: string; lines: string[] };
}

/** The AI moves: each runs a deterministic analyzer, makes at most one undoable board change, and says what it did. */
export function useMoves(deps: UseMovesDeps) {
  const {
    elementsRef,
    selectedIds,
    aiQuiet,
    updateElements,
    pushEditDelta,
    announceStatus,
    ensureElementsVisible,
    insertEstimate,
    promptEstimate,
    showGhosts,
  } = deps;
  const [notice, setNotice] = useState<MoveNotice | null>(null);
  const [trace, setTrace] = useState<TraceState | null>(null);
  const [highlights, setHighlights] = useState<MoveHighlight[]>([]);
  const noticeSeq = useRef(0);
  const enrichAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (highlights.length === 0) return;
    const timer = window.setTimeout(() => setHighlights([]), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlights]);

  useEffect(() => () => enrichAbort.current?.abort(), []);

  const say = useCallback(
    (title: string, text: string, source: MoveSource | null) => {
      noticeSeq.current += 1;
      setNotice({ id: noticeSeq.current, title, text, source });
      announceStatus(`${title}. ${text}`);
    },
    [announceStatus]
  );

  const addToBoard = useCallback(
    (els: JevElement[], summary: string) => {
      updateElements((prev) => [...prev, ...els]);
      pushEditDelta({ op: "add", elementIds: els.filter(isShapeElement).map((e) => e.id).slice(0, 16), summary });
      ensureElementsVisible(els);
    },
    [updateElements, pushEditDelta, ensureElementsVisible]
  );

  /** Asks the gateway to reword the cards just added; patches only cards the user has not touched since. */
  const enrich = useCallback(
    async (move: EnrichableMove, targets: EnrichTarget[], noticeTitle: string) => {
      if (targets.length === 0) return;
      enrichAbort.current?.abort();
      const controller = new AbortController();
      enrichAbort.current = controller;
      const timer = window.setTimeout(() => controller.abort(), ENRICH_CLIENT_TIMEOUT_MS);
      try {
        const res = await fetch(appUrl("/api/jev/moves"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ move, findings: targets.map((t) => t.finding), board: boardDigest(elementsRef.current) }),
        });
        if (!res.ok) return;
        const parsed = enrichResponseSchema.safeParse(await res.json());
        if (!parsed.success || parsed.data.source !== "ai") return;
        const json = parsed.data;
        const byId = new Map(json.findings.map((f) => [f.id, f]));
        const model = json.model;
        let patched = 0;
        updateElements(
          (prev) =>
            prev.map((el) => {
              const target = targets.find((t) => t.cardId === el.id);
              const ai = target && byId.get(target.finding.id);
              if (!target || !ai) return el;
              const before = target.render(target.finding, RULE_SOURCE);
              if (el.label !== before.label || el.sublabel !== before.lines.join("\n")) return el;
              const after = target.render(ai, model);
              const sized = sizedCard(after.label, after.lines, el.width, el.tone, el.createdAt);
              patched += 1;
              return { ...el, label: sized.label, sublabel: sized.sublabel, height: sized.height, updatedAt: Date.now() };
            }),
          { recordUndo: false }
        );
        if (patched > 0) say(noticeTitle, `Reworded by AI (${model}).`, "AI");
      } catch {
        // The rule-based cards stay as they are.
      } finally {
        window.clearTimeout(timer);
      }
    },
    [elementsRef, updateElements, say]
  );

  const runBreak = useCallback(() => {
    const els = elementsRef.current;
    const result = findBreakAt10x(els);
    if (result.status === "empty") {
      say("Breaks at 10×", "Draw a few components and connect them with arrows first.", null);
      return;
    }
    if (result.status === "clean") {
      say("Breaks at 10×", `Nothing obvious breaks at 10×. Checked: ${result.checked.join(", ")}.`, "Rule-based");
      return;
    }
    const now = Date.now();
    const added = breakCard(result, els, now);
    const top = result.findings[0];
    addToBoard(added, `Breaks at 10×: ${top.headline}`);
    setHighlights([{ id: top.culpritId, ownerId: added[0].id }]);
    say("Breaks at 10×", top.headline, "Rule-based");
    const card = added[0];
    const also = card.sublabel!.split("\n").filter((l) => l.startsWith("Also: "));
    void enrich(
      "break",
      [
        {
          cardId: card.id,
          finding: { id: "break", title: top.headline, lines: [`Why: ${top.why}`, ...top.fixes.map((f) => `Fix: ${f}`)] },
          render: (f, source) => ({ label: card.label, lines: [f.title, ...f.lines, ...also, sourceLine(source)] }),
        },
      ],
      "Breaks at 10×"
    );
  }, [elementsRef, say, addToBoard, enrich]);

  const runFailure = useCallback(() => {
    const els = elementsRef.current;
    const result = findFailureSteps(els, selectedIds);
    if (result.status === "empty") {
      say("Failure steps", "Nothing to check: draw a sequence diagram, or connect services with labelled arrows.", null);
      return;
    }
    if (result.status === "clean") {
      say(
        "Failure steps",
        "No failure-prone steps: external writes carry idempotency keys and cross-service calls name a timeout.",
        "Rule-based"
      );
      return;
    }
    const notes = failureNotes(result, els, Date.now());
    addToBoard(notes, `Pinned ${notes.length} failure note${notes.length === 1 ? "" : "s"}`);
    const steps = result.flags.map((f) => (f.step !== undefined ? `step ${f.step}` : `"${f.name}"`));
    say("Failure steps", `Pinned ${notes.length} note${notes.length === 1 ? "" : "s"}: ${steps.join(", ")}.`, "Rule-based");
    void enrich(
      "failure",
      result.flags.map((flag, i) => {
        const prefix = notes[i].label.slice(0, notes[i].label.length - flag.title.length);
        return {
          cardId: notes[i].id,
          finding: { id: flag.anchorId, title: flag.title, lines: flag.lines },
          render: (f: MoveFinding, source: string) => ({ label: `${prefix}${f.title}`, lines: [...f.lines, sourceLine(source)] }),
        };
      }),
      "Failure steps"
    );
  }, [elementsRef, selectedIds, say, addToBoard, enrich]);

  const runSchema = useCallback(() => {
    const els = elementsRef.current;
    const sources = apiSources(els, selectedIds);
    if (sources.length === 0) {
      say("API → schema", "Select an API card (or a shape labelled like POST /orders) first. /api inserts one.", null);
      return;
    }
    const existing = els.filter((e) => e.kind === "entity").map((e) => e.label);
    const proposal = proposeSchema(sources, existing);
    if (proposal.entities.length === 0) {
      const text =
        proposal.existing.length > 0
          ? `Already on the board: ${proposal.existing.join(", ")}.`
          : "These cards name no resource path (like /orders) to model.";
      say("API → schema", text, "Rule-based");
      return;
    }
    const added = buildSchemaElements(proposal, els, Date.now());
    const names = proposal.entities.map((e) => e.name).join(", ");
    addToBoard(added, `Proposed entities ${names}`);
    const kept = proposal.existing.length > 0 ? ` Kept ${proposal.existing.join(", ")} as drawn.` : "";
    say("API → schema", `Proposed ${names} with PK/FK rows from ${sources.length} API${sources.length === 1 ? "" : "s"}.${kept}`, "Rule-based");
  }, [elementsRef, selectedIds, say, addToBoard]);

  const runTransitions = useCallback(() => {
    const els = elementsRef.current;
    const result = findMissingTransitions(els, selectedIds);
    if (result.status === "not-state") {
      say("Missing transitions", "No state diagram here: draw states with an initial dot, or /state to start one.", null);
      return;
    }
    if (result.status === "clean") {
      say("Missing transitions", "Nothing missing: cancel, timeout or expiry, retry and refund are covered or do not fit.", "Rule-based");
      return;
    }
    const ghosts = buildTransitionGhosts(result, els, Date.now());
    const events = result.suggestions.map((s) => s.event).join(", ");
    showGhosts(
      {
        id: `move-transitions-${Date.now()}`,
        title: `Add ${result.suggestions.length} missing transition${result.suggestions.length === 1 ? "" : "s"}`,
        subtitle: events,
        category: "structure",
        addElements: ghosts,
      },
      `Missing: ${events}`,
      "Enter adds them · Esc dismisses"
    );
    say("Missing transitions", `${result.suggestions.map((s) => s.reason).join(" ")} Enter adds them.`, "Rule-based");
  }, [elementsRef, selectedIds, say, showGhosts]);

  const runConsistency = useCallback(() => {
    const els = elementsRef.current;
    const result = checkConsistency(els);
    if (result.status === "nothing") {
      say(
        "Consistency check",
        "Nothing to compare: it needs a class, an API card or an entity that share a name (Order, /orders, orders).",
        null
      );
      return;
    }
    if (result.status === "clean") {
      say("Consistency check", `Class, API and table agree on ${result.compared.join(", ")}.`, "Rule-based");
      return;
    }
    const card = consistencyCard(result, els, Date.now())!;
    addToBoard([card], `Consistency check: ${result.mismatches.length} mismatches`);
    const numbers = new Map<string, number[]>();
    result.mismatches.slice(0, 8).forEach((m, i) => numbers.set(m.elementIds[0], [...(numbers.get(m.elementIds[0]) ?? []), i + 1]));
    setHighlights([...numbers].map(([id, ns]) => ({ id, pin: ns.join(","), ownerId: card.id })));
    say("Consistency check", `${result.mismatches.length} mismatch${result.mismatches.length === 1 ? "" : "es"}: ${result.mismatches[0].text}.`, "Rule-based");
  }, [elementsRef, say, addToBoard]);

  const startTrace = useCallback(
    (path: TracePath) => {
      const els = elementsRef.current;
      const start = selectedIds.length === 1 ? selectedIds[0] : null;
      const result = traceRequest(els, { path, startId: start });
      if (result.steps.length === 0) {
        setTrace(null);
        say("Trace request", result.reason ?? "Nothing to trace.", null);
        return;
      }
      setTrace({ path, startId: result.startId, steps: result.steps });
      const other = traceRequest(els, { path: path === "write" ? "read" : "write", startId: start });
      const same = other.steps.map((st) => st.edgeId).join() === result.steps.map((st) => st.edgeId).join();
      const hint = same ? " Read and write take the same arrows here: label them (GET, write) to split the paths." : "";
      say("Trace request", `${path === "write" ? "Write" : "Read"} path: ${result.steps.length} steps. Esc stops.${hint}`, "Rule-based");
    },
    [elementsRef, selectedIds, say]
  );

  const run = useCallback(
    (move: MoveId, args = "") => {
      const quiet = quietReason(move, aiQuiet);
      if (quiet) {
        say("Practice mode", quiet, null);
        return;
      }
      switch (move) {
        case "break":
          return runBreak();
        case "trace":
          return startTrace(/write/i.test(args) ? "write" : "read");
        case "estimate": {
          const text = estimateText(elementsRef.current, selectedIds);
          if (text) {
            insertEstimate(text);
            say("Estimate", "Inserted a numbers card from the selection.", "Rule-based");
          } else {
            promptEstimate();
            say("Estimate", "Type the numbers after /estimate, e.g. 50M DAU, 10 writes/user/day, 1KB, 5y.", null);
          }
          return;
        }
        case "schema":
          return runSchema();
        case "failure":
          return runFailure();
        case "transitions":
          return runTransitions();
        case "consistency":
          return runConsistency();
      }
    },
    [aiQuiet, say, runBreak, startTrace, elementsRef, selectedIds, insertEstimate, promptEstimate, runSchema, runFailure, runTransitions, runConsistency]
  );

  const runCommand = useCallback(
    (text: string): boolean => {
      const parsed = parseMoveCommand(text);
      if (!parsed) return false;
      run(parsed.move, parsed.args);
      return true;
    },
    [run]
  );

  const stopOverlay = useCallback(() => {
    setTrace(null);
    setHighlights([]);
  }, []);

  return {
    run,
    runCommand,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    trace,
    setTracePath: startTrace,
    highlights,
    stopOverlay,
  };
}
