import { computeBounds, findFreeSpot, makeSeed, uid } from "./geometry";
import { DEFAULT_KIND_SIZE } from "./notation-kinds";
import { applyMorphToBoard, morphSelectionToNotation } from "./notation-morph";
import { positionElementsAtTopLeft } from "./placement-engine";
import { formatEstimateCard, parseEstimateText } from "./sd-estimate";
import { cardLayout } from "./shape-layout";
import type { JevElement, MorphNotation, MorphSemanticSpec, Point, ShapeKind } from "./types";

export const STARTER_COMMANDS = ["er", "seq", "state", "class", "api"] as const;
export type StarterCommand = (typeof STARTER_COMMANDS)[number];
export type PaletteCommand = StarterCommand | "estimate";

export interface PaletteCommandDef {
  command: PaletteCommand;
  title: string;
  hint: string;
}

export const PALETTE_COMMANDS: readonly PaletteCommandDef[] = [
  { command: "er", title: "ER diagram", hint: "Two entities, PK/FK rows, crow's-foot relation. Morphs a selection." },
  { command: "seq", title: "Sequence diagram", hint: "Three lifelines, activation bars, a return. Morphs a selection." },
  { command: "state", title: "State machine", hint: "Initial → states with [guard] / action labels → final. Morphs a selection." },
  { command: "class", title: "UML class", hint: "Two classes with compartments and inheritance." },
  { command: "api", title: "API card", hint: "POST /orders with request, response, errors, idempotency key." },
  { command: "estimate", title: "Estimate", hint: "Numbers card: /estimate 50M DAU, 10 writes/user/day, 1KB, 5y" },
];

const COMMAND_SET = new Set<string>(PALETTE_COMMANDS.map((c) => c.command));

/** "/estimate 50M DAU" → { command: "estimate", args: "50M DAU" }; anything else → null. */
export function parsePaletteInput(text: string): { command: PaletteCommand; args: string } | null {
  const m = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const command = m[1].toLowerCase();
  if (!COMMAND_SET.has(command)) return null;
  return { command: command as PaletteCommand, args: (m[2] ?? "").trim() };
}

/** Commands whose name starts with what follows the "/" (up to the first space). */
export function matchPaletteCommands(text: string): PaletteCommandDef[] {
  const m = text.trimStart().match(/^\/([a-z]*)/i);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return PALETTE_COMMANDS.filter((c) => c.command.startsWith(prefix));
}

export const PACK_IDS = ["hld", "er", "sequence", "state", "class", "api"] as const;
export type PackId = (typeof PACK_IDS)[number];

export interface PackItem {
  kind: ShapeKind;
  /** Name in this pack when it differs from KIND_LABELS (a state is drawn as a rounded box). */
  label?: string;
}

export interface PackDef {
  id: PackId;
  title: string;
  items: readonly PackItem[];
  starter: PaletteCommand;
  starterLabel: string;
}

export const PACKS: readonly PackDef[] = [
  {
    id: "hld",
    title: "HLD",
    items: [
      { kind: "actor" },
      { kind: "lb" },
      { kind: "node" },
      { kind: "queue" },
      { kind: "cache" },
      { kind: "database" },
      { kind: "blob" },
      { kind: "external" },
      { kind: "zone" },
      { kind: "card" },
    ],
    starter: "estimate",
    starterLabel: "Insert a numbers card",
  },
  { id: "er", title: "ER", items: [{ kind: "entity" }], starter: "er", starterLabel: "Insert an ER starter" },
  {
    id: "sequence",
    title: "Sequence",
    items: [{ kind: "actor" }, { kind: "node", label: "Participant" }, { kind: "activation" }, { kind: "fragment" }],
    starter: "seq",
    starterLabel: "Insert a sequence starter",
  },
  {
    id: "state",
    title: "State",
    items: [{ kind: "initial" }, { kind: "node", label: "State" }, { kind: "final" }],
    starter: "state",
    starterLabel: "Insert a state machine starter",
  },
  { id: "class", title: "Class", items: [{ kind: "class" }], starter: "class", starterLabel: "Insert a class starter" },
  { id: "api", title: "API", items: [{ kind: "api" }, { kind: "card" }], starter: "api", starterLabel: "Insert an API card" },
];

interface SketchNode {
  label: string;
  kind: ShapeKind;
}

/** Lays out a chain of sketch nodes (topological order = sem_0, sem_1, …) and morphs it with a fixed spec. */
function morphedStarter(
  nodes: SketchNode[],
  notation: Exclude<MorphNotation, "sketch">,
  spec: MorphSemanticSpec,
  center: Point,
  now: number
): JevElement[] {
  const gap = 220;
  const sketch: JevElement[] = nodes.map((n, i) => {
    const id = uid("pk");
    return {
      id,
      kind: n.kind,
      x: Math.round(center.x - ((nodes.length - 1) * gap) / 2 + i * gap - 80),
      y: Math.round(center.y - 36),
      width: 160,
      height: 72,
      label: n.label,
      tone: "ink",
      seed: makeSeed(id),
      createdAt: now,
      updatedAt: now,
    };
  });
  const links: JevElement[] = sketch.slice(1).map((to, i) => {
    const id = uid("pka");
    return {
      id,
      kind: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fromId: sketch[i].id,
      toId: to.id,
      label: "",
      tone: "ink",
      seed: makeSeed(id),
      createdAt: now,
      updatedAt: now,
    };
  });
  const board = [...sketch, ...links];
  const morph = morphSelectionToNotation(
    sketch.map((s) => s.id),
    board,
    notation,
    { specOverride: spec, now, isHeuristic: false }
  );
  if (!morph) return board;
  return applyMorphToBoard(board, morph);
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

function erStarter(center: Point, now: number): JevElement[] {
  return morphedStarter(
    [
      { label: "users", kind: "database" },
      { label: "orders", kind: "database" },
    ],
    "er",
    {
      ...EMPTY_SPEC,
      summary: "A user places many orders",
      entities: [
        { id: "sem_0", name: "users", attributes: ["id uuid PK", "email text UK", "created_at timestamptz"] },
        { id: "sem_1", name: "orders", attributes: ["id uuid PK", "total_cents int", "status text"] },
      ],
      relations: [{ id: "rel_0", from: "sem_0", to: "sem_1", cardinality: "1:N", label: "places" }],
    },
    center,
    now
  );
}

function sequenceStarter(center: Point, now: number): JevElement[] {
  return morphedStarter(
    [
      { label: "Client", kind: "actor" },
      { label: "Order API", kind: "node" },
      { label: "Orders DB", kind: "database" },
    ],
    "sequence",
    {
      ...EMPTY_SPEC,
      summary: "Create an order",
      actors: [
        { id: "sem_0", label: "Client", kind: "actor" },
        { id: "sem_1", label: "Order API", kind: "node" },
        { id: "sem_2", label: "Orders DB", kind: "database" },
      ],
      messages: [
        { id: "m1", from: "sem_0", to: "sem_1", label: "POST /orders", order: 1 },
        { id: "m2", from: "sem_1", to: "sem_2", label: "INSERT order", order: 2 },
        { id: "m3", from: "sem_2", to: "sem_1", label: "order_id", order: 3, isReturn: true },
        { id: "m4", from: "sem_1", to: "sem_0", label: "201 Created", order: 4, isReturn: true },
      ],
    },
    center,
    now
  );
}

function stateStarter(center: Point, now: number): JevElement[] {
  return morphedStarter(
    [
      { label: "Closed", kind: "node" },
      { label: "Open", kind: "node" },
    ],
    "state",
    {
      ...EMPTY_SPEC,
      summary: "Circuit breaker",
      states: [
        { id: "sem_0", label: "Closed", initial: true, terminal: true },
        { id: "sem_1", label: "Open" },
      ],
      transitions: [
        { id: "t1", from: "sem_0", to: "sem_1", event: "failure", guard: "errors ≥ 5", action: "trip()" },
        { id: "t2", from: "sem_1", to: "sem_0", event: "probe", guard: "cooldown over", action: "reset()" },
      ],
    },
    center,
    now
  );
}

function element(kind: ShapeKind, box: { x: number; y: number; width: number; height: number }, rest: Partial<JevElement>, now: number): JevElement {
  const id = uid("pk");
  return { id, kind, ...box, label: "", tone: "ink", seed: makeSeed(id), createdAt: now, updatedAt: now, ...rest };
}

function classStarter(center: Point, now: number): JevElement[] {
  const w = 220;
  const parent = element(
    "class",
    { x: Math.round(center.x - w / 2), y: Math.round(center.y - 170), width: w, height: 132 },
    { label: "«abstract»\nVehicle", sublabel: "- plate: string\n- size: Size\n--\n+ fits(spot: Spot): bool", tone: "cobalt" },
    now
  );
  const child = element(
    "class",
    { x: Math.round(center.x - w / 2), y: Math.round(center.y + 50), width: w, height: 120 },
    { label: "Car", sublabel: "- doors: int\n--\n+ fits(spot: Spot): bool", tone: "cobalt" },
    now
  );
  const id = uid("pka");
  const inherits: JevElement = {
    id,
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    fromId: child.id,
    toId: parent.id,
    label: "",
    tone: "ink",
    seed: makeSeed(id),
    arrowStyle: "straight",
    startEnd: "none",
    endEnd: "triangle",
    createdAt: now,
    updatedAt: now,
  };
  return [parent, child, inherits];
}

function apiStarter(center: Point, now: number): JevElement[] {
  const size = { width: 300, height: 128 };
  return [
    element(
      "api",
      { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2), ...size },
      {
        label: "POST /orders",
        sublabel: "req: {item_id, qty}\nres: 201 {order_id, status}\nerr: 409 duplicate, 422 bad qty\nidem: Idempotency-Key header",
        tone: "teal",
      },
      now
    ),
  ];
}

export function buildStarter(command: StarterCommand, center: Point, now: number): JevElement[] {
  switch (command) {
    case "er":
      return erStarter(center, now);
    case "seq":
      return sequenceStarter(center, now);
    case "state":
      return stateStarter(center, now);
    case "class":
      return classStarter(center, now);
    case "api":
      return apiStarter(center, now);
  }
}

const NUMBERS_CARD_WIDTH = 360;

/** A numbers card from free text ("50M DAU, 10 writes/user/day, 1KB, 5y"), tall enough for every line. */
export function buildEstimateCard(text: string, center: Point, now: number): JevElement {
  const { label, sublabel } = formatEstimateCard(parseEstimateText(text));
  const probe = cardLayout({ label, sublabel, width: NUMBERS_CARD_WIDTH, height: 10_000 });
  const height = Math.max(DEFAULT_KIND_SIZE.card.height, probe.top + probe.lines.length * probe.rowHeight + 12);
  return element(
    "card",
    { x: Math.round(center.x - NUMBERS_CARD_WIDTH / 2), y: Math.round(center.y - height / 2), width: NUMBERS_CARD_WIDTH, height },
    { label, sublabel, tone: "ochre" },
    now
  );
}

/** Moves an insert to the nearest spot that does not overlap shapes already on the board. */
export function placeInsert(insert: JevElement[], existing: JevElement[]): JevElement[] {
  const bounds = computeBounds(insert);
  if (!bounds) return insert;
  const spot = findFreeSpot(bounds, existing, Math.round(bounds.width / 2) + 40, Math.round(bounds.height) + 40);
  if (spot.x === bounds.x && spot.y === bounds.y) return insert;
  return positionElementsAtTopLeft(insert, { x: spot.x, y: spot.y });
}
