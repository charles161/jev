import type { JevElement } from "../types";
import { buildHldGraph, componentRole, displayName, type ComponentRole } from "./board";

export type FailureKind = "timeout" | "idempotency" | "outbox" | "dedupe";

export interface FailureFlag {
  /** The arrow (message or HLD edge) the note pins to. */
  anchorId: string;
  /** Sequence step number; HLD edges have none. */
  step?: number;
  /** The arrow's label, or "From → To" when it has none. */
  name: string;
  kinds: FailureKind[];
  title: string;
  /** One sentence per kind, without the step prefix. */
  lines: string[];
  /** The step and every line, for notices and the AI. */
  text: string;
}

export interface FailureResult {
  status: "found" | "clean" | "empty";
  source: "sequence" | "hld";
  flags: FailureFlag[];
}

interface Call {
  anchorId: string;
  step?: number;
  label: string;
  name: string;
  from: ComponentRole;
  to: ComponentRole;
  toName: string;
  /** Everything written on the target shape (label and sublabel): a note there counts as handling the step. */
  toText: string;
  /** The target is a flowchart decision diamond: flow logic, not a remote call. */
  decision: boolean;
  async: boolean;
}

const WRITE_RE =
  /\b(post|put|patch|delete|charge|capture|pay|payment|refund|create|place|submit|checkout|insert|update|write|save|send|reserve|book|transfer|debit|credit|payout|upsert)\b/i;
const PAYMENT_RE = /\b(charge|capture|pay|payment|refund|payout|transfer|debit|authori[sz]e|stripe|paypal|card)\b/i;
const IDEM_RE = /idempot|dedup|request[_ -]?id|exactly[- ]once/i;
const TIMEOUT_RE = /timeout|deadline|\b\d+\s?(?:ms|s)\b/i;
const OUTBOX_RE = /outbox|pending|saga|transaction|\btx\b/i;
const MAX_FLAGS = 6;

const TITLES: Record<FailureKind, string> = {
  timeout: "Timeout",
  idempotency: "Idempotency key",
  outbox: "Outbox",
  dedupe: "Dedupe",
};

function analyse(calls: Call[]): FailureFlag[] {
  const flags: FailureFlag[] = [];
  let externalWriteStep: string | null = null;
  for (const c of calls) {
    const write = WRITE_RE.test(c.label);
    const payment = PAYMENT_RE.test(c.label) || PAYMENT_RE.test(c.toName);
    const where = c.step !== undefined ? `Step ${c.step} "${c.name}"` : `"${c.name}"`;
    const kinds: FailureKind[] = [];
    const lines: string[] = [];
    if (c.async) {
      if (c.to === "queue" && !IDEM_RE.test(c.label)) {
        kinds.push("dedupe");
        lines.push("Delivery is at-least-once, so the consumer must dedupe by message id.");
      }
    } else {
      if (c.from !== "client" && !c.decision && (c.to === "service" || c.to === "external") && !TIMEOUT_RE.test(c.label) && !TIMEOUT_RE.test(c.toText)) {
        kinds.push("timeout");
        lines.push(`No timeout: set one, retry with backoff, fail fast when ${c.toName} is down.`);
      }
      const remoteWrite = write && (c.to === "external" || payment) && c.from !== "client";
      const clientWrite = write && c.from === "client" && (c.to === "service" || c.to === "lb");
      if ((remoteWrite || clientWrite) && !IDEM_RE.test(c.label) && !IDEM_RE.test(c.toText)) {
        kinds.push("idempotency");
        lines.push(
          clientWrite
            ? "Clients retry on timeout: accept an Idempotency-Key so a double submit creates one record."
            : `A retry after a timeout can ${payment ? "charge twice" : "repeat the write"}: send an idempotency key.`
        );
      }
      if (c.to === "db" && write && externalWriteStep && !OUTBOX_RE.test(c.label)) {
        kinds.push("outbox");
        lines.push(`If this fails after ${externalWriteStep}, money moved with no record: write a pending row or outbox first.`);
      }
      if (remoteWrite) externalWriteStep = c.step !== undefined ? `step ${c.step}` : `"${c.label}"`;
    }
    if (kinds.length === 0) continue;
    const title = kinds.map((k, i) => (i === 0 ? TITLES[k] : TITLES[k].toLowerCase())).join(" + ");
    flags.push({
      anchorId: c.anchorId,
      ...(c.step !== undefined ? { step: c.step } : {}),
      name: c.name,
      kinds,
      title,
      lines,
      text: `${where}: ${lines.join(" ")}`,
    });
  }
  return flags.slice(0, MAX_FLAGS);
}

function sequenceCalls(elements: JevElement[], groupId: string): Call[] {
  const inGroup = elements.filter((e) => e.morphMeta?.groupId === groupId);
  const lifelines = inGroup.filter((e) => e.morphMeta?.role === "lifeline" && e.fromPoint);
  const actors = new Map(inGroup.filter((e) => e.morphMeta?.role === "actor").map((e) => [e.morphMeta!.semanticId, e]));
  const actorAt = (x: number) => {
    const line = lifelines.reduce<JevElement | null>(
      (best, l) => (!best || Math.abs(l.fromPoint!.x - x) < Math.abs(best.fromPoint!.x - x) ? l : best),
      null
    );
    return line ? actors.get(line.morphMeta!.semanticId) : undefined;
  };
  return inGroup
    .filter((e) => e.kind === "arrow" && e.morphMeta?.role === "message" && !e.dashed && e.fromPoint && e.toPoint)
    .sort((a, b) => a.fromPoint!.y - b.fromPoint!.y)
    .flatMap((m, i) => {
      const from = actorAt(m.fromPoint!.x);
      const to = actorAt(m.toPoint!.x);
      if (!from || !to) return [];
      const num = m.label.match(/^\s*(\d+)\.\s*/);
      const label = m.label.replace(/^\s*\d+\.\s*/, "").trim();
      return [
        {
          anchorId: m.id,
          step: num ? Number(num[1]) : i + 1,
          label,
          name: label || `${displayName(from)} → ${displayName(to)}`,
          from: componentRole(from),
          to: componentRole(to),
          toName: displayName(to),
          toText: `${to.label} ${to.sublabel ?? ""}`,
          decision: false,
          async: m.endEnd === "open",
        },
      ];
    });
}

/** Steps that need a timeout, an idempotency key, an outbox or consumer dedupe, on a sequence diagram or HLD arrows. */
export function findFailureSteps(elements: JevElement[], selectedIds: string[]): FailureResult {
  const selected = new Set(selectedIds);
  const isSeq = (e: JevElement) => e.morphMeta?.notation === "sequence";
  const seqEl = elements.find((e) => isSeq(e) && selected.has(e.id)) ?? elements.find(isSeq);
  if (seqEl) {
    const calls = sequenceCalls(elements, seqEl.morphMeta!.groupId);
    const flags = analyse(calls);
    return { status: calls.length === 0 ? "empty" : flags.length > 0 ? "found" : "clean", source: "sequence", flags };
  }
  const g = buildHldGraph(elements);
  const seen = new Set<string>();
  const calls: Call[] = g.edges
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .map((e) => {
      const from = g.nodes.get(e.from)!;
      const to = g.nodes.get(e.to)!;
      return {
        anchorId: e.id,
        label: e.label,
        name: e.label || `${from.label} → ${to.label}`,
        from: from.role,
        to: to.role,
        toName: to.label,
        toText: `${to.el.label} ${to.el.sublabel ?? ""}`,
        decision: to.el.kind === "diamond",
        async: e.async,
      };
    });
  const flags = analyse(calls);
  return { status: calls.length === 0 ? "empty" : flags.length > 0 ? "found" : "clean", source: "hld", flags };
}
