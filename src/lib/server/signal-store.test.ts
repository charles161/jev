import { describe, expect, it } from "vitest";
import { createSignalStore } from "@/lib/server/signal-store";

const ROOM = "room_UnitTestSignalStore_0001";
const SECRET = "test_room_secret_aaaaaaaaaaaa";
const WRONG_SECRET = "test_room_secret_bbbbbbbbbbbb";

describe("SignalStore (room lifecycle, targeting, pruning, and caps)", () => {
  it("broadcasts leave to remaining peers and deletes room + frees IP quota when last peer leaves", () => {
    const store = createSignalStore({ maxRoomsPerIp: 1 });

    const jA = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      name: "Alice",
      now: 1000,
    });
    const jB = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.2",
      name: "Bob",
      now: 1001,
    });
    expect(jA.ok && jB.ok).toBe(true);
    if (!jA.ok || !jB.ok) return;

    // Peer A leaves -> Peer B sees leave message and roster shrinks to [Bob]
    const leaveA = store.postSignal({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jA.peerToken,
      type: "leave",
      now: 1002,
    });
    expect(leaveA.ok).toBe(true);

    const pollB = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      since: 0,
      now: 1003,
    });
    expect(pollB.ok).toBe(true);
    if (!pollB.ok) return;
    expect(pollB.messages.some((m) => m.type === "leave" && m.from === jA.peerId)).toBe(true);
    expect(pollB.roster.map((p) => p.peerId)).toEqual([jB.peerId]);

    // Peer B leaves (last peer) -> room is removed and IP 1 can immediately create a new room
    const leaveB = store.postSignal({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      type: "leave",
      now: 1004,
    });
    expect(leaveB.ok).toBe(true);

    const pollAfterEmpty = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      since: 0,
      now: 1005,
    });
    expect(pollAfterEmpty).toMatchObject({
      ok: false,
      status: 404,
      code: "room_not_found",
    });

    // Creator IP's room quota was freed on empty room deletion
    const newRoom = store.joinRoom({
      room: "room_UnitTestSignalStore_0002",
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      now: 1006,
    });
    expect(newRoom.ok).toBe(true);
  });

  it("enforces target validation, identity checks, and targeted message isolation", () => {
    const store = createSignalStore();
    const jA = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      now: 1000,
    });
    const jB = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.2",
      now: 1001,
    });
    const jC = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.3",
      now: 1002,
    });
    if (!jA.ok || !jB.ok || !jC.ok) throw new Error("expected joins to succeed");

    // Missing `to` or self-targeted signal -> 400 invalid_target
    expect(
      store.postSignal({
        room: ROOM,
        roomSecret: SECRET,
        peerToken: jA.peerToken,
        type: "offer",
        payload: { type: "offer", sdp: "v=0" },
        now: 1003,
      })
    ).toMatchObject({ ok: false, status: 400, code: "invalid_target" });

    expect(
      store.postSignal({
        room: ROOM,
        roomSecret: SECRET,
        peerToken: jA.peerToken,
        to: jA.peerId,
        type: "offer",
        payload: { type: "offer", sdp: "v=0" },
        now: 1003,
      })
    ).toMatchObject({ ok: false, status: 400, code: "invalid_target" });

    // Unknown target peer -> 404 target_peer_not_found
    expect(
      store.postSignal({
        room: ROOM,
        roomSecret: SECRET,
        peerToken: jA.peerToken,
        to: "p_nonexistent_peer",
        type: "offer",
        payload: { type: "offer", sdp: "v=0" },
        now: 1004,
      })
    ).toMatchObject({ ok: false, status: 404, code: "target_peer_not_found" });

    // Wrong secret / forged fromHint -> 403
    expect(
      store.postSignal({
        room: ROOM,
        roomSecret: WRONG_SECRET,
        peerToken: jA.peerToken,
        to: jB.peerId,
        type: "offer",
        payload: { type: "offer", sdp: "v=0" },
        now: 1004,
      })
    ).toMatchObject({ ok: false, status: 403, code: "invalid_room_secret" });

    expect(
      store.postSignal({
        room: ROOM,
        roomSecret: SECRET,
        peerToken: jA.peerToken,
        fromHint: jB.peerId,
        to: jC.peerId,
        type: "offer",
        payload: { type: "offer", sdp: "v=0" },
        now: 1004,
      })
    ).toMatchObject({ ok: false, status: 403, code: "peer_identity_mismatch" });

    // Valid targeted offer A -> B is visible ONLY to B, never to A or C
    const sent = store.postSignal({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jA.peerToken,
      to: jB.peerId,
      type: "offer",
      payload: { type: "offer", sdp: "v=0\r\n" },
      now: 1005,
    });
    expect(sent.ok).toBe(true);

    const pollA = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jA.peerToken,
      since: 0,
      now: 1006,
    });
    const pollB = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      since: 0,
      now: 1006,
    });
    const pollC = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jC.peerToken,
      since: 0,
      now: 1006,
    });
    if (!pollA.ok || !pollB.ok || !pollC.ok) throw new Error("poll failed");

    expect(pollA.messages.some((m) => m.type === "offer")).toBe(false);
    expect(pollB.messages.some((m) => m.type === "offer")).toBe(true);
    expect(pollC.messages.some((m) => m.type === "offer")).toBe(false);

    // Polling with since = cursor returns no duplicate messages
    const pollBRepeat = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      since: pollB.cursor,
      now: 1007,
    });
    expect(pollBRepeat.ok).toBe(true);
    if (pollBRepeat.ok) {
      expect(pollBRepeat.messages).toEqual([]);
      expect(pollBRepeat.cursor).toBe(pollB.cursor);
    }
  });

  it("prunes stale peers after peerTtlMs and enforces maxMessagesPerRoom", () => {
    const store = createSignalStore({
      maxPeersPerRoom: 2,
      maxMessagesPerRoom: 3,
      peerTtlMs: 10_000,
      roomTtlMs: 60_000,
    });

    const jA = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      now: 1000,
    });
    const jB = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.2",
      now: 1000,
    });
    if (!jA.ok || !jB.ok) throw new Error("joins failed");

    // Emit 5 ICE messages -> only the newest 3 remain due to maxMessagesPerRoom=3
    for (let i = 0; i < 5; i += 1) {
      const r = store.postSignal({
        room: ROOM,
        roomSecret: SECRET,
        peerToken: jA.peerToken,
        to: jB.peerId,
        type: "ice",
        payload: { candidate: `c${i}` },
        now: 1001 + i,
      });
      expect(r.ok).toBe(true);
    }

    const pollB = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      since: 0,
      now: 2000,
    });
    expect(pollB.ok).toBe(true);
    if (pollB.ok) {
      expect(pollB.messages).toHaveLength(3);
      expect(
        pollB.messages.map((m) => (m.payload as { candidate: string }).candidate)
      ).toEqual(["c2", "c3", "c4"]);
    }

    // Peer B keeps polling at t=9000 while Peer A goes silent since t=1005 -> at t=12_000 Peer A is stale
    const pollBKeepAlive = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jB.peerToken,
      since: 0,
      now: 12_000,
    });
    expect(pollBKeepAlive.ok).toBe(true);
    if (pollBKeepAlive.ok) {
      expect(pollBKeepAlive.roster.map((p) => p.peerId)).toEqual([jB.peerId]);
    }

    // Stale Peer A is now rejected with peer_expired, and a new Peer C can take the freed slot
    expect(
      store.postSignal({
        room: ROOM,
        roomSecret: SECRET,
        peerToken: jA.peerToken,
        to: jB.peerId,
        type: "ice",
        payload: { candidate: "late" },
        now: 12_001,
      })
    ).toMatchObject({ ok: false, status: 403, code: "peer_expired" });

    const jC = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.3",
      now: 12_002,
    });
    expect(jC.ok).toBe(true);
  });

  it("JW-10: tracks creatorPeerId server-side on room creation and exposes it on join and poll", () => {
    const store = createSignalStore();

    const jCreator = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      name: "Creator",
      now: 1000,
    });
    expect(jCreator.ok).toBe(true);
    if (!jCreator.ok) return;
    expect(jCreator.creatorPeerId).toBe(jCreator.peerId);
    expect(jCreator.roster).toEqual([
      expect.objectContaining({ peerId: jCreator.peerId, joinedAt: 1000 }),
    ]);

    // Second peer joins -> creatorPeerId stays the original creator
    const jSecond = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.2",
      name: "Second",
      now: 2000,
    });
    expect(jSecond.ok).toBe(true);
    if (!jSecond.ok) return;
    expect(jSecond.creatorPeerId).toBe(jCreator.peerId);

    // Poll returns creatorPeerId + server-assigned joinedAt for every active peer
    const poll = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jSecond.peerToken,
      since: 0,
      now: 2500,
    });
    expect(poll.ok).toBe(true);
    if (!poll.ok) return;
    expect(poll.creatorPeerId).toBe(jCreator.peerId);
    expect(poll.roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId: jCreator.peerId, joinedAt: 1000 }),
        expect.objectContaining({ peerId: jSecond.peerId, joinedAt: 2000 }),
      ])
    );

    // Creator leaves -> creatorPeerId is no longer in active roster
    store.postSignal({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jCreator.peerToken,
      type: "leave",
      now: 3000,
    });
    const pollAfterCreatorLeft = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jSecond.peerToken,
      since: 0,
      now: 3100,
    });
    expect(pollAfterCreatorLeft.ok).toBe(true);
    if (!pollAfterCreatorLeft.ok) return;
    expect(pollAfterCreatorLeft.creatorPeerId).toBe(jCreator.peerId);
    expect(pollAfterCreatorLeft.roster.map((p) => p.peerId)).toEqual([
      jSecond.peerId,
    ]);
  });

  it("JW-13: issues high-entropy creatorToken only on room creation, reclaims creatorPeerId in constant time, and rejects forged tokens", () => {
    const store = createSignalStore();

    const jCreator = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      name: "Creator",
      now: 1000,
    });
    expect(jCreator.ok).toBe(true);
    if (!jCreator.ok) return;
    expect(typeof jCreator.creatorToken).toBe("string");
    expect(jCreator.creatorToken!.length).toBeGreaterThanOrEqual(40);

    // Other peer joins -> NEVER receives creatorToken
    const jOther = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.2",
      name: "Other",
      now: 2000,
    });
    expect(jOther.ok).toBe(true);
    if (!jOther.ok) return;
    expect(jOther.creatorToken).toBeUndefined();
    expect(jOther.reclaimedCreator).toBeUndefined();
    expect(jOther.creatorPeerId).toBe(jCreator.peerId);

    // Attacker tries to reclaim with wrong token (same length & different length)
    const jForgedSameLen = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.3",
      name: "Mallory",
      creatorToken: "A".repeat(jCreator.creatorToken!.length),
      now: 2500,
    });
    expect(jForgedSameLen.ok).toBe(true);
    if (!jForgedSameLen.ok) return;
    expect(jForgedSameLen.creatorToken).toBeUndefined();
    expect(jForgedSameLen.reclaimedCreator).toBeUndefined();
    expect(jForgedSameLen.creatorPeerId).toBe(jCreator.peerId);

    const jForgedShort = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.4",
      name: "Mallory2",
      creatorToken: "short_forged_token_0123456789abcd",
      now: 2600,
    });
    expect(jForgedShort.ok).toBe(true);
    if (!jForgedShort.ok) return;
    expect(jForgedShort.reclaimedCreator).toBeUndefined();
    expect(jForgedShort.creatorPeerId).toBe(jCreator.peerId);

    // Creator leaves and reloads/rejoins with valid creatorToken -> reclaims creatorPeerId!
    store.postSignal({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jCreator.peerToken,
      type: "leave",
      now: 3000,
    });

    const jReclaimed = store.joinRoom({
      room: ROOM,
      roomSecret: SECRET,
      clientIp: "198.51.100.1",
      name: "CreatorReloaded",
      creatorToken: jCreator.creatorToken,
      now: 3500,
    });
    expect(jReclaimed.ok).toBe(true);
    if (!jReclaimed.ok) return;
    expect(jReclaimed.peerId).not.toBe(jCreator.peerId);
    expect(jReclaimed.creatorPeerId).toBe(jReclaimed.peerId);
    expect(jReclaimed.reclaimedCreator).toBe(true);
    // Does not re-emit creatorToken on reclaim join
    expect(jReclaimed.creatorToken).toBeUndefined();

    // Poll by other peer reflects reclaimed creatorPeerId and never exposes creatorToken
    const pollOther = store.pollRoom({
      room: ROOM,
      roomSecret: SECRET,
      peerToken: jOther.peerToken,
      since: 0,
      now: 3600,
    });
    expect(pollOther.ok).toBe(true);
    if (!pollOther.ok) return;
    expect(pollOther.creatorPeerId).toBe(jReclaimed.peerId);
    expect("creatorToken" in pollOther).toBe(false);
  });
});
