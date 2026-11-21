import { computeBounds, findFreeSpot, makeSeed, uid } from "../geometry";
import { formatTransitionLabel, parseTransitionLabel } from "../notation-kinds";
import type { JevElement } from "../types";
import { displayName } from "./board";

export interface TransitionSuggestion {
  event: string;
  guard?: string;
  fromId: string;
  /** An existing state the transition lands on; unset when a new state named `toLabel` is needed. */
  toId?: string;
  toLabel: string;
  reason: string;
}

export interface TransitionsResult {
  status: "found" | "clean" | "not-state";
  suggestions: TransitionSuggestion[];
  /** Every shape of the state diagram (states and pseudo-states), so new states go clear of it. */
  diagramIds: string[];
}

const PENDING_RE = /pending|placed|booked|reserved|awaiting|requested|submitted|unpaid|scheduled|processing|authori[sz]ed|created/i;
const WAITING_RE = /pending|awaiting|reserved|held|hold|unpaid|authori[sz]ed|invited|requested|processing|waiting/i;
const ACTIVE_RE = /active|trial|subscri|session|token|invite|coupon|offer|reservation|listing|logged in/i;
const FAIL_RE = /fail|declin|error|reject|bounced/i;
const PAID_RE = /paid|captured|charged|completed|delivered|fulfilled|shipped|settled|succeeded/i;
const CANCEL_RE = /cancel|void|abort|withdraw/i;
const TIMEOUT_RE = /time\s?out|expire|ttl|timer|lapse|after\s+\d|\d+\s*(?:min|h|s|ms|day)/i;
const REFUND_RE = /refund|chargeback|return/i;
const STATE_KINDS = new Set(["node", "ellipse", "diamond"]);
const MAX_PER_RULE = 2;

interface StateGraph {
  states: JevElement[];
  transitions: Array<{ el: JevElement; from: string; to: string; text: string }>;
  /** `event guard` of every arrow leaving a state, including those into the final pseudo-state. */
  events: string[];
  shapeIds: string[];
}

/** States reachable from an initial/final pseudo-state over arrows; the component with a selected element wins. */
function findStateGraph(elements: JevElement[], selectedIds: string[]): StateGraph | null {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const arrows = elements.filter((e) => e.kind === "arrow" && e.fromId && e.toId && byId.has(e.fromId) && byId.has(e.toId));
  const adj = new Map<string, string[]>();
  for (const a of arrows) {
    adj.set(a.fromId!, [...(adj.get(a.fromId!) ?? []), a.toId!]);
    adj.set(a.toId!, [...(adj.get(a.toId!) ?? []), a.fromId!]);
  }
  const component = (seed: string) => {
    const seen = new Set([seed]);
    const stack = [seed];
    while (stack.length > 0) {
      for (const n of adj.get(stack.pop()!) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return seen;
  };
  const pseudos = elements.filter((e) => e.kind === "initial" || e.kind === "final");
  const components = pseudos.map((p) => component(p.id));
  const selected = new Set(selectedIds);
  const first = components.find((c) => [...c].some((id) => selected.has(id))) ?? components.find((c) => c.size > 1);
  if (!first) return null;
  const groupOf = (c: Set<string>) => [...c].map((id) => byId.get(id)!.morphMeta?.groupId).find(Boolean);
  const group = groupOf(first);
  const chosen = new Set(components.filter((c) => groupOf(c) === group).flatMap((c) => [...c]));
  const states = elements.filter((e) => chosen.has(e.id) && STATE_KINDS.has(e.kind));
  if (states.length === 0) return null;
  const stateIds = new Set(states.map((s) => s.id));
  const text = (a: JevElement) => {
    const t = parseTransitionLabel(a.label);
    return `${t.event} ${t.guard ?? ""}`.trim();
  };
  const transitions = arrows
    .filter((a) => stateIds.has(a.fromId!) && stateIds.has(a.toId!))
    .map((a) => ({ el: a, from: a.fromId!, to: a.toId!, text: text(a) }));
  const events = arrows.filter((a) => stateIds.has(a.fromId!) && chosen.has(a.toId!)).map(text);
  const shapeIds = elements.filter((e) => chosen.has(e.id) && e.kind !== "arrow").map((e) => e.id);
  return { states, transitions, events, shapeIds };
}

/** Suggests cancel, timeout / expire, retry and refund transitions a state machine with these words usually needs. */
export function findMissingTransitions(elements: JevElement[], selectedIds: string[]): TransitionsResult {
  const sg = findStateGraph(elements, selectedIds);
  if (!sg) return { status: "not-state", suggestions: [], diagramIds: [] };
  const { states, transitions, events } = sg;
  const name = (s: JevElement) => displayName(s);
  const incoming = (id: string) => transitions.filter((t) => t.to === id);
  const outgoing = (id: string) => transitions.filter((t) => t.from === id);
  const covered = (eventRe: RegExp, stateRe: RegExp) =>
    events.some((e) => eventRe.test(e)) || states.some((s) => stateRe.test(name(s)) && incoming(s.id).length > 0);
  const findState = (re: RegExp) => states.find((s) => re.test(name(s)));
  const isOutcome = (s: JevElement) => CANCEL_RE.test(name(s)) || FAIL_RE.test(name(s)) || REFUND_RE.test(name(s)) || /expire/i.test(name(s));
  const target = (label: string, re: RegExp) => {
    const existing = findState(re);
    return existing ? { toId: existing.id, toLabel: name(existing) } : { toLabel: label };
  };

  const out: TransitionSuggestion[] = [];
  if (!covered(CANCEL_RE, /cancel/i)) {
    for (const s of states.filter((s) => PENDING_RE.test(name(s)) && !isOutcome(s)).slice(0, MAX_PER_RULE)) {
      out.push({
        event: "cancel",
        fromId: s.id,
        ...target("Cancelled", /cancel/i),
        reason: `Users and ops cancel before it completes; without this it is stuck in ${name(s)}.`,
      });
    }
  }
  if (!covered(TIMEOUT_RE, /expire|timed?\s?out/i)) {
    const timed = new Set<string>();
    for (const s of states.filter((s) => ACTIVE_RE.test(name(s)) && !isOutcome(s)).slice(0, MAX_PER_RULE)) {
      timed.add(s.id);
      out.push({ event: "expire", fromId: s.id, ...target("Expired", /expire/i), reason: `Say what happens when ${name(s)} lapses.` });
    }
    for (const s of states.filter((s) => WAITING_RE.test(name(s)) && !isOutcome(s) && !timed.has(s.id)).slice(0, MAX_PER_RULE)) {
      out.push({
        event: "timeout",
        guard: "after 15 min",
        fromId: s.id,
        ...target("Expired", /expire|timed?\s?out/i),
        reason: `Nobody acts: release the hold after a deadline so ${name(s)} does not live forever.`,
      });
    }
  }
  for (const s of states.filter((s) => FAIL_RE.test(name(s)) && outgoing(s.id).length === 0)) {
    const from = incoming(s.id);
    const back = from.find((t) => FAIL_RE.test(t.text)) ?? from[0];
    if (!back) continue;
    const prev = states.find((p) => p.id === back.from)!;
    out.push({ event: "retry", fromId: s.id, toId: prev.id, toLabel: name(prev), reason: `${name(s)} is a dead end: let the user or a job retry.` });
  }
  if (!covered(REFUND_RE, REFUND_RE)) {
    const paid = states.find((s) => PAID_RE.test(name(s)) && !isOutcome(s));
    if (paid) {
      out.push({
        event: "refund",
        fromId: paid.id,
        ...target("Refunded", /refund/i),
        reason: `Money comes back after ${name(paid)}: refunds and chargebacks need a state.`,
      });
    }
  }
  return { status: out.length > 0 ? "found" : "clean", suggestions: out, diagramIds: sg.shapeIds };
}

const NEW_STATE = { width: 150, height: 56 };

/** Ghost elements: new target states below the whole diagram, offset right of their source, and one labelled arrow each. */
export function buildTransitionGhosts(result: TransitionsResult, elements: JevElement[], now: number): JevElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const ids = new Set(result.diagramIds);
  const diagram = computeBounds(elements.filter((e) => ids.has(e.id)));
  const placed: JevElement[] = [];
  const newIds = new Map<string, string>();
  const stamp = (prefix: string) => {
    const id = uid(prefix);
    return { id, seed: makeSeed(id), createdAt: now, updatedAt: now };
  };
  for (const s of result.suggestions) {
    if (s.toId || newIds.has(s.toLabel)) continue;
    const from = byId.get(s.fromId)!;
    const preferred = {
      x: from.x + from.width / 2 + 40,
      y: (diagram ? diagram.y + diagram.height : from.y + from.height) + 90,
      ...NEW_STATE,
    };
    const spot = findFreeSpot(preferred, [...elements, ...placed], NEW_STATE.width + 40, NEW_STATE.height + 40);
    const el: JevElement = { ...stamp("gst"), kind: "node", x: spot.x, y: spot.y, ...NEW_STATE, label: s.toLabel, tone: "slate" };
    placed.push(el);
    newIds.set(s.toLabel, el.id);
  }
  const arrows: JevElement[] = result.suggestions.map((s) => ({
    ...stamp("gtr"),
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    fromId: s.fromId,
    toId: s.toId ?? newIds.get(s.toLabel)!,
    label: formatTransitionLabel(s.event, s.guard),
    tone: "plum",
    arrowStyle: "curved",
    startEnd: "none",
    endEnd: "arrow",
  }));
  return [...placed, ...arrows];
}
