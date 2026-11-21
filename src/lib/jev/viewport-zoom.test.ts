import { describe, expect, it } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  wheelViewport,
  zoomAroundPoint,
  zoomKeyAction,
} from "@/lib/jev/viewport-zoom";

const worldAt = (v: { x: number; y: number; zoom: number }, p: { x: number; y: number }) => ({
  x: (p.x - v.x) / v.zoom,
  y: (p.y - v.y) / v.zoom,
});

describe("viewport zoom (wheel, pinch, keys, buttons)", () => {
  it("zoomAroundPoint keeps the world point under the anchor fixed and clamps", () => {
    const v = { x: 80, y: 40, zoom: 1 };
    const p = { x: 700, y: 450 };
    const zin = zoomAroundPoint(v, 1.25, p);
    expect(zin.zoom).toBeCloseTo(1.25);
    expect(worldAt(zin, p).x).toBeCloseTo(worldAt(v, p).x);
    expect(worldAt(zin, p).y).toBeCloseTo(worldAt(v, p).y);
    expect(zoomAroundPoint(v, 100, p).zoom).toBe(ZOOM_MAX);
    expect(zoomAroundPoint(v, 0.001, p).zoom).toBe(ZOOM_MIN);
  });

  it("ctrl/cmd + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms around the cursor", () => {
    const v = { x: 0, y: 0, zoom: 1 };
    const cursor = { x: 300, y: 200 };
    const zin = wheelViewport(v, { deltaX: 0, deltaY: -40, ctrlKey: true, metaKey: false }, cursor);
    expect(zin.zoom).toBeGreaterThan(1);
    expect(worldAt(zin, cursor).x).toBeCloseTo(300);
    const zout = wheelViewport(v, { deltaX: 0, deltaY: 40, ctrlKey: false, metaKey: true }, cursor);
    expect(zout.zoom).toBeLessThan(1);
  });

  it("a plain wheel pans by the deltas", () => {
    expect(
      wheelViewport({ x: 10, y: 20, zoom: 1.5 }, { deltaX: 5, deltaY: -7, ctrlKey: false, metaKey: false }, { x: 0, y: 0 })
    ).toEqual({ x: 5, y: 27, zoom: 1.5 });
  });

  it("maps Ctrl/Cmd + = / + / - / 0 and Shift+1 to zoom actions, and leaves other keys alone", () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }> = {}) =>
      zoomKeyAction({ key, code: mods.code ?? "", ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(k("=", { ctrlKey: true })).toBe("in");
    expect(k("+", { metaKey: true, shiftKey: true })).toBe("in");
    expect(k("-", { ctrlKey: true })).toBe("out");
    expect(k("0", { metaKey: true })).toBe("reset");
    expect(k("!", { shiftKey: true, code: "Digit1" })).toBe("fit");
    expect(k("1")).toBeNull();
    expect(k("=")).toBeNull();
    expect(k("0")).toBeNull();
  });
});

describe("wheel listener wiring", () => {
  it("no component uses React onWheel (passive in React 17+, so preventDefault is ignored and the browser page zooms too); register a native { passive: false } listener instead", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../components/jev");
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /onWheel=/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(hits).toEqual([]);
    const canvas = readFileSync(path.join(dir, "JevCanvas.tsx"), "utf8");
    expect(canvas).toMatch(/addEventListener\("wheel", handleWheel, \{ passive: false \}\)/);
  });
});
