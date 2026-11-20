import { describe, expect, it } from "vitest";
import {
  buildRoomShareUrl,
  formatRoomHash,
  generateRoomCredentials,
  parseRoomHash,
  ROOM_ID_PATTERN,
  ROOM_SECRET_PATTERN,
} from "@/lib/jev/room-auth";

describe("room-auth (Blocker 1: >=128-bit room IDs & hash-fragment secret)", () => {
  it("generates >=128-bit unguessable roomId and per-room secret", () => {
    const a = generateRoomCredentials();
    const b = generateRoomCredentials();

    // 128 bits in base64url is 22 chars minimum
    expect(a.roomId.length).toBeGreaterThanOrEqual(22);
    expect(a.roomSecret.length).toBeGreaterThanOrEqual(22);
    expect(ROOM_ID_PATTERN.test(a.roomId)).toBe(true);
    expect(ROOM_SECRET_PATTERN.test(a.roomSecret)).toBe(true);
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.roomSecret).not.toBe(b.roomSecret);
    expect(a.roomId).not.toBe(a.roomSecret);
  });

  it("encodes room credentials strictly in the URL hash fragment, never query string", () => {
    const { roomId, roomSecret } = generateRoomCredentials();
    const url = buildRoomShareUrl(
      "https://jev.example.com",
      "/",
      roomId,
      roomSecret
    );
    const parsedUrl = new URL(url);

    expect(parsedUrl.search).toBe("");
    expect(parsedUrl.hash).toBe(formatRoomHash(roomId, roomSecret));

    const roundTrip = parseRoomHash(parsedUrl.hash);
    expect(roundTrip).toEqual({ roomId, roomSecret });
  });

  it("rejects weak 4-char room IDs and missing or short secrets", () => {
    expect(parseRoomHash("#room=jev-ab12&k=short")).toBeNull();
    expect(
      parseRoomHash("#room=jev-ab12&k=abcdefghijklmnopqrstuvwxyz123456")
    ).toBeNull();
    expect(
      parseRoomHash("#room=abcdefghijklmnopqrstuvwxyz123456")
    ).toBeNull();
    expect(parseRoomHash("")).toBeNull();
  });
});
