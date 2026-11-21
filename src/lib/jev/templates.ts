import { makeSeed } from "./geometry";
import { JevElement } from "./types";

export interface PromptSpark {
  label: string;
  prompt: string;
}

export const PROMPT_SPARKS: PromptSpark[] = [
  {
    label: "WebRTC Whiteboard",
    prompt: "WebRTC P2P whiteboard with signaling, STUN, and CRDT sync",
  },
  {
    label: "Auth Flow",
    prompt: "User -> Login -> Valid Token? -> [Yes: Dashboard, No: Retry] -> Postgres",
  },
  {
    label: "Microservices",
    prompt: "Microservices architecture with API gateway, auth, billing, redis, and postgres",
  },
  {
    label: "AI Agent RAG",
    prompt: "AI agent RAG pipeline with vector db, tools, and streaming UI",
  },
  {
    label: "Compare",
    prompt: "WebRTC P2P vs Central WebSocket Server",
  },
];

/**
 * Clean, breathable starter diagram that showcases Skot immediately on load:
 * Drag any box to test spatial intent understanding, or press Tab + Enter right away!
 */
const STARTER_TS = 1700000000000;

export function createStarterElements(): JevElement[] {
  const now = STARTER_TS;
  const user: JevElement = {
    id: "starter_user",
    kind: "ellipse",
    x: 110,
    y: 220,
    width: 152,
    height: 74,
    label: "You & Peers",
    sublabel: "Speed of thought",
    tone: "terracotta",
    seed: makeSeed("starter_user"),
    createdAt: now,
    updatedAt: now,
  };

  const canvas: JevElement = {
    id: "starter_canvas",
    kind: "node",
    x: 370,
    y: 220,
    width: 186,
    height: 74,
    label: "Skot Canvas",
    sublabel: "Spatial intent + Tab",
    tone: "cobalt",
    seed: makeSeed("starter_canvas"),
    createdAt: now,
    updatedAt: now,
  };

  const mesh: JevElement = {
    id: "starter_mesh",
    kind: "node",
    x: 668,
    y: 220,
    width: 184,
    height: 74,
    label: "WebRTC Mesh",
    sublabel: "Direct P2P sync",
    tone: "teal",
    seed: makeSeed("starter_mesh"),
    createdAt: now,
    updatedAt: now,
  };

  const a1: JevElement = {
    id: "starter_arr_1",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "write / drag",
    tone: "ink",
    seed: makeSeed("starter_arr_1"),
    fromId: user.id,
    toId: canvas.id,
    arrowStyle: "curved",
    createdAt: now,
    updatedAt: now,
  };

  const a2: JevElement = {
    id: "starter_arr_2",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "DataChannel",
    tone: "ink",
    seed: makeSeed("starter_arr_2"),
    fromId: canvas.id,
    toId: mesh.id,
    arrowStyle: "curved",
    bidirectional: true,
    createdAt: now,
    updatedAt: now,
  };

  return [user, canvas, mesh, a1, a2];
}

/**
 * Crisp request flow for the 1-click "Morph to sequence" starter.
 */
export function createRequestFlowStarterElements(): JevElement[] {
  const now = STARTER_TS;
  const web: JevElement = {
    id: "flow_web",
    kind: "ellipse",
    x: 80,
    y: 220,
    width: 148,
    height: 72,
    label: "Web App",
    sublabel: "Checkout UI",
    tone: "terracotta",
    seed: makeSeed("flow_web"),
    createdAt: now,
    updatedAt: now,
  };
  const gateway: JevElement = {
    id: "flow_gw",
    kind: "node",
    x: 320,
    y: 220,
    width: 168,
    height: 72,
    label: "API Gateway",
    sublabel: "Edge router",
    tone: "cobalt",
    seed: makeSeed("flow_gw"),
    createdAt: now,
    updatedAt: now,
  };
  const auth: JevElement = {
    id: "flow_auth",
    kind: "diamond",
    x: 580,
    y: 208,
    width: 162,
    height: 96,
    label: "Auth Service",
    sublabel: "JWT check",
    tone: "plum",
    seed: makeSeed("flow_auth"),
    createdAt: now,
    updatedAt: now,
  };
  const db: JevElement = {
    id: "flow_db",
    kind: "database",
    x: 836,
    y: 214,
    width: 168,
    height: 84,
    label: "Orders DB",
    sublabel: "Postgres",
    tone: "teal",
    seed: makeSeed("flow_db"),
    createdAt: now,
    updatedAt: now,
  };
  const a1: JevElement = {
    id: "flow_arr_1",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "POST /order",
    tone: "ink",
    seed: makeSeed("flow_arr_1"),
    fromId: web.id,
    toId: gateway.id,
    arrowStyle: "curved",
    createdAt: now,
    updatedAt: now,
  };
  const a2: JevElement = {
    id: "flow_arr_2",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "verify JWT",
    tone: "ink",
    seed: makeSeed("flow_arr_2"),
    fromId: gateway.id,
    toId: auth.id,
    arrowStyle: "curved",
    createdAt: now,
    updatedAt: now,
  };
  const a3: JevElement = {
    id: "flow_arr_3",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "insert row",
    tone: "ink",
    seed: makeSeed("flow_arr_3"),
    fromId: auth.id,
    toId: db.id,
    arrowStyle: "curved",
    createdAt: now,
    updatedAt: now,
  };
  return [web, gateway, auth, db, a1, a2, a3];
}

/**
 * Clean 3-tier service architecture for the 1-click "Fork my architecture" starter.
 */
export function createForkArchitectureStarterElements(): JevElement[] {
  const now = STARTER_TS;
  const app: JevElement = {
    id: "arch_client",
    kind: "ellipse",
    x: 80,
    y: 220,
    width: 150,
    height: 72,
    label: "Mobile App",
    sublabel: "iOS / Web",
    tone: "terracotta",
    seed: makeSeed("arch_client"),
    createdAt: now,
    updatedAt: now,
  };
  const api: JevElement = {
    id: "arch_orders_api",
    kind: "node",
    x: 320,
    y: 220,
    width: 174,
    height: 72,
    label: "Orders API",
    sublabel: "REST / gRPC",
    tone: "cobalt",
    seed: makeSeed("arch_orders_api"),
    createdAt: now,
    updatedAt: now,
  };
  const db: JevElement = {
    id: "arch_orders_db",
    kind: "database",
    x: 586,
    y: 214,
    width: 178,
    height: 84,
    label: "Orders Postgres",
    sublabel: "Primary ledger",
    tone: "teal",
    seed: makeSeed("arch_orders_db"),
    createdAt: now,
    updatedAt: now,
  };
  const a1: JevElement = {
    id: "arch_arr_1",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "HTTPS",
    tone: "ink",
    seed: makeSeed("arch_arr_1"),
    fromId: app.id,
    toId: api.id,
    arrowStyle: "curved",
    createdAt: now,
    updatedAt: now,
  };
  const a2: JevElement = {
    id: "arch_arr_2",
    kind: "arrow",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    label: "SQL",
    tone: "ink",
    seed: makeSeed("arch_arr_2"),
    fromId: api.id,
    toId: db.id,
    arrowStyle: "curved",
    createdAt: now,
    updatedAt: now,
  };
  return [app, api, db, a1, a2];
}
