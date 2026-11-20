import { NextRequest, NextResponse } from "next/server";

interface SignalMessage {
  seq: number;
  from: string;
  to?: string;
  type: "join" | "offer" | "answer" | "ice" | "leave";
  payload?: unknown;
  name?: string;
  color?: string;
  ts: number;
}

interface RoomBucket {
  messages: SignalMessage[];
  lastActive: number;
  nextSeq: number;
}

const MAX_ROOMS = 150;
const MAX_MESSAGES_PER_ROOM = 80;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 24 * 1024;

const VALID_ID = /^[a-zA-Z0-9_-]{3,40}$/;
const VALID_TYPES = new Set(["join", "offer", "answer", "ice", "leave"]);

// Ephemeral in-memory relay for lightweight WebRTC SDP/ICE handshake.
const rooms = new Map<string, RoomBucket>();

function pruneRooms(now: number) {
  for (const [key, bucket] of rooms.entries()) {
    if (now - bucket.lastActive > ROOM_TTL_MS) {
      rooms.delete(key);
    }
  }
  while (rooms.size > MAX_ROOMS) {
    const oldestKey = rooms.keys().next().value;
    if (!oldestKey) break;
    rooms.delete(oldestKey);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const room = searchParams.get("room") ?? "";
  const peerId = searchParams.get("peerId") ?? "";
  const sinceRaw = searchParams.get("since") ?? "0";

  if (!VALID_ID.test(room) || !VALID_ID.test(peerId)) {
    return NextResponse.json(
      { error: "Invalid room or peerId" },
      { status: 400 }
    );
  }

  const since = Math.max(0, Number.parseInt(sinceRaw, 10) || 0);
  const now = Date.now();
  pruneRooms(now);

  const bucket = rooms.get(room);
  if (!bucket) {
    return NextResponse.json({ messages: [], cursor: since });
  }

  bucket.lastActive = now;
  const messages = bucket.messages.filter(
    (m) => m.seq > since && m.from !== peerId && (!m.to || m.to === peerId)
  );
  const cursor =
    bucket.messages.length > 0
      ? bucket.messages[bucket.messages.length - 1].seq
      : since;

  return NextResponse.json({ messages, cursor });
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (rawText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const room = typeof body.room === "string" ? body.room : "";
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : undefined;
  const type = typeof body.type === "string" ? body.type : "";

  if (!VALID_ID.test(room) || !VALID_ID.test(from)) {
    return NextResponse.json(
      { error: "Invalid room or sender id" },
      { status: 400 }
    );
  }
  if (to && !VALID_ID.test(to)) {
    return NextResponse.json({ error: "Invalid target peer id" }, { status: 400 });
  }
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ error: "Unsupported signal type" }, { status: 400 });
  }

  const now = Date.now();
  pruneRooms(now);

  let bucket = rooms.get(room);
  if (!bucket) {
    bucket = { messages: [], lastActive: now, nextSeq: 1 };
    rooms.set(room, bucket);
  }

  const msg: SignalMessage = {
    seq: bucket.nextSeq++,
    from,
    to,
    type: type as SignalMessage["type"],
    payload: body.payload,
    name: typeof body.name === "string" ? body.name.slice(0, 32) : undefined,
    color: typeof body.color === "string" ? body.color.slice(0, 16) : undefined,
    ts: now,
  };

  bucket.messages.push(msg);
  if (bucket.messages.length > MAX_MESSAGES_PER_ROOM) {
    bucket.messages.splice(0, bucket.messages.length - MAX_MESSAGES_PER_ROOM);
  }
  bucket.lastActive = now;

  return NextResponse.json({ ok: true, seq: msg.seq });
}
