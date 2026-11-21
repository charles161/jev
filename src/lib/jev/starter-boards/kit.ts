import { computeBounds, makeSeed } from "../geometry";
import { DEFAULT_KIND_SIZE } from "../notation-kinds";
import { applyMorphToBoard, morphSelectionToNotation } from "../notation-morph";
import { estimate, formatBytes, formatCount, type EstimateInput, type EstimateResult } from "../sd-estimate";
import { apiLayout, cardLayout } from "../shape-layout";
import type {
  ColorTone,
  ElementBox,
  JevElement,
  MorphEntitySpec,
  MorphFragmentSpec,
  MorphGroupRecord,
  MorphMessageSpec,
  MorphRelationSpec,
  MorphSemanticSpec,
  ShapeKind,
} from "../types";

export const STARTER_BOARD_TS = 1_700_000_000_000;

export interface StarterBoard {
  id: string;
  title: string;
  blurb: string;
  build(): JevElement[];
  def: BoardDef;
}

export function starterBoard(def: BoardDef): StarterBoard {
  return { id: def.id, title: def.title, blurb: def.blurb, build: () => composeBoard(def), def };
}

/** One HLD box on a grid: column/row cells, so every board lines up the same way. */
export interface HldNode {
  id: string;
  kind: ShapeKind;
  label: string;
  sublabel?: string;
  col: number;
  row: number;
  /** Outside the VPC/region zone (clients, CDN edge, third-party APIs). */
  outside?: boolean;
  width?: number;
  height?: number;
}

/** Write path = terracotta, read path = cobalt; async = dashed with an open head. */
export interface HldEdge {
  from: string;
  to: string;
  label: string;
  path: "write" | "read" | "both";
  async?: boolean;
}

export interface NumbersDef {
  input: EstimateInput;
  /** What one "write" and one "read" are on this board ("new URL", "redirect"). */
  writeName: string;
  readName: string;
  /** Lines of the generic estimate that do not apply (a rate limiter keeps counters, not history). */
  omit?: Array<"storage" | "bandwidth" | "cache">;
  extra: (r: EstimateResult) => string[];
}

export interface MorphViewDef {
  /** HLD node ids, in the order the sketch chain runs: the HLD part the view was morphed from. */
  from: string[];
  caption: string;
}

export interface ErDef extends MorphViewDef {
  entities: MorphEntitySpec[];
  relations: MorphRelationSpec[];
  /** Grid cell per entity id; the engine's default layout otherwise. */
  grid?: Record<string, [number, number]>;
}

export interface SequenceDef extends MorphViewDef {
  summary: string;
  /** Message endpoints are HLD node ids from `from`. */
  messages: Array<Omit<MorphMessageSpec, "id" | "order">>;
  fragments: Array<Omit<MorphFragmentSpec, "id">>;
}

export interface BoardDef {
  id: string;
  title: string;
  blurb: string;
  functional: string[];
  nonFunctional: string[];
  numbers: NumbersDef;
  api: { label: string; lines: string[] };
  tradeoffs: string[];
  zoneLabel: string;
  /** HLD grid column width; narrower for wide pipelines. */
  cellW?: number;
  nodes: HldNode[];
  edges: HldEdge[];
  /** The card sits above or below the zone in the culprit's column, so its arrow reaches it unobstructed. */
  breaks: { culprit: string; side: "above" | "below"; lines: string[] };
  er: ErDef;
  sequence: SequenceDef;
}

const NOW = STARTER_BOARD_TS;

const LEFT_W = 400;
const GAP = 64;
const CELL_W = 300;
const CELL_H = 170;
const ZONE_PAD = 36;
const ZONE_HEAD = 34;
const BREAKS_W = 420;

function base(id: string): Pick<JevElement, "id" | "seed" | "createdAt" | "updatedAt"> {
  return { id, seed: makeSeed(id), createdAt: NOW, updatedAt: NOW };
}

function shape(id: string, kind: ShapeKind, box: ElementBox, label: string, tone: ColorTone, sublabel?: string): JevElement {
  return { ...base(id), kind, ...box, label, ...(sublabel ? { sublabel } : {}), tone };
}

function arrow(id: string, fromId: string, toId: string, label: string, extra: Partial<JevElement> = {}): JevElement {
  return {
    ...base(id),
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    fromId,
    toId,
    label,
    tone: "ink",
    arrowStyle: "straight",
    ...extra,
  };
}

/** A card exactly tall enough for every wrapped line, so nothing hides behind "+N more". */
export function fittedCard(id: string, x: number, y: number, width: number, label: string, lines: string[], tone: ColorTone): JevElement {
  const sublabel = lines.join("\n");
  const probe = cardLayout({ label, sublabel, width, height: 10_000 });
  const height = Math.max(DEFAULT_KIND_SIZE.card.height / 2, probe.top + probe.lines.length * probe.rowHeight + 10);
  return shape(id, "card", { x, y, width, height }, label, tone, sublabel);
}

function fittedApi(id: string, x: number, y: number, width: number, label: string, lines: string[]): JevElement {
  const sublabel = lines.join("\n");
  const probe = apiLayout({ label, sublabel, width, height: 10_000 });
  const height = probe.headerHeight + probe.padTop + probe.rows.length * probe.rowHeight + 10;
  return shape(id, "api", { x, y, width, height }, label, "teal", sublabel);
}

export function numbersLines(def: NumbersDef): string[] {
  const { input } = def;
  const r = estimate(input);
  const omit = new Set(def.omit ?? []);
  const lines = [
    `Assume ${formatCount(input.dau)} DAU × ${input.writesPerUser} ${def.writeName}/user/day, ${def.readName}:${def.writeName} = ${input.readWriteRatio}:1, ${formatBytes(input.payloadBytes)} each, peak ×${input.peakFactor}`,
    `${def.writeName} QPS ≈ ${formatCount(r.avgWriteQps)} avg, ${formatCount(r.peakWriteQps)} peak`,
    `${def.readName} QPS ≈ ${formatCount(r.avgReadQps)} avg, ${formatCount(r.peakReadQps)} peak`,
  ];
  if (!omit.has("storage")) {
    lines.push(`Storage ≈ ${formatBytes(r.storagePerDay)}/day -> ${formatBytes(r.storageTotal)} over ${input.retentionYears} y`);
  }
  if (!omit.has("bandwidth")) {
    lines.push(`Bandwidth ≈ ${formatBytes(r.ingressBytesPerSec)}/s in, ${formatBytes(r.egressBytesPerSec)}/s out`);
  }
  if (!omit.has("cache")) lines.push(`Cache 20% of a day's reads ≈ ${formatBytes(r.cacheBytes)}`);
  return [...lines, ...def.extra(r)];
}

/** The six id prefixes the morph engine draws from Math.random get fixed names, so a board is the same every time. */
function renameMorphIds(els: JevElement[], keep: Set<string>, prefix: string): JevElement[] {
  const map = new Map<string, string>();
  let n = 0;
  for (const el of els) if (!keep.has(el.id)) map.set(el.id, `${prefix}_${n++}`);
  const groupIds = new Map<string, string>();
  const gid = (g: string) => {
    if (!groupIds.has(g)) groupIds.set(g, groupIds.size === 0 ? `${prefix}_grp` : `${prefix}_grp${groupIds.size}`);
    return groupIds.get(g)!;
  };
  const re = (id: string | undefined) => (id && map.has(id) ? map.get(id)! : id);
  return els.map((el) => {
    const id = re(el.id)!;
    const meta = el.morphMeta;
    return {
      ...el,
      id,
      seed: makeSeed(id),
      ...(el.fromId ? { fromId: re(el.fromId) } : {}),
      ...(el.toId ? { toId: re(el.toId) } : {}),
      ...(meta
        ? {
            morphMeta: {
              ...meta,
              groupId: gid(meta.groupId),
              ...(meta.groupRecord ? { groupRecord: { ...meta.groupRecord, groupId: gid(meta.groupRecord.groupId) } } : {}),
            },
          }
        : {}),
    };
  });
}

function shiftElement<T extends { kind: string; x: number; y: number; fromId?: string; toId?: string; fromPoint?: { x: number; y: number }; toPoint?: { x: number; y: number } }>(
  el: T,
  dx: number,
  dy: number
): T {
  if (el.kind !== "arrow") return { ...el, x: el.x + dx, y: el.y + dy };
  const bound = Boolean(el.fromId || el.toId);
  return {
    ...el,
    ...(bound ? {} : { x: el.x + dx, y: el.y + dy }),
    ...(el.fromPoint ? { fromPoint: { x: el.fromPoint.x + dx, y: el.fromPoint.y + dy } } : {}),
    ...(el.toPoint ? { toPoint: { x: el.toPoint.x + dx, y: el.toPoint.y + dy } } : {}),
  };
}

/** Moves a morph group and its stored sketch together, so morphing back lands under the same caption. */
export function translateMorphGroup(els: JevElement[], dx: number, dy: number): JevElement[] {
  return els.map((el) => {
    const moved = shiftElement(el, dx, dy);
    const record = el.morphMeta?.groupRecord;
    if (!record || !moved.morphMeta) return moved;
    const shifted: MorphGroupRecord = {
      ...record,
      anchorBounds: { ...record.anchorBounds, x: record.anchorBounds.x + dx, y: record.anchorBounds.y + dy },
      sketchSnapshot: record.sketchSnapshot.map((s) => shiftElement(s, dx, dy)),
    };
    return { ...moved, morphMeta: { ...moved.morphMeta, groupRecord: shifted } };
  });
}

const EMPTY_SPEC: Omit<MorphSemanticSpec, "summary"> = {
  actors: [],
  messages: [],
  steps: [],
  states: [],
  transitions: [],
  entities: [],
  relations: [],
};

interface HldLayout {
  boxes: Map<string, JevElement>;
}

/** The HLD part a view came from, copied as a left-to-right chain and morphed with the engine. */
function morphView(
  def: BoardDef,
  hld: HldLayout,
  view: "er" | "seq",
  from: string[],
  notation: "er" | "sequence",
  spec: MorphSemanticSpec
): JevElement[] {
  const prefix = `${def.id}_${view}`;
  const src = from.map((nodeId, i) => {
    const node = hld.boxes.get(nodeId);
    if (!node) throw new Error(`${def.id}: ${view} view names unknown HLD node ${nodeId}`);
    return { ...node, ...base(`${prefix}_src_${nodeId}`), x: i * 240, y: 0 };
  });
  const links = src.slice(1).flatMap((to, i) => {
    const hldEdge = def.edges.find((e) => e.from === from[i] && e.to === from[i + 1]);
    return hldEdge ? [arrow(`${prefix}_src_link_${i}`, src[i].id, to.id, hldEdge.label)] : [];
  });
  const sketch = [...src, ...links];
  const morph = morphSelectionToNotation(
    src.map((s) => s.id),
    sketch,
    notation,
    { specOverride: spec, now: NOW, isHeuristic: false }
  );
  if (!morph) throw new Error(`${def.id}: the morph engine rejected the ${view} spec`);
  const keep = new Set(sketch.map((e) => e.id));
  return renameMorphIds(applyMorphToBoard(sketch, morph), keep, prefix);
}

function sequenceSpec(def: BoardDef, hld: HldLayout): MorphSemanticSpec {
  const seq = def.sequence;
  const semId = new Map(seq.from.map((nodeId, i) => [nodeId, `sem_${i}`]));
  const ref = (nodeId: string) => {
    const id = semId.get(nodeId);
    if (!id) throw new Error(`${def.id}: sequence message uses ${nodeId}, which is not in sequence.from`);
    return id;
  };
  return {
    ...EMPTY_SPEC,
    summary: seq.summary,
    actors: seq.from.map((nodeId) => {
      const node = hld.boxes.get(nodeId)!;
      return { id: ref(nodeId), label: node.label, kind: node.kind === "actor" ? "actor" : "node", tone: node.tone };
    }),
    messages: seq.messages.map((m, i) => ({ ...m, id: `msg_${i + 1}`, order: i + 1, from: ref(m.from), to: ref(m.to) })),
    fragments: seq.fragments.map((f, i) => ({ ...f, id: `frag_${i + 1}` })),
    entities: def.er.entities,
    relations: def.er.relations,
  };
}

function erSpec(def: BoardDef, seqSpec: MorphSemanticSpec): MorphSemanticSpec {
  return { ...seqSpec, summary: `${def.title} data model` };
}

const ER_CELL_W = 380;
const ER_CELL_H = 230;

function placeEntities(els: JevElement[], grid: Record<string, [number, number]> | undefined): JevElement[] {
  if (!grid) return els;
  return els.map((el) => {
    const cell = el.kind === "entity" ? grid[el.morphMeta?.semanticId ?? ""] : undefined;
    return cell ? { ...el, x: cell[0] * ER_CELL_W, y: cell[1] * ER_CELL_H } : el;
  });
}

function moveTo(els: JevElement[], x: number, y: number): JevElement[] {
  const b = computeBounds(els.filter((e) => e.kind !== "arrow"))!;
  return translateMorphGroup(els, Math.round(x - b.x), Math.round(y - b.y));
}

function boundsOf(els: JevElement[]): ElementBox {
  return computeBounds(els.filter((e) => e.kind !== "arrow" || (!e.fromId && !e.toId)))!;
}

const TONE_BY_KIND: Partial<Record<ShapeKind, ColorTone>> = {
  actor: "terracotta",
  lb: "slate",
  node: "cobalt",
  queue: "ochre",
  cache: "plum",
  database: "teal",
  blob: "teal",
  external: "slate",
};

export function composeBoard(def: BoardDef): JevElement[] {
  const id = (k: string) => `${def.id}_${k}`;

  // Left column: requirements, numbers, API, trade-offs.
  const req = fittedCard(
    id("requirements"),
    0,
    0,
    LEFT_W,
    "Requirements",
    [...def.functional.map((l) => `F: ${l}`), ...def.nonFunctional.map((l) => `NF: ${l}`)],
    "cobalt"
  );
  const nums = fittedCard(id("numbers"), 0, req.y + req.height + 28, LEFT_W, "Numbers", numbersLines(def.numbers), "ochre");
  const api = fittedApi(id("api"), 0, nums.y + nums.height + 28, LEFT_W, def.api.label, def.api.lines);
  const trade = fittedCard(id("tradeoffs"), 0, api.y + api.height + 28, LEFT_W, "Trade-offs", def.tradeoffs, "plum");

  // HLD: grid cells right of the left column; the zone wraps every node not marked outside.
  const hldX = LEFT_W + GAP + 40;
  const hldY = ZONE_HEAD + ZONE_PAD;
  const boxes = new Map<string, JevElement>();
  for (const n of def.nodes) {
    const size = { width: n.width ?? (n.kind === "actor" ? 72 : 176), height: n.height ?? (n.kind === "actor" ? 104 : n.kind === "database" || n.kind === "blob" ? 96 : 78) };
    const cellW = def.cellW ?? CELL_W;
    const cx = hldX + n.col * cellW + cellW / 2;
    const cy = hldY + n.row * CELL_H + CELL_H / 2;
    boxes.set(
      n.id,
      shape(id(n.id), n.kind, { x: Math.round(cx - size.width / 2), y: Math.round(cy - size.height / 2), ...size }, n.label, TONE_BY_KIND[n.kind] ?? "ink", n.sublabel)
    );
  }
  const inside = def.nodes.filter((n) => !n.outside).map((n) => boxes.get(n.id)!);
  const ib = computeBounds(inside)!;
  const zone = shape(
    id("zone"),
    "zone",
    { x: ib.x - ZONE_PAD, y: ib.y - ZONE_PAD - ZONE_HEAD, width: ib.width + 2 * ZONE_PAD, height: ib.height + 2 * ZONE_PAD + ZONE_HEAD },
    def.zoneLabel,
    "slate"
  );
  const edges = def.edges.map((e, i) => {
    const tone: ColorTone = e.path === "write" ? "terracotta" : e.path === "read" ? "cobalt" : "ink";
    return arrow(id(`edge_${i}`), id(e.from), id(e.to), e.label, {
      tone,
      startEnd: "none",
      endEnd: e.async ? "open" : "arrow",
      ...(e.async ? { dashed: true } : {}),
    });
  });
  const culprit = boxes.get(def.breaks.culprit);
  if (!culprit) throw new Error(`${def.id}: breaks culprit ${def.breaks.culprit} is not an HLD node`);
  const breaksProbe = fittedCard(id("breaks"), 0, 0, BREAKS_W, "Breaks at 10×", def.breaks.lines, "terracotta");
  const breaksX = Math.round(culprit.x + culprit.width / 2 - BREAKS_W / 2);
  const breaksY = def.breaks.side === "below" ? zone.y + zone.height + 44 : zone.y - 44 - breaksProbe.height;
  const breaksCard = { ...breaksProbe, x: breaksX, y: breaksY };
  const breaksArrow = arrow(id("breaks_arrow"), breaksCard.id, culprit.id, "bottleneck", {
    tone: "terracotta",
    dashed: true,
    startEnd: "none",
    endEnd: "arrow",
  });
  const legend = fittedCard(
    id("legend"),
    0,
    trade.y + trade.height + 28,
    LEFT_W,
    "Legend",
    ["terracotta = write path, cobalt = read path", "solid = sync call, dashed = async (queue / event)"],
    "slate"
  );
  const hb = computeBounds([zone, ...boxes.values(), breaksCard])!;

  // Right column: ER, then the sequence, each under a caption card naming its HLD source.
  const hldLayout: HldLayout = { boxes };
  const seqSpec = sequenceSpec(def, hldLayout);
  const rightX = hb.x + hb.width + GAP + 40;
  const fromText = (ids: string[]) => ids.map((n) => boxes.get(n)!.label.replace(/\n/g, " ")).join(" > ");

  const erCaption = fittedCard(
    id("er_caption"),
    rightX,
    0,
    560,
    `ER · ${def.er.caption}`,
    [`Morphed from HLD: ${fromText(def.er.from)}`, "Select it and Morph to go back to the sketch"],
    "teal"
  );
  let erEls = morphView(def, hldLayout, "er", def.er.from, "er", erSpec(def, seqSpec));
  erEls = placeEntities(erEls, def.er.grid);
  erEls = moveTo(erEls, rightX, erCaption.y + erCaption.height + 40);
  const erB = boundsOf(erEls);

  const seqCaption = fittedCard(
    id("seq_caption"),
    rightX,
    erB.y + erB.height + 56,
    560,
    `Sequence · ${def.sequence.caption}`,
    [`Morphed from HLD: ${fromText(def.sequence.from)}`, "Select it and Morph to go back to the sketch"],
    "cobalt"
  );
  let seqEls = morphView(def, hldLayout, "seq", def.sequence.from, "sequence", seqSpec);
  seqEls = moveTo(seqEls, rightX, seqCaption.y + seqCaption.height + 36);

  return [
    zone,
    req,
    nums,
    api,
    trade,
    ...boxes.values(),
    ...edges,
    legend,
    breaksCard,
    breaksArrow,
    erCaption,
    ...erEls,
    seqCaption,
    ...seqEls,
  ];
}
