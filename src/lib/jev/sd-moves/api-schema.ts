import { computeBounds, findFreeSpot, isShapeElement, makeSeed, uid } from "../geometry";
import { parseApiCard } from "../notation-kinds";
import { positionElementsAtTopLeft } from "../placement-engine";
import type { JevElement } from "../types";
import { entityKey, fieldKey, plural, singular } from "./board";

export interface ApiSource {
  id: string;
  label: string;
  sublabel?: string;
}

export interface ProposedEntity {
  name: string;
  rows: string[];
  sourceIds: string[];
}

export interface ProposedRelation {
  parent: string;
  child: string;
  label: string;
}

export interface SchemaProposal {
  entities: ProposedEntity[];
  relations: ProposedRelation[];
  /** Entities the APIs name that are already on the board. */
  existing: string[];
}

const API_LABEL_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+\//i;
const SKIP_FIELDS = new Set([
  "id",
  "cursor",
  "next_cursor",
  "page",
  "limit",
  "offset",
  "items_count",
  "data",
  "results",
  "total_count",
  "error",
  "message",
  "code",
  "none",
  "empty",
  "null",
  "ok",
  "json",
  "body",
  "header",
  "headers",
  "query",
  "path",
  "params",
]);

/** Selected API cards or "POST /orders" shapes; with none selected, every API card (or such shape) on the board. */
export function apiSources(elements: JevElement[], selectedIds: string[]): JevElement[] {
  const isApi = (e: JevElement) => e.kind === "api" || (isShapeElement(e) && API_LABEL_RE.test(e.label.trim()));
  const selected = new Set(selectedIds);
  const picked = elements.filter((e) => selected.has(e.id) && isApi(e));
  if (picked.length > 0) return picked;
  const cards = elements.filter((e) => e.kind === "api");
  return cards.length > 0 ? cards : elements.filter(isApi);
}

/** Resource segments of a path, as plural table names: "/v1/users/{id}/orders" → users, orders. */
export function resources(path: string): Array<{ name: string }> {
  return path
    .split("?")[0]
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && !/^v\d+$/i.test(s) && s.toLowerCase() !== "api" && !/^[{:<]/.test(s))
    .map((s) => ({ name: plural(entityKey(s)) }));
}

/** Field names in an API row: the identifiers inside `{...}`, or the bare words when there are no braces. */
export function fieldsOf(text: string): string[] {
  const braces = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const source = braces.length > 0 ? braces.join(",") : text.replace(/\b\d{3}\b/g, " ");
  return source
    .split(/[,\s]+/)
    .map((t) => t.replace(/\[\]$/, "").replace(/[?!]$/, ""))
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(t))
    .map(fieldKey)
    .filter((f) => f && !SKIP_FIELDS.has(f));
}

export function columnType(field: string): string {
  if (/_id$/.test(field)) return "uuid";
  if (/^(is|has|can)_|_(enabled|verified|active)$|^(active|verified|enabled|deleted)$/.test(field)) return "bool";
  if (/_(at|on)$|^(date|time|timestamp)$/.test(field)) return "timestamptz";
  if (/^(qty|quantity|count|age|position|rank|version|stock)$|_(count|cents|qty|seconds|ms)$/.test(field)) return "int";
  if (/^(price|amount|total|balance|rate|lat|lng|latitude|longitude|score)$|_(price|amount|total|rate)$/.test(field)) return "numeric";
  return "text";
}

interface Draft {
  name: string;
  fks: string[];
  cols: string[];
  idem: boolean;
  sourceIds: string[];
}

/** Turns API cards into ER entities (PK, FK, typed columns) and the parent → child relations between them. */
export function proposeSchema(apis: ApiSource[], existingEntityNames: string[]): SchemaProposal {
  const drafts = new Map<string, Draft>();
  const relations: ProposedRelation[] = [];
  const draft = (name: string) => {
    const key = entityKey(name);
    if (!drafts.has(key)) drafts.set(key, { name, fks: [], cols: [], idem: false, sourceIds: [] });
    return drafts.get(key)!;
  };
  const relate = (parent: string, child: Draft) => {
    const fk = `${singular(entityKey(parent))}_id`;
    if (!child.fks.includes(fk)) child.fks.push(fk);
    if (!relations.some((r) => r.parent === parent && r.child === child.name)) relations.push({ parent, child: child.name, label: fk });
  };

  for (const api of apis) {
    const card = parseApiCard(api.label, api.sublabel);
    const chain = resources(card.path);
    if (chain.length === 0) continue;
    chain.forEach((r) => draft(r.name));
    const target = draft(chain[chain.length - 1].name);
    if (!target.sourceIds.includes(api.id)) target.sourceIds.push(api.id);
    if (chain.length > 1) relate(chain[chain.length - 2].name, target);
    const selfKey = entityKey(target.name);
    for (const row of card.rows) {
      if (row.key === "idem") {
        target.idem = true;
        continue;
      }
      if (row.key !== "req" && row.key !== "res") continue;
      for (const f of fieldsOf(row.text)) {
        if (f === `${selfKey}_id` || entityKey(f) === selfKey) continue;
        if (/_id$/.test(f)) {
          const parent = plural(entityKey(f.slice(0, -3)));
          draft(parent);
          relate(parent, target);
        } else if (!target.cols.includes(f)) {
          target.cols.push(f);
        }
      }
    }
  }

  const existingKeys = new Set(existingEntityNames.map(entityKey));
  const existing = [...drafts.values()].filter((d) => existingKeys.has(entityKey(d.name))).map((d) => d.name);
  const depth = (name: string, seen = new Set<string>()): number => {
    const parent = relations.find((r) => r.child === name && !seen.has(r.parent));
    return parent ? 1 + depth(parent.parent, new Set(seen).add(name)) : 0;
  };
  const entities = [...drafts.values()]
    .filter((d) => !existingKeys.has(entityKey(d.name)))
    .map((d, order) => ({ d, order, depth: depth(d.name) }))
    .sort((a, b) => a.depth - b.depth || a.order - b.order)
    .map(({ d }) => ({
      name: d.name,
      sourceIds: d.sourceIds,
      rows: [
        "id uuid PK",
        ...d.fks.map((fk) => `${fk} uuid FK`),
        ...d.cols.map((c) => `${c} ${columnType(c)}`),
        ...(d.idem ? ["idempotency_key text UK"] : []),
        ...(d.sourceIds.length > 0 ? ["created_at timestamptz"] : []),
      ],
    }));
  return { entities, relations, existing };
}

const ENTITY_W = 220;
const COL_GAP = 90;
const ROW_GAP = 40;

export function entityHeight(rows: number): number {
  return 30 + 5 + rows * 18 + 10;
}

/** Entity shapes to the right of the source API cards, one column per FK depth, plus crow's-foot relations. */
export function buildSchemaElements(proposal: SchemaProposal, boardElements: JevElement[], now: number): JevElement[] {
  const sourceIds = new Set(proposal.entities.flatMap((e) => e.sourceIds));
  const anchor = computeBounds(boardElements.filter((e) => sourceIds.has(e.id))) ?? computeBounds(boardElements) ?? { x: 0, y: 0, width: 0, height: 0 };
  const depthOf = new Map<string, number>();
  for (const e of proposal.entities) {
    const parent = proposal.relations.find((r) => r.child === e.name && depthOf.has(r.parent));
    depthOf.set(e.name, parent ? depthOf.get(parent.parent)! + 1 : 0);
  }
  const colY = new Map<number, number>();
  const byName = new Map<string, string>();
  const shapes: JevElement[] = proposal.entities.map((e) => {
    const depth = depthOf.get(e.name)!;
    const y = colY.get(depth) ?? anchor.y;
    const height = entityHeight(e.rows.length);
    colY.set(depth, y + height + ROW_GAP);
    const id = uid("ent");
    byName.set(entityKey(e.name), id);
    return {
      id,
      kind: "entity",
      x: Math.round(anchor.x + anchor.width + 80 + depth * (ENTITY_W + COL_GAP)),
      y: Math.round(y),
      width: ENTITY_W,
      height,
      label: e.name,
      sublabel: e.rows.join("\n"),
      tone: "teal",
      seed: makeSeed(id),
      createdAt: now,
      updatedAt: now,
    };
  });
  for (const el of boardElements) {
    if (el.kind === "entity" && !byName.has(entityKey(el.label))) byName.set(entityKey(el.label), el.id);
  }
  const relations: JevElement[] = proposal.relations.flatMap((r) => {
    const fromId = byName.get(entityKey(r.parent));
    const toId = byName.get(entityKey(r.child));
    if (!fromId || !toId) return [];
    const id = uid("rel");
    return [
      {
        id,
        kind: "arrow" as const,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fromId,
        toId,
        label: r.label,
        tone: "ink" as const,
        seed: makeSeed(id),
        arrowStyle: "straight" as const,
        startEnd: "er_only_one" as const,
        endEnd: "er_zero_many" as const,
        createdAt: now,
        updatedAt: now,
      },
    ];
  });
  const bounds = computeBounds(shapes);
  if (!bounds) return relations;
  const spot = findFreeSpot(bounds, boardElements, 60, 80);
  const placed = spot.x === bounds.x && spot.y === bounds.y ? shapes : positionElementsAtTopLeft(shapes, { x: spot.x, y: spot.y });
  return [...placed, ...relations];
}
