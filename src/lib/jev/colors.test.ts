import { describe, expect, it } from "vitest";
import {
  ALL_TONES,
  getTonePalette,
  inferToneFromLabel,
  MIDNIGHT_PALETTES,
  PEER_COLORS,
  VELLUM_PALETTES,
} from "@/lib/jev/colors";
import type { ColorTone } from "@/lib/jev/types";

describe("colors palette & tone inference", () => {
  it("defines complete palettes for every tone in both vellum and midnight themes", () => {
    expect(ALL_TONES).toHaveLength(7);

    for (const tone of ALL_TONES) {
      const vellum = getTonePalette(tone, "vellum");
      const midnight = getTonePalette(tone, "midnight");

      expect(vellum).toEqual(VELLUM_PALETTES[tone]);
      expect(midnight).toEqual(MIDNIGHT_PALETTES[tone]);

      for (const palette of [vellum, midnight]) {
        expect(palette.stroke).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(palette.fillSolid).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(palette.text).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(palette.subtext).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(palette.swatch).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(palette.fill.length).toBeGreaterThan(0);
        expect(palette.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("falls back safely to ink palette for unknown or prototype property tones", () => {
    const invalidTones = [
      "unknown",
      "",
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ];

    for (const bad of invalidTones) {
      expect(getTonePalette(bad as ColorTone, "vellum")).toEqual(
        VELLUM_PALETTES.ink
      );
      expect(getTonePalette(bad as ColorTone, "midnight")).toEqual(
        MIDNIGHT_PALETTES.ink
      );
    }
  });

  it("exposes distinct hex peer colors", () => {
    expect(PEER_COLORS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PEER_COLORS).size).toBe(PEER_COLORS.length);
    for (const color of PEER_COLORS) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("infers semantic tones from labels across domains and falls back to ink", () => {
    expect(inferToneFromLabel("Mobile App")).toBe("terracotta");
    expect(inferToneFromLabel("Web Client")).toBe("terracotta");
    expect(inferToneFromLabel("Postgres DB")).toBe("teal");
    expect(inferToneFromLabel("Redis Cache")).toBe("teal");
    expect(inferToneFromLabel("S3 Bucket")).toBe("teal");
    expect(inferToneFromLabel("Kafka Event Bus")).toBe("ochre");
    expect(inferToneFromLabel("Stripe Webhook")).toBe("ochre");
    expect(inferToneFromLabel("Background Worker")).toBe("ochre");
    expect(inferToneFromLabel("Valid Token?")).toBe("plum");
    expect(inferToneFromLabel("Feature Gate")).toBe("plum");
    expect(inferToneFromLabel("OAuth Guard")).toBe("plum");
    expect(inferToneFromLabel("API Gateway")).toBe("cobalt");
    expect(inferToneFromLabel("WebRTC Signaling")).toBe("cobalt");
    expect(inferToneFromLabel("Reasoning LLM")).toBe("cobalt");
    expect(inferToneFromLabel("VPC Region")).toBe("slate");
    expect(inferToneFromLabel("Core Cluster")).toBe("slate");
    expect(inferToneFromLabel("Build & Lint")).toBe("ink");
    expect(inferToneFromLabel("Mystery Box")).toBe("ink");
    expect(inferToneFromLabel("")).toBe("ink");
  });

  it("respects deterministic priority when a label matches multiple keyword groups", () => {
    // "App" (terracotta) takes priority over "API" (cobalt) and "DB" (teal)
    expect(inferToneFromLabel("App API DB")).toBe("terracotta");
    // "Redis" (teal) takes priority over "Queue" (ochre)
    expect(inferToneFromLabel("Redis Queue")).toBe("teal");
    // "Event" (ochre) takes priority over "Router" (plum)
    expect(inferToneFromLabel("Event Router")).toBe("ochre");
    // "Auth" (plum) takes priority over "Service" (cobalt)
    expect(inferToneFromLabel("Auth Service")).toBe("plum");
  });
});
