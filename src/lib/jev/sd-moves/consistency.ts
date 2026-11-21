import { parseApiCard, parseClassCompartments, parseEntityRows } from "../notation-kinds";
import type { JevElement } from "../types";
import { fieldsOf, resources } from "./api-schema";
import { displayName, entityKey, fieldKey } from "./board";

export interface Mismatch {
  text: string;
  /** The shapes involved: the first is the one to fix. */
  elementIds: string[];
}

export interface ConsistencyResult {
  status: "found" | "clean" | "nothing";
  mismatches: Mismatch[];
  /** Entity keys that appear in at least two notations and were compared. */
  compared: string[];
}

interface Named {
  el: JevElement;
  name: string;
}
interface ClassSide extends Named {
  attrs: string[];
}
interface TableSide extends Named {
  columns: string[];
  keys: Set<string>;
}
interface ApiSide extends Named {
  req: string[];
  res: string[];
}

const IGNORED_COLUMNS = new Set(["id", "created_at", "updated_at", "deleted_at", "idempotency_key"]);

function has(set: string[], field: string): boolean {
  return set.includes(field) || set.includes(`${field}_id`) || (field.endsWith("_id") && set.includes(field.slice(0, -3)));
}

function groupBy<T extends Named>(items: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    const key = entityKey(item.name);
    if (!out.has(key)) out.set(key, item);
  }
  return out;
}

/** Compares UML class attributes, API card fields and ER entity columns that share a normalized name. */
export function checkConsistency(elements: JevElement[]): ConsistencyResult {
  const classes = groupBy<ClassSide>(
    elements
      .filter((e) => e.kind === "class")
      .map((el) => ({ el, name: displayName(el), attrs: parseClassCompartments(el.sublabel).attributes.map(fieldKey).filter(Boolean) }))
  );
  const tables = groupBy<TableSide>(
    elements
      .filter((e) => e.kind === "entity")
      .map((el) => {
        const rows = parseEntityRows(el.sublabel);
        return {
          el,
          name: displayName(el),
          columns: rows.map((r) => fieldKey(r.name)),
          keys: new Set(rows.filter((r) => r.keys.length > 0).map((r) => fieldKey(r.name))),
        };
      })
  );
  const apis: Array<ApiSide & { key: string }> = elements
    .filter((e) => e.kind === "api")
    .flatMap((el) => {
      const card = parseApiCard(el.label, el.sublabel);
      const chain = resources(card.path);
      if (chain.length === 0) return [];
      const key = entityKey(chain[chain.length - 1].name);
      const rowFields = (k: "req" | "res") =>
        card.rows.filter((r) => r.key === k).flatMap((r) => fieldsOf(r.text)).filter((f) => f !== `${key}_id` && entityKey(f) !== key);
      return [{ el, name: el.label.trim().replace(/\s+/g, " "), key, req: rowFields("req"), res: rowFields("res") }];
    });

  const keys = [...new Set([...classes.keys(), ...tables.keys(), ...apis.map((a) => a.key)])];
  const mismatches: Mismatch[] = [];
  const compared: string[] = [];
  for (const key of keys) {
    const cls = classes.get(key);
    const tbl = tables.get(key);
    const endpoints = apis.filter((a) => a.key === key);
    if ([cls, tbl, endpoints.length > 0 ? endpoints : undefined].filter(Boolean).length < 2) continue;
    compared.push(key);
    if (cls && tbl) {
      for (const a of cls.attrs) {
        if (!IGNORED_COLUMNS.has(a) && !has(tbl.columns, a)) {
          mismatches.push({ text: `${cls.name}.${a} has no column in ${tbl.name}`, elementIds: [cls.el.id, tbl.el.id] });
        }
      }
      for (const c of tbl.columns) {
        if (!IGNORED_COLUMNS.has(c) && !tbl.keys.has(c) && !has(cls.attrs, c)) {
          mismatches.push({ text: `${tbl.name}.${c} is not on class ${cls.name}`, elementIds: [tbl.el.id, cls.el.id] });
        }
      }
    }
    for (const api of endpoints) {
      const store = tbl ?? cls!;
      const fields = tbl ? tbl.columns : cls!.attrs;
      for (const f of api.req) {
        if (!has(fields, f)) {
          const where = tbl ? `not stored in ${tbl.name}` : `not on class ${cls!.name}`;
          mismatches.push({ text: `${api.name} takes ${f}, ${where}`, elementIds: [api.el.id, store.el.id] });
        }
      }
      for (const f of api.res) {
        if (!has(fields, f) && !(cls && has(cls.attrs, f))) {
          const where = tbl ? `no column in ${tbl.name}` : `no attribute on ${cls!.name}`;
          mismatches.push({ text: `${api.name} returns ${f}: ${where}`, elementIds: [api.el.id, store.el.id] });
        }
      }
    }
  }
  if (compared.length === 0) return { status: "nothing", mismatches: [], compared: [] };
  return { status: mismatches.length > 0 ? "found" : "clean", mismatches, compared };
}
