import { describe, expect, it } from "vitest";
import { getTonePalette, MIDNIGHT_PALETTES, VELLUM_PALETTES } from "@/lib/jev/colors";
import type { ColorTone, JevElement } from "@/lib/jev/types";
import {
  MAX_BOARD_ELEMENTS,
  MAX_FREEDRAW_POINTS,
  MAX_LABEL_LENGTH,
  parseRawDataChannelMessage,
  parseStoredBoardSnapshot,
  parseWireMessage,
} from "@/lib/jev/sync-validation";

function makeValidElement(overrides: Partial<JevElement> = {}): JevElement {
  return {
    id: "el_valid_1",
    kind: "node",
    x: 100,
    y: 200,
    width: 170,
    height: 72,
    label: "API Gateway",
    tone: "cobalt",
    seed: 12345,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe("Blocker 4: getTonePalette defensive fallback", () => {
  it("falls back to ink palette for unknown, undefined, or prototype-key tones", () => {
    expect(getTonePalette("unknown-tone" as ColorTone, "vellum")).toEqual(
      VELLUM_PALETTES.ink
    );
    expect(getTonePalette(undefined as unknown as ColorTone, "midnight")).toEqual(
      MIDNIGHT_PALETTES.ink
    );
    expect(getTonePalette("constructor" as ColorTone, "vellum")).toEqual(
      VELLUM_PALETTES.ink
    );
    expect(getTonePalette("__proto__" as ColorTone, "midnight")).toEqual(
      MIDNIGHT_PALETTES.ink
    );
    expect(getTonePalette("toString" as ColorTone, "vellum")).toEqual(
      VELLUM_PALETTES.ink
    );
  });

  it("returns the exact palette for valid tones", () => {
    expect(getTonePalette("terracotta", "vellum")).toEqual(
      VELLUM_PALETTES.terracotta
    );
    expect(getTonePalette("teal", "midnight")).toEqual(MIDNIGHT_PALETTES.teal);
  });
});

describe("Blocker 4: strict Zod validation for DataChannel, BroadcastChannel & localStorage", () => {
  it("accepts valid wire messages and strips unknown or unsafe fields", () => {
    const raw = {
      kind: "sync_state",
      peerId: "p_peer_123456",
      boardTitle: "Architecture",
      ts: 1700000001000,
      authoritative: true,
      hasLocalEdits: true,
      evilExtraTopLevel: "<script>alert(1)</script>",
      elements: [
        {
          ...makeValidElement(),
          unexpectedField: "should-be-stripped",
          onClick: "alert(1)",
        },
      ],
    };

    const parsed = parseWireMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("sync_state");
    if (parsed && parsed.kind === "sync_state") {
      expect("evilExtraTopLevel" in parsed).toBe(false);
      expect(parsed.elements).toHaveLength(1);
      expect("unexpectedField" in parsed.elements[0]).toBe(false);
      expect("onClick" in parsed.elements[0]).toBe(false);
    }
  });

  it("rejects malformed payloads, bad tones, non-finite numbers, and prototype keys", () => {
    // Bad tone
    expect(
      parseWireMessage({
        kind: "sync_state",
        peerId: "p_peer_123456",
        boardTitle: "Test",
        ts: Date.now(),
        elements: [{ ...makeValidElement(), tone: "neon-invalid" }],
      })
    ).toBeNull();

    // Non-finite coordinates
    expect(
      parseWireMessage({
        kind: "sync_state",
        peerId: "p_peer_123456",
        boardTitle: "Test",
        ts: Date.now(),
        elements: [{ ...makeValidElement(), x: Number.NaN }],
      })
    ).toBeNull();

    // Prototype pollution element ID
    expect(
      parseWireMessage({
        kind: "sync_state",
        peerId: "p_peer_123456",
        boardTitle: "Test",
        ts: Date.now(),
        elements: [{ ...makeValidElement(), id: "__proto__" }],
      })
    ).toBeNull();

    // Invalid hex color in cursor
    expect(
      parseWireMessage({
        kind: "cursor",
        peerId: "p_peer_123456",
        name: "Mallory",
        color: "javascript:alert(1)",
        x: 10,
        y: 20,
        ts: Date.now(),
      })
    ).toBeNull();

    // Unknown kind / non-object
    expect(parseWireMessage({ kind: "exec_js", code: "1+1" })).toBeNull();
    expect(parseWireMessage(null)).toBeNull();
    expect(parseWireMessage("raw string")).toBeNull();
  });

  it("enforces bounds on element counts, label sizes, freedraw points, and raw DataChannel bytes", () => {
    const tooManyElements = Array.from(
      { length: MAX_BOARD_ELEMENTS + 1 },
      (_, idx) => makeValidElement({ id: `el_${idx}` })
    );
    expect(
      parseWireMessage({
        kind: "sync_state",
        peerId: "p_peer_123456",
        boardTitle: "Too Big",
        ts: Date.now(),
        elements: tooManyElements,
      })
    ).toBeNull();

    expect(
      parseWireMessage({
        kind: "sync_state",
        peerId: "p_peer_123456",
        boardTitle: "Long Label",
        ts: Date.now(),
        elements: [
          makeValidElement({ label: "x".repeat(MAX_LABEL_LENGTH + 1) }),
        ],
      })
    ).toBeNull();

    expect(
      parseWireMessage({
        kind: "sync_state",
        peerId: "p_peer_123456",
        boardTitle: "Too Many Points",
        ts: Date.now(),
        elements: [
          makeValidElement({
            kind: "freedraw",
            points: Array.from({ length: MAX_FREEDRAW_POINTS + 1 }, () => ({
              x: 1,
              y: 2,
            })),
          }),
        ],
      })
    ).toBeNull();

    // Oversized raw DataChannel payload (> 512 KB)
    expect(parseRawDataChannelMessage("x".repeat(600 * 1024))).toBeNull();
    // Invalid JSON string
    expect(parseRawDataChannelMessage("{broken-json")).toBeNull();
  });

  it("validates localStorage snapshots, strips unknown fields, and rejects corrupted data", () => {
    const validArrow = makeValidElement({
      id: "arr_free_1",
      kind: "arrow",
      x: 200,
      y: 200,
      width: -120,
      height: -40,
      fromPoint: { x: 200, y: 200 },
      toPoint: { x: 80, y: 160 },
      label: "",
      tone: "ink",
    });

    const rawJson = JSON.stringify({
      elements: [{ ...validArrow, injected: true }],
      boardTitle: "Saved Board",
      extraProp: "drop-me",
    });

    const snapshot = parseStoredBoardSnapshot(rawJson);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.elements).toHaveLength(1);
    expect(snapshot?.boardTitle).toBe("Saved Board");
    expect("extraProp" in (snapshot as object)).toBe(false);
    expect("injected" in (snapshot!.elements[0] as object)).toBe(false);

    // Corrupted JSON or invalid tone in localStorage returns null cleanly
    expect(parseStoredBoardSnapshot("{bad json")).toBeNull();
    expect(
      parseStoredBoardSnapshot(
        JSON.stringify({
          elements: [{ ...makeValidElement(), tone: "bad-tone" }],
        })
      )
    ).toBeNull();
  });

  it("JW-10: strips untrusted contentRev from wire messages and validates horizon timestamps", () => {
    const parsed = parseWireMessage({
      kind: "sync_state",
      peerId: "p_peer_123456",
      boardTitle: "Room",
      ts: 1700000001000,
      contentRev: 1_000_000_000,
      tombstoneHorizonAt: 1700000000000,
      boardEpochCreatedAt: 1699999000000,
      baseTimestamp: 1700000000500,
      elements: [],
    });
    expect(parsed).not.toBeNull();
    if (parsed && parsed.kind === "sync_state") {
      expect("contentRev" in parsed).toBe(false);
      expect(parsed.tombstoneHorizonAt).toBe(1700000000000);
      expect(parsed.boardEpochCreatedAt).toBe(1699999000000);
      expect(parsed.baseTimestamp).toBe(1700000000500);
    }

    const parsedHello = parseWireMessage({
      kind: "hello",
      peerId: "p_peer_123456",
      name: "Mallory",
      color: "#D94E28",
      ts: 1700000001000,
      hasLocalEdits: true,
      contentRev: 1_000_000_000,
    });
    expect(parsedHello).not.toBeNull();
    if (parsedHello && parsedHello.kind === "hello") {
      expect("contentRev" in parsedHello).toBe(false);
    }
  });
});
