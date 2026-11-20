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
 * Clean, breathable starter diagram that showcases Jev immediately on load:
 * Drag any box to see Motion Memory + Intent Understanding, or press Tab + Enter right away!
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
    positionHistory: [],
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
    label: "Jev Canvas",
    sublabel: "Spatial intent + Tab",
    tone: "cobalt",
    seed: makeSeed("starter_canvas"),
    positionHistory: [],
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
    positionHistory: [],
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
    positionHistory: [],
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
    positionHistory: [],
    fromId: canvas.id,
    toId: mesh.id,
    arrowStyle: "curved",
    bidirectional: true,
    createdAt: now,
    updatedAt: now,
  };

  return [user, canvas, mesh, a1, a2];
}
