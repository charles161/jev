import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { boardStorageKey } from "./storage-keys";
import { parseRoomHash } from "./room-auth";
import { parseStoredBoardSnapshot, type StoredBoardSnapshot } from "./sync-validation";
import type { JevElement } from "./types";
import {
  BOARD_FILE_FORMAT,
  IMPORT_HASH_PREFIX,
  MAX_IMPORT_PAYLOAD_CHARS,
  buildBoardFile,
  decodeImportHash,
  encodeImportHash,
  hasImportHash,
  openImportHash,
  parseBoardFile,
  stageImportedBoard,
} from "./board-import";

const FIXTURE_DIR = path.join(__dirname, "__fixtures__");

function el(overrides: Partial<JevElement>): JevElement {
  return {
    id: "n1",
    kind: "node",
    x: 0,
    y: 0,
    width: 170,
    height: 72,
    label: "API",
    tone: "cobalt",
    seed: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const SNAPSHOT: StoredBoardSnapshot = {
  elements: [
    el({ id: "users", kind: "entity", label: "users", sublabel: "PK id\nemail" }),
    el({ id: "orders", kind: "queue", label: "orders", x: 300 }),
    el({
      id: "rel",
      kind: "arrow",
      label: "places",
      fromId: "users",
      toId: "orders",
      startEnd: "er_only_one",
      endEnd: "er_zero_many",
    }),
  ],
  boardTitle: "Orders ER",
};

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hashFor(json: string): string {
  return IMPORT_HASH_PREFIX + base64url(gzipSync(Buffer.from(json, "utf8")));
}

describe("#import= link: base64url(gzip(JSON snapshot))", () => {
  it("round-trips a snapshot, keeping new kinds and crow's-foot arrow ends", async () => {
    const hash = await encodeImportHash(SNAPSHOT);
    expect(hash.startsWith(IMPORT_HASH_PREFIX)).toBe(true);
    expect(hash.slice(IMPORT_HASH_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = await decodeImportHash(hash);
    expect(decoded?.elements).toEqual(SNAPSHOT.elements);
    expect(decoded?.boardTitle).toBe("Orders ER");
  });

  it("decodes what an independent gzip + base64url encoder (skot-bot) produces", async () => {
    const decoded = await decodeImportHash(hashFor(JSON.stringify(SNAPSHOT)));
    expect(decoded?.elements).toEqual(SNAPSHOT.elements);
  });

  it("decodes the shared fixture links made by skot-bot (Python) and by this encoder", async () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "import-link.json"), "utf8"));
    for (const hash of [fixture.pythonHash, fixture.browserHash]) {
      expect((await decodeImportHash(hash))?.elements).toEqual(fixture.snapshot.elements);
    }
    expect(await decodeImportHash(await encodeImportHash(fixture.snapshot))).toEqual(
      await decodeImportHash(fixture.browserHash)
    );
  });

  it("returns null for a truncated payload", async () => {
    const hash = await encodeImportHash(SNAPSHOT);
    expect(await decodeImportHash(hash.slice(0, hash.length - 12))).toBeNull();
  });

  it("returns null for an oversized payload without decoding it", async () => {
    expect(await decodeImportHash(IMPORT_HASH_PREFIX + "A".repeat(MAX_IMPORT_PAYLOAD_CHARS + 1))).toBeNull();
  });

  it("returns null for a gzip bomb that inflates past the storage limit", async () => {
    const bomb = JSON.stringify({ elements: [], boardTitle: "x".repeat(4 * 1024 * 1024) });
    const hash = hashFor(bomb);
    expect(hash.length).toBeLessThan(MAX_IMPORT_PAYLOAD_CHARS);
    expect(await decodeImportHash(hash)).toBeNull();
  });

  it("returns null for __proto__ / constructor keys anywhere in the snapshot", async () => {
    expect(await decodeImportHash(hashFor('{"elements":[],"__proto__":{"polluted":true}}'))).toBeNull();
    const nested = JSON.stringify(SNAPSHOT).replace('"label":"users"', '"label":"users","constructor":{}');
    expect(await decodeImportHash(hashFor(nested))).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns null for junk: not base64url, not gzip, not JSON, not a snapshot", async () => {
    expect(await decodeImportHash("#import=")).toBeNull();
    expect(await decodeImportHash("#import=***")).toBeNull();
    expect(await decodeImportHash("#import=" + base64url(Buffer.from("plain")))).toBeNull();
    expect(await decodeImportHash(hashFor("{not json"))).toBeNull();
    expect(await decodeImportHash(hashFor('{"elements":[{"id":"x"}]}'))).toBeNull();
    expect(await decodeImportHash("#room=abc&k=def")).toBeNull();
  });

  it("only treats a fragment that starts with import= as an import", () => {
    expect(hasImportHash("#import=abc")).toBe(true);
    expect(hasImportHash("#import=")).toBe(true);
    expect(hasImportHash("#room=a&k=b")).toBe(false);
    expect(hasImportHash("")).toBe(false);
  });
});

describe("stageImportedBoard: a fresh room holding the imported board", () => {
  it("writes the snapshot under the new room's storage key with hasLocalEdits true", () => {
    const store = new Map<string, string>();
    const creds = stageImportedBoard(SNAPSHOT, { setItem: (k, v) => void store.set(k, v) });
    expect(parseRoomHash(`#room=${creds.roomId}&k=${creds.roomSecret}`)).toEqual(creds);
    const saved = parseStoredBoardSnapshot(store.get(boardStorageKey(creds.roomId)) ?? "");
    expect(saved?.elements).toEqual(SNAPSHOT.elements);
    expect(saved?.boardTitle).toBe("Orders ER");
    expect(saved?.hasLocalEdits).toBe(true);
  });

  it("never reuses room credentials", () => {
    const sink = { setItem: () => undefined };
    expect(stageImportedBoard(SNAPSHOT, sink).roomId).not.toBe(stageImportedBoard(SNAPSHOT, sink).roomId);
  });

  it("does not carry the source room's tombstones or epoch into the new room", () => {
    const store = new Map<string, string>();
    const creds = stageImportedBoard(
      { ...SNAPSHOT, tombstones: { gone: { deletedAt: 1, rev: 2 } }, boardEpoch: "old_epoch" },
      { setItem: (k, v) => void store.set(k, v) }
    );
    const saved = JSON.parse(store.get(boardStorageKey(creds.roomId)) ?? "{}");
    expect(saved.tombstones).toBeUndefined();
    expect(saved.boardEpoch).toBeUndefined();
  });
});

describe("board .json files", () => {
  it("Save writes {format: skot-board/1, snapshot}", () => {
    const file = JSON.parse(buildBoardFile(SNAPSHOT));
    expect(file.format).toBe(BOARD_FILE_FORMAT);
    expect(BOARD_FILE_FORMAT).toBe("skot-board/1");
    expect(file.snapshot.elements).toEqual(SNAPSHOT.elements);
  });

  it("Open then Save round-trips identical elements", () => {
    const opened = parseBoardFile(buildBoardFile(SNAPSHOT));
    expect(opened).not.toBeNull();
    const reopened = parseBoardFile(buildBoardFile(opened!));
    expect(reopened?.elements).toEqual(SNAPSHOT.elements);
    expect(JSON.parse(buildBoardFile(reopened!)).snapshot.elements).toEqual(SNAPSHOT.elements);
  });

  it("opens a skot-bot export (skot-bot-scene/1 with extra fields) as is", () => {
    const exported = JSON.stringify({
      format: "skot-bot-scene/1",
      exportedAt: "2026-11-21T06:00:00Z",
      roomUrl: "http://127.0.0.1:8872/#room=x&k=y",
      elements: SNAPSHOT.elements,
      snapshot: SNAPSHOT,
    });
    expect(parseBoardFile(exported)?.elements).toEqual(SNAPSHOT.elements);
  });

  it("opens a bare snapshot", () => {
    expect(parseBoardFile(JSON.stringify(SNAPSHOT))?.boardTitle).toBe("Orders ER");
  });

  it("rejects unknown formats, junk, oversized files and __proto__ anywhere", () => {
    expect(parseBoardFile(JSON.stringify({ format: "excalidraw", snapshot: SNAPSHOT }))).toBeNull();
    expect(parseBoardFile("{nope")).toBeNull();
    expect(parseBoardFile("[]")).toBeNull();
    expect(parseBoardFile("null")).toBeNull();
    expect(parseBoardFile(JSON.stringify({ format: BOARD_FILE_FORMAT }))).toBeNull();
    expect(parseBoardFile(" ".repeat(5 * 1024 * 1024) + "{}")).toBeNull();
    expect(
      parseBoardFile(`{"format":"skot-board/1","__proto__":{"x":1},"snapshot":${JSON.stringify(SNAPSHOT)}}`)
    ).toBeNull();
    expect(parseBoardFile(`{"format":"skot-board/1","snapshot":{"elements":[],"__proto__":{}}}`)).toBeNull();
  });
});

describe("openImportHash: what the app does on mount with #import=", () => {
  it("turns a valid link into a #room=…&k=… fragment whose saved board is the snapshot, with no import= left", async () => {
    const store = new Map<string, string>();
    const next = await openImportHash(await encodeImportHash(SNAPSHOT), { setItem: (k, v) => void store.set(k, v) });
    expect(next).not.toBeNull();
    expect(next).not.toContain("import=");
    const creds = parseRoomHash(next!);
    expect(creds).not.toBeNull();
    expect(parseStoredBoardSnapshot(store.get(boardStorageKey(creds!.roomId)) ?? "")?.elements).toEqual(SNAPSHOT.elements);
  });

  it("writes nothing for an invalid link", async () => {
    const store = new Map<string, string>();
    expect(await openImportHash("#import=broken", { setItem: (k, v) => void store.set(k, v) })).toBeNull();
    expect(store.size).toBe(0);
  });
});
