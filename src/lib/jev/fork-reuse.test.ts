import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/url-shortener-hld.json";
import { singletonRoleOf } from "./component-catalog";
import { buildConstraintForkTakes } from "./fork-catalogue";
import { FORK_PRESSURES } from "./fork-constraint";
import {
  applyForkTakeToBoard,
  buildLocalForkTakes,
  extractSelectedSubgraph,
  materializeForkTake,
  validateForkTakesPayload,
  type ForkTake,
} from "./fork-engine";
import { rectsOverlap } from "./geometry";
import { buildNextOptions } from "./next-options";
import { generateCandidatePool } from "./prediction-engine";
import { STARTER_BOARDS } from "./starter-boards";
import type { JevElement } from "./types";

// SD Sensei, 21 Nov 2026: on this board the Cache-First take added a second cache, a replica and a ghost
// Postgres next to the existing "Redis cache" and "URL DB", and rewired every API arrow to the new cache.
const board = fixture as JevElement[];
const API = "el_kb895st";
const REDIS = "el_6bbgrtc";
const URL_DB = "el_yfhxdsc";
const EDGE = "el_l8hq9sp";

const isShape = (e: JevElement) => !["arrow", "freedraw", "frame", "zone"].includes(e.kind);
const isContainer = (e: JevElement) => e.kind === "frame" || e.kind === "zone";

function roleCounts(elements: JevElement[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of elements.filter(isShape)) {
    const role = singletonRoleOf(e);
    if (role) counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

/** A role the board had exactly once (its cache, its database, its edge) is still there once: the take reused it. */
function duplicatedRoles(before: JevElement[], after: JevElement[]): string[] {
  const was = roleCounts(before);
  const now = roleCounts(after);
  return Object.keys(was).filter((role) => was[role] === 1 && (now[role] ?? 0) > 1);
}

function overlaps(after: JevElement[], take: ForkTake): string[] {
  const newIds = new Set(take.elements.map((e) => e.id));
  const shapes = after.filter(isShape);
  const hits: string[] = [];
  for (const a of shapes.filter((s) => newIds.has(s.id))) {
    for (const b of shapes) {
      if (a.id !== b.id && rectsOverlap(a, b) && !hits.includes(`${b.label} x ${a.label}`)) {
        hits.push(`${a.label} x ${b.label}`);
      }
    }
  }
  const memberIds = (frame: JevElement) =>
    new Set(take.elements.filter((e) => isShape(e) && rectsOverlap(frame, e) && newIds.has(e.id)).map((e) => e.id));
  for (const frame of after.filter((e) => isContainer(e) && newIds.has(e.id))) {
    const members = memberIds(frame);
    for (const s of shapes) {
      if (!newIds.has(s.id) && !members.has(s.id) && rectsOverlap(frame, s)) hits.push(`zone ${frame.label} x ${s.label}`);
    }
  }
  return hits;
}

function arrowsInto(elements: JevElement[], id: string): JevElement[] {
  return elements.filter((e) => e.kind === "arrow" && e.toId === id);
}

function checkTake(take: ForkTake, replacedIds: string[]) {
  const after = applyForkTakeToBoard(board, replacedIds, take);
  const byId = new Map(after.map((e) => [e.id, e]));
  return {
    after,
    report: {
      take: take.title,
      duplicatedRoles: duplicatedRoles(board, after),
      overlaps: overlaps(after, take),
      redisKept: byId.has(REDIS),
      urlDbKept: byId.has(URL_DB),
      keptShapesMoved: board
        .filter((e) => isShape(e) && !replacedIds.includes(e.id))
        .filter((e) => {
          const now = byId.get(e.id);
          return !now || now.x !== e.x || now.y !== e.y;
        })
        .map((e) => e.label),
    },
  };
}

const clean = (title: string) => ({
  take: title,
  duplicatedRoles: [],
  overlaps: [],
  redisKept: true,
  urlDbKept: true,
  keptShapesMoved: [],
});

describe("fork reuses the board's existing nodes (URL shortener board)", () => {
  it("every classic take reuses Redis and URL DB, adds no second cache/database, overlaps nothing", () => {
    const fork = buildLocalForkTakes([API], board, 1000)!;
    expect(fork.takes).toHaveLength(3);
    for (const take of fork.takes) {
      expect(checkTake(take, fork.replacedIds).report).toEqual(clean(take.title));
    }
  });

  it("every constraint (pattern catalogue) take does the same", () => {
    for (const pressure of FORK_PRESSURES) {
      const fork = buildConstraintForkTakes([API], board, { pressure }, 1000)!;
      for (const take of fork.takes) {
        expect(checkTake(take, fork.replacedIds).report).toEqual(clean(take.title));
      }
    }
  });

  it("Cache-First: the take's cache is the board's Redis and the API's own arrows stay on the API", () => {
    const fork = buildLocalForkTakes([API], board, 1000)!;
    const take = fork.takes.find((t) => t.archetype === "cache_read_replica")!;
    const { after } = checkTake(take, fork.replacedIds);
    const labels = take.elements.filter(isShape).map((e) => e.label);
    expect(labels).not.toContain("Read Cache");
    expect(labels).not.toContain("Postgres DB");
    const api = after.find((e) => e.label === "API service")!;
    const hit = after.find((e) => e.label === "Cache Hit?")!;
    // The cache-hit decision reads from the existing Redis.
    expect(arrowsInto(after, REDIS).some((a) => a.fromId === hit.id)).toBe(true);
    // W1/W2/R1/R4 still leave the API service, not the new cache.
    for (const label of ["W1 next id", "W2 insert · R2 read on miss", "R1 get code · R3 set on miss", "R4 click event (async)"]) {
      const arrow = after.find((e) => e.kind === "arrow" && e.label === label);
      expect({ label, from: arrow?.fromId }).toEqual({ label, from: api.id });
    }
    // The replica replicates from the board's database.
    const replica = after.find((e) => isShape(e) && /replica/i.test(e.label))!;
    expect(arrowsInto(after, replica.id).some((a) => a.fromId === URL_DB)).toBe(true);
  });

  it("Gateway take fronts the API with the board's Edge instead of a second gateway", () => {
    const fork = buildLocalForkTakes([API], board, 1000)!;
    const take = fork.takes.find((t) => t.archetype === "gateway_edge_split" || t.archetype === "resilient_mesh")!;
    const { after } = checkTake(take, fork.replacedIds);
    expect(after.filter((e) => isShape(e) && singletonRoleOf(e) === "edge").map((e) => e.id)).toEqual([EDGE]);
  });

  it("an LLM take naming Redis Cache and Postgres DB is materialized onto Redis and URL DB", () => {
    const validated = validateForkTakesPayload({
      takes: [0, 1, 2].map((i) => ({
        archetype: "cache_read_replica",
        title: `Cache take ${i}`,
        rationale: "Serve hot codes from Redis, misses from the database",
        tradeoffTag: "Cache invalidation",
        graph: {
          notation: "architecture",
          summary: "Cache-aside",
          nodes: [
            { id: "api", label: "API service", kind: "node" },
            { id: "cache", label: "Redis Cache", kind: "cache" },
            { id: "db", label: "Postgres DB", kind: "database" },
            { id: "rep", label: "Read Replica", kind: "database" },
          ],
          edges: [
            { from: "api", to: "cache", label: "get" },
            { from: "cache", to: "db", label: "on miss" },
            { from: "db", to: "rep", label: "replicate", dashed: true },
            { from: "api", to: "rep", label: "reads" },
          ],
        },
      })),
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const subgraph = extractSelectedSubgraph([API], board)!;
    const take = materializeForkTake(validated.takes[0], subgraph, 1000);
    const labels = take.elements.filter(isShape).map((e) => e.label);
    expect(labels).not.toContain("Redis Cache");
    expect(labels).not.toContain("Postgres DB");
    const rep = take.elements.find((e) => e.label === "Read Replica")!;
    expect(take.elements.some((e) => e.kind === "arrow" && e.fromId === URL_DB && e.toId === rep.id)).toBe(true);
    expect(checkTake(take, subgraph.replacedIds).report).toEqual(clean(take.title));
    // One arrow per pair: the board's own API -> Redis arrow is kept, the take's "get" is not drawn twice.
    const after = applyForkTakeToBoard(board, subgraph.replacedIds, take);
    const api = after.find((e) => e.label === "API service")!;
    expect(after.filter((e) => e.kind === "arrow" && e.fromId === api.id && e.toId === REDIS)).toHaveLength(1);
  });

  it("ghost previews do not cover existing shapes either", () => {
    const fork = buildLocalForkTakes([API], board, 1000)!;
    const kept = board.filter((e) => isShape(e) && !fork.replacedIds.includes(e.id));
    for (const take of fork.takes) {
      const hits = take.previewElements
        .filter(isShape)
        .flatMap((p) => kept.filter((k) => rectsOverlap(p, k)).map((k) => `${p.label} x ${k.label}`));
      expect({ take: take.title, hits }).toEqual({ take: take.title, hits: [] });
    }
  });

  it("on every starter board, forking any HLD service never adds a second of a role the board has once, and covers nothing", () => {
    for (const starter of STARTER_BOARDS) {
      const elements = starter.build();
      const services = elements.filter((e) => e.kind === "node" && !e.morphMeta);
      for (const svc of services) {
        const fork = buildLocalForkTakes([svc.id], elements, 1000)!;
        for (const take of fork.takes) {
          const after = applyForkTakeToBoard(elements, fork.replacedIds, take);
          expect({ where: `${starter.id} / ${svc.label} / ${take.title}`, dup: duplicatedRoles(elements, after), overlaps: overlaps(after, take) }).toEqual({
            where: `${starter.id} / ${svc.label} / ${take.title}`,
            dup: [],
            overlaps: [],
          });
        }
      }
    }
  });

  it("after a take is accepted, the follow-up options do not offer a second database or cache either", () => {
    const fork = buildLocalForkTakes([API], board, 1000)!;
    for (const take of fork.takes) {
      const after = applyForkTakeToBoard(board, fork.replacedIds, take);
      for (const subjectId of [take.exitElementId, ...take.elements.filter(isShape).map((e) => e.id)]) {
        const result = buildNextOptions({ elements: after, subjectId, viewportCenter: { x: 800, y: 400 } });
        const followUp = generateCandidatePool(
          { kind: "domain_continue", headline: "Swapped in", detail: "", subjectId, relatedIds: [], timestamp: 1000 },
          after
        );
        for (const option of [...(result?.options ?? []), ...followUp]) {
          const added = option.addElements.filter(isShape);
          const dup = duplicatedRoles(after, [...after, ...added]);
          const subject = after.find((e) => e.id === subjectId)?.label;
          expect({ take: take.title, subject, option: option.title, dup }).toEqual({ take: take.title, subject, option: option.title, dup: [] });
        }
      }
    }
  });
});
