import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/signal/route";
import {
  createSignalStore,
  resetDefaultSignalStoreForTests,
} from "@/lib/server/signal-store";

const VALID_ROOM = "room_AbCdEfGhIjKlMnOpQrStUvWx";
const VALID_SECRET = "secr_0123456789abcdefABCDEF0123456789";
const WRONG_SECRET = "secr_WRONG56789abcdefABCDEF0123456789";

function makePost(
  body: unknown,
  headers: Record<string, string> = {},
  ip = "198.51.100.10"
): NextRequest {
  return new NextRequest("http://localhost/api/signal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeGet(
  query: string,
  headers: Record<string, string> = {},
  ip = "198.51.100.10"
): NextRequest {
  return new NextRequest(`http://localhost/api/signal?${query}`, {
    method: "GET",
    headers: {
      "x-forwarded-for": ip,
      ...headers,
    },
  });
}

describe("/api/signal security, DoS protection, roster & epoch", () => {
  beforeEach(() => {
    resetDefaultSignalStoreForTests();
  });

  it("Blocker 1: rejects weak 4-char room IDs and missing room secrets", async () => {
    const weakRoomRes = await POST(
      makePost(
        { room: "jev-ab12", type: "join", name: "Alice" },
        { "x-room-secret": VALID_SECRET }
      )
    );
    expect(weakRoomRes.status).toBe(400);
    expect(weakRoomRes.headers.get("cache-control")).toBe("no-store");

    const noSecretRes = await POST(
      makePost({ room: VALID_ROOM, type: "join", name: "Alice" })
    );
    expect(noSecretRes.status).toBe(401);
  });

  it("Blocker 1: enforces per-room secret and server-issued peer auth tokens", async () => {
    // Peer A joins and receives server-assigned peerId + peerToken
    const joinARes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Alice", color: "#D94E28" },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.11"
      )
    );
    expect(joinARes.status).toBe(200);
    const joinA = (await joinARes.json()) as {
      ok: boolean;
      peerId: string;
      peerToken: string;
      epoch: string;
      roster: Array<{ peerId: string; name?: string; tokenHash?: unknown }>;
    };
    expect(joinA.ok).toBe(true);
    expect(joinA.peerId.length).toBeGreaterThanOrEqual(12);
    expect(joinA.peerToken.length).toBeGreaterThanOrEqual(22);
    expect(typeof joinA.epoch).toBe("string");
    expect(joinA.epoch.length).toBeGreaterThanOrEqual(8);

    // Attacker with wrong room secret is blocked from joining or polling
    const badSecretJoin = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Mallory" },
        { "x-room-secret": WRONG_SECRET },
        "198.51.100.12"
      )
    );
    expect(badSecretJoin.status).toBe(403);

    // Peer B joins with valid room secret
    const joinBRes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Bob", color: "#2563EB" },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.13"
      )
    );
    expect(joinBRes.status).toBe(200);
    const joinB = (await joinBRes.json()) as {
      peerId: string;
      peerToken: string;
      epoch: string;
      roster: Array<{ peerId: string; name?: string; tokenHash?: unknown }>;
    };
    expect(joinB.peerId).not.toBe(joinA.peerId);
    expect(joinB.epoch).toBe(joinA.epoch);
    // Blocker 5: roster returned on join includes both active peers without leaking tokens
    expect(joinB.roster.map((p) => p.peerId).sort()).toEqual(
      [joinA.peerId, joinB.peerId].sort()
    );
    expect(joinB.roster.every((p) => !("tokenHash" in p))).toBe(true);

    // Peer A sends offer targeted specifically to Peer B
    const offerRes = await POST(
      makePost(
        {
          room: VALID_ROOM,
          to: joinB.peerId,
          type: "offer",
          payload: {
            type: "offer",
            sdp: "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\n",
          },
        },
        {
          "x-room-secret": VALID_SECRET,
          "x-peer-token": joinA.peerToken,
        },
        "198.51.100.11"
      )
    );
    expect(offerRes.status).toBe(200);

    // Peer A CANNOT read offers targeted to Peer B by passing peerId=joinB.peerId
    const snoopRes = await GET(
      makeGet(
        `room=${encodeURIComponent(VALID_ROOM)}&peerId=${encodeURIComponent(joinB.peerId)}&since=0`,
        {
          "x-room-secret": VALID_SECRET,
          "x-peer-token": joinA.peerToken,
        },
        "198.51.100.11"
      )
    );
    expect(snoopRes.status).toBe(403);

    // Unauthenticated GET is rejected
    const unauthGet = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}&since=0`, {
        "x-room-secret": VALID_SECRET,
      })
    );
    expect(unauthGet.status).toBe(401);

    // Peer A CANNOT forge a leave message as Peer B
    const forgedLeave = await POST(
      makePost(
        { room: VALID_ROOM, from: joinB.peerId, type: "leave" },
        {
          "x-room-secret": VALID_SECRET,
          "x-peer-token": joinA.peerToken,
        },
        "198.51.100.11"
      )
    );
    expect(forgedLeave.status).toBe(403);

    // Peer B authenticates with their own token and reads Peer A's offer + roster + epoch
    const pollBRes = await GET(
      makeGet(
        `room=${encodeURIComponent(VALID_ROOM)}&since=0`,
        {
          "x-room-secret": VALID_SECRET,
          "x-peer-token": joinB.peerToken,
        },
        "198.51.100.13"
      )
    );
    expect(pollBRes.status).toBe(200);
    expect(pollBRes.headers.get("cache-control")).toBe("no-store");
    const pollB = (await pollBRes.json()) as {
      epoch: string;
      roster: Array<{ peerId: string }>;
      messages: Array<{ from: string; to?: string; type: string }>;
    };
    expect(pollB.epoch).toBe(joinA.epoch);
    expect(pollB.roster.length).toBe(2);
    expect(
      pollB.messages.some(
        (m) =>
          m.type === "offer" && m.from === joinA.peerId && m.to === joinB.peerId
      )
    ).toBe(true);
  });

  it("Blocker 2: rejects excess rooms per IP and rejects at global capacity without evicting active rooms", () => {
    const store = createSignalStore({
      maxRooms: 3,
      maxRoomsPerIp: 2,
      maxPeersPerRoom: 2,
      maxRoomBytes: 4096,
      roomTtlMs: 60_000,
    });

    // Victim creates an active room from IP 1
    const victimRoom = "room_VictimActiveRoom12345678";
    const victimJoin = store.joinRoom({
      room: victimRoom,
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.1",
      name: "Victim",
    });
    expect(victimJoin.ok).toBe(true);

    // Attacker IP 2 hits per-IP room creation cap (2 max)
    const atk1 = store.joinRoom({
      room: "room_AttackerJunkRoom_000001",
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.2",
    });
    expect(atk1.ok).toBe(true);
    const atk2 = store.joinRoom({
      room: "room_AttackerJunkRoom_000002",
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.2",
    });
    expect(atk2.ok).toBe(true);
    const atk3 = store.joinRoom({
      room: "room_AttackerJunkRoom_000003",
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.2",
    });
    expect(atk3.ok).toBe(false);
    if (!atk3.ok) expect(atk3.status).toBe(429);

    // Different IP 3 attempts to create a 4th room when global maxRooms=3 is full -> rejected (503), NOT evicting victim
    const overflow = store.joinRoom({
      room: "room_OverflowRoom_0000000004",
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.3",
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.status).toBe(503);

    // Victim's active room must STILL exist and remain readable
    if (victimJoin.ok) {
      const victimPoll = store.pollRoom({
        room: victimRoom,
        roomSecret: VALID_SECRET,
        peerToken: victimJoin.peerToken,
        since: 0,
      });
      expect(victimPoll.ok).toBe(true);
    }

    // Per-room peer cap (maxPeersPerRoom=2): 2nd peer succeeds, 3rd rejected
    const secondPeer = store.joinRoom({
      room: victimRoom,
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.4",
    });
    expect(secondPeer.ok).toBe(true);
    const thirdPeer = store.joinRoom({
      room: victimRoom,
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.5",
    });
    expect(thirdPeer.ok).toBe(false);
    if (!thirdPeer.ok) expect(thirdPeer.status).toBe(429);
  });

  it("Blocker 2: expires inactive rooms by TTL and enforces per-room byte caps without harming other rooms", () => {
    const store = createSignalStore({
      maxRooms: 2,
      maxRoomsPerIp: 1,
      maxPeersPerRoom: 4,
      maxMessagesPerRoom: 50,
      maxRoomBytes: 600,
      roomTtlMs: 10_000,
    });

    // IP 1 creates room 1 at t=1000
    const r1 = "room_ByteCapRoom_000000000001";
    const j1 = store.joinRoom({
      room: r1,
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.21",
      now: 1000,
    });
    expect(j1.ok).toBe(true);
    const j2 = store.joinRoom({
      room: r1,
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.22",
      now: 1001,
    });
    expect(j2.ok).toBe(true);

    // Flood ICE messages in room 1 beyond maxRoomBytes=600
    if (j1.ok && j2.ok) {
      for (let i = 0; i < 6; i += 1) {
        const res = store.postSignal({
          room: r1,
          roomSecret: VALID_SECRET,
          peerToken: j1.peerToken,
          to: j2.peerId,
          type: "ice",
          payload: { candidate: `candidate:${i} ${"x".repeat(160)}` },
          now: 1002 + i,
        });
        expect(res.ok).toBe(true);
      }

      // Oldest messages were trimmed to stay within maxRoomBytes, while newest remain
      const poll = store.pollRoom({
        room: r1,
        roomSecret: VALID_SECRET,
        peerToken: j2.peerToken,
        since: 0,
        now: 1100,
      });
      expect(poll.ok).toBe(true);
      if (poll.ok) {
        expect(poll.messages.length).toBeLessThan(6);
        expect(poll.messages.length).toBeGreaterThan(0);
      }
    }

    // After roomTtlMs elapses (t=20_000), room 1 expires and IP 1 can create a fresh room
    const freshAfterTtl = store.joinRoom({
      room: "room_FreshAfterTtl_0000000002",
      roomSecret: VALID_SECRET,
      clientIp: "198.51.100.21",
      now: 20_000,
    });
    expect(freshAfterTtl.ok).toBe(true);
  });

  it("Blocker 5: generates a distinct server epoch across restarts", () => {
    const boot1 = createSignalStore();
    const boot2 = createSignalStore();
    expect(boot1.epoch).not.toBe(boot2.epoch);
  });

  it("Review (b): distinguishes peer_expired (pruned peer 403), invalid_room_secret (403), and room_not_found (404)", async () => {
    // Missing room -> 404 room_not_found
    const missingRes = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}&since=0`, {
        "x-room-secret": VALID_SECRET,
        "x-peer-token": "tok_missing_0123456789abcdef0123",
      })
    );
    expect(missingRes.status).toBe(404);
    const missingBody = (await missingRes.json()) as { code?: string };
    expect(missingBody.code).toBe("room_not_found");

    // Create room with Peer A
    const joinARes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Alice" },
        { "x-room-secret": VALID_SECRET }
      )
    );
    const joinA = (await joinARes.json()) as { peerToken: string };

    // Wrong room secret -> 403 invalid_room_secret
    const badSecretRes = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}&since=0`, {
        "x-room-secret": WRONG_SECRET,
        "x-peer-token": joinA.peerToken,
      })
    );
    expect(badSecretRes.status).toBe(403);
    const badSecretBody = (await badSecretRes.json()) as { code?: string };
    expect(badSecretBody.code).toBe("invalid_room_secret");

    // Valid room secret + unknown/pruned peer token -> 403 peer_expired
    const prunedRes = await GET(
      makeGet(`room=${encodeURIComponent(VALID_ROOM)}&since=0`, {
        "x-room-secret": VALID_SECRET,
        "x-peer-token": "tok_pruned_0123456789abcdef01234",
      })
    );
    expect(prunedRes.status).toBe(403);
    const prunedBody = (await prunedRes.json()) as { code?: string; epoch?: string };
    expect(prunedBody.code).toBe("peer_expired");
    expect(typeof prunedBody.epoch).toBe("string");
  });

  it("JW-10: exposes server-tracked creatorPeerId and peer joinedAt on join and poll responses", async () => {
    const joinARes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Creator" },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.31"
      )
    );
    expect(joinARes.status).toBe(200);
    const joinA = (await joinARes.json()) as {
      peerId: string;
      peerToken: string;
      creatorPeerId?: string;
      roster: Array<{ peerId: string; joinedAt?: number }>;
    };
    expect(joinA.creatorPeerId).toBe(joinA.peerId);
    expect(typeof joinA.roster[0]?.joinedAt).toBe("number");

    const joinBRes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Joiner" },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.32"
      )
    );
    expect(joinBRes.status).toBe(200);
    const joinB = (await joinBRes.json()) as {
      peerId: string;
      peerToken: string;
      creatorPeerId?: string;
      roster: Array<{ peerId: string; joinedAt?: number }>;
    };
    expect(joinB.creatorPeerId).toBe(joinA.peerId);

    const pollBRes = await GET(
      makeGet(
        `room=${encodeURIComponent(VALID_ROOM)}&since=0`,
        {
          "x-room-secret": VALID_SECRET,
          "x-peer-token": joinB.peerToken,
        },
        "198.51.100.32"
      )
    );
    expect(pollBRes.status).toBe(200);
    const pollB = (await pollBRes.json()) as {
      creatorPeerId?: string;
      roster: Array<{ peerId: string; joinedAt?: number }>;
    };
    expect(pollB.creatorPeerId).toBe(joinA.peerId);
    expect(pollB.roster.every((p) => typeof p.joinedAt === "number")).toBe(true);
  });

  it("JW-13: returns creatorToken only on creating join and verifies creatorToken on reload reclaim via POST /api/signal", async () => {
    const createRes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Creator" },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.41"
      )
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      peerId: string;
      peerToken: string;
      creatorPeerId: string;
      creatorToken?: string;
      reclaimedCreator?: boolean;
    };
    expect(typeof created.creatorToken).toBe("string");
    expect(created.creatorToken!.length).toBeGreaterThanOrEqual(40);
    expect(created.creatorPeerId).toBe(created.peerId);

    // Non-creator joins -> no creatorToken leaked
    const guestRes = await POST(
      makePost(
        { room: VALID_ROOM, type: "join", name: "Guest" },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.42"
      )
    );
    expect(guestRes.status).toBe(200);
    const guest = (await guestRes.json()) as {
      peerId: string;
      peerToken: string;
      creatorPeerId: string;
      creatorToken?: string;
      reclaimedCreator?: boolean;
    };
    expect(guest.creatorToken).toBeUndefined();
    expect(guest.reclaimedCreator).toBeUndefined();
    expect(guest.creatorPeerId).toBe(created.peerId);

    // Attacker sends forged creatorToken -> does NOT reclaim
    const forgedRes = await POST(
      makePost(
        {
          room: VALID_ROOM,
          type: "join",
          name: "Attacker",
          creatorToken: "Z".repeat(created.creatorToken!.length),
        },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.43"
      )
    );
    expect(forgedRes.status).toBe(200);
    const forged = (await forgedRes.json()) as {
      peerId: string;
      creatorPeerId: string;
      reclaimedCreator?: boolean;
    };
    expect(forged.reclaimedCreator).toBeUndefined();
    expect(forged.creatorPeerId).toBe(created.peerId);

    // Creator reloads and sends valid creatorToken -> reclaims creatorPeerId!
    const reclaimRes = await POST(
      makePost(
        {
          room: VALID_ROOM,
          type: "join",
          name: "CreatorAgain",
          creatorToken: created.creatorToken,
        },
        { "x-room-secret": VALID_SECRET },
        "198.51.100.41"
      )
    );
    expect(reclaimRes.status).toBe(200);
    const reclaimed = (await reclaimRes.json()) as {
      peerId: string;
      creatorPeerId: string;
      creatorToken?: string;
      reclaimedCreator?: boolean;
    };
    expect(reclaimed.reclaimedCreator).toBe(true);
    expect(reclaimed.creatorPeerId).toBe(reclaimed.peerId);
    expect(reclaimed.creatorToken).toBeUndefined();

    // Poll never leaks creatorToken and reflects updated creatorPeerId
    const pollGuestRes = await GET(
      makeGet(
        `room=${encodeURIComponent(VALID_ROOM)}&since=0`,
        {
          "x-room-secret": VALID_SECRET,
          "x-peer-token": guest.peerToken,
        },
        "198.51.100.42"
      )
    );
    expect(pollGuestRes.status).toBe(200);
    const pollGuest = (await pollGuestRes.json()) as Record<string, unknown>;
    expect(pollGuest.creatorPeerId).toBe(reclaimed.peerId);
    expect("creatorToken" in pollGuest).toBe(false);
  });
});
