// Charles/Caren, 21 Nov: the full (c) option and big clusters were a tangle: edges through nodes, stacked labels,
// crossings. Every option is judged by the geometry the canvas actually draws.
import { describe, expect, it } from "vitest";
import { ghostClarity } from "@/lib/jev/ghost-geometry";
import { buildNextOptions, type NextOptionsInput } from "@/lib/jev/next-options";
import type { JevElement } from "@/lib/jev/types";

const el = (o: Partial<JevElement> & { id: string; label: string }): JevElement => ({
  kind: "node", x: 100, y: 100, width: 172, height: 72, tone: "cobalt", seed: 1, createdAt: 1, updatedAt: 1, ...o,
});
const arrow = (id: string, fromId: string, toId: string): JevElement =>
  el({ id, kind: "arrow", label: "", fromId, toId, x: 0, y: 0, width: 0, height: 0 });

const fixtures: Array<[string, NextOptionsInput, number]> = [
  ["S1 Client Dashboard + apigateway", { elements: [el({ id: "cd", label: "Client Dashboard", x: 200, y: 160 })], text: "apigateway" }, 1],
  ["S1b App + api gateway", { elements: [el({ id: "app", label: "App", x: 200, y: 160 })], text: "api gateway" }, 1],
  ["S2 blank + url shortener", { elements: [], text: "url shortener", viewportCenter: { x: 600, y: 400 } }, 1],
  [
    "S3 Checkout + Inventory selected",
    { elements: [el({ id: "co", label: "Checkout", x: 100, y: 100 }), el({ id: "inv", label: "Inventory", x: 100, y: 360 })], selectedIds: ["co", "inv"] },
    1,
  ],
  [
    "S4 Client -> API -> DB, DB selected",
    {
      elements: [
        el({ id: "c", label: "Client", x: 0, y: 200 }),
        el({ id: "api", label: "API", x: 320, y: 200 }),
        el({ id: "db", label: "DB", kind: "database", x: 640, y: 200, width: 156, height: 86 }),
        arrow("a1", "c", "api"),
        arrow("a2", "api", "db"),
      ],
      selectedIds: ["db"],
    },
    1,
  ],
  ["Web App created", { elements: [el({ id: "w", label: "Web App", x: 300, y: 300 })], subjectId: "w" }, 1],
];

describe("ghost previews are readable: no edge through a node, no overlapping labels, few crossings", () => {
  for (const [name, input, maxCrossings] of fixtures) {
    const res = buildNextOptions(input)!;
    for (const option of res.options) {
      it(`${name} · ${option.tier}`, () => {
        const c = ghostClarity(input.elements, option.addElements);
        expect(c.edgeThroughShape, "edges drawn through other nodes").toEqual([]);
        expect(c.labelOverlaps, "edge labels on top of each other").toEqual([]);
        expect(c.labelOnShape, "edge labels on top of nodes").toEqual([]);
        expect(c.crossings).toBeLessThanOrEqual(maxCrossings);
      });
    }
  }
});
