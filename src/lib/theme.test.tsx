import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  resolveTheme,
  storedThemeFor,
} from "@/lib/theme";
import { ThemeBootScript } from "@/app/theme-boot-script";

describe("resolveTheme: dark is the default, a saved explicit choice wins", () => {
  it("defaults to dark (midnight) with no saved preference", () => {
    expect(DEFAULT_THEME).toBe("midnight");
    expect(resolveTheme(null)).toBe("midnight");
    expect(resolveTheme(undefined)).toBe("midnight");
  });

  it("honours a saved 'light' or 'dark'", () => {
    expect(resolveTheme("light")).toBe("vellum");
    expect(resolveTheme("dark")).toBe("midnight");
  });

  it("ignores unknown stored values", () => {
    expect(resolveTheme("LIGHT")).toBe("midnight");
    expect(resolveTheme("vellum")).toBe("midnight");
    expect(resolveTheme("")).toBe("midnight");
  });

  it("stores the explicit choice as 'light' | 'dark'", () => {
    expect(storedThemeFor("vellum")).toBe("light");
    expect(storedThemeFor("midnight")).toBe("dark");
  });
});

class FakeClassList {
  constructor(private readonly set = new Set<string>()) {}
  add(c: string) { this.set.add(c); }
  remove(c: string) { this.set.delete(c); }
  toggle(c: string, on?: boolean) {
    if (on ?? !this.set.has(c)) this.set.add(c);
    else this.set.delete(c);
  }
  contains(c: string) { return this.set.has(c); }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const throwingStorage = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("SecurityError"); },
  removeItem: () => { throw new Error("SecurityError"); },
};

function runBootScript(storage: unknown, ssrClasses: string[] = ["dark"]) {
  const classList = new FakeClassList(new Set(ssrClasses));
  const document = { documentElement: { classList } };
  new Function("document", "localStorage", THEME_BOOT_SCRIPT)(document, storage);
  return classList.contains("dark");
}

describe("theme boot script (runs in <head> before first paint)", () => {
  it("keeps dark on a fresh load with no storage", () => {
    expect(runBootScript(fakeStorage())).toBe(true);
    expect(runBootScript(fakeStorage(), [])).toBe(true);
  });

  it("switches to light when 'light' is saved", () => {
    expect(runBootScript(fakeStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe(false);
  });

  it("stays dark when 'dark' is saved or storage throws", () => {
    expect(runBootScript(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }), [])).toBe(true);
    expect(runBootScript(throwingStorage, [])).toBe(true);
  });

  it("renders as an inline script carrying the CSP nonce", () => {
    const html = renderToStaticMarkup(<ThemeBootScript nonce="N0NCE" />);
    expect(html).toContain('nonce="N0NCE"');
    expect(html).toBe(`<script nonce="N0NCE">${THEME_BOOT_SCRIPT}</script>`);
  });
});

describe("root layout renders dark on the server and boots the saved theme", () => {
  const layout = readFileSync(path.join(__dirname, "..", "app", "layout.tsx"), "utf8");

  it("server-renders <html class=\"… dark\"> with suppressHydrationWarning", () => {
    expect(layout).toMatch(/<html[\s\S]*className=\{`[^`]*\bdark\b[^`]*`\}/);
    expect(layout).toMatch(/<html[\s\S]*suppressHydrationWarning[\s\S]*>/);
  });

  it("puts the boot script in <head> with the per-request nonce", () => {
    expect(layout).toMatch(/\(await headers\(\)\)\.get\("x-nonce"\)/);
    expect(layout).toMatch(/<head>\s*<ThemeBootScript nonce=\{nonce\} \/>\s*<\/head>/);
  });
});

describe("theme store (client)", () => {
  let classList: FakeClassList;
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    vi.resetModules();
    classList = new FakeClassList(new Set(["dark"]));
    storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("document", { documentElement: { classList } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads dark by default and light when saved", async () => {
    const store = await import("@/lib/theme-store");
    expect(store.readBoardTheme()).toBe("midnight");
    storage.setItem(THEME_STORAGE_KEY, "light");
    expect(store.readBoardTheme()).toBe("vellum");
  });

  it("persists an explicit choice, updates <html>, and notifies subscribers", async () => {
    const store = await import("@/lib/theme-store");
    const listener = vi.fn();
    const unsubscribe = store.subscribeBoardTheme(listener);
    store.setBoardTheme("vellum");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(classList.contains("dark")).toBe(false);
    expect(store.readBoardTheme()).toBe("vellum");
    store.setBoardTheme("midnight");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(classList.contains("dark")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("still switches for the session when storage is blocked", async () => {
    vi.stubGlobal("window", { localStorage: throwingStorage });
    const store = await import("@/lib/theme-store");
    expect(store.readBoardTheme()).toBe("midnight");
    store.setBoardTheme("vellum");
    expect(store.readBoardTheme()).toBe("vellum");
    expect(classList.contains("dark")).toBe(false);
  });
});

describe("components take the theme from the store, not a hard-coded default", () => {
  const SRC = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });

  it("has no useState<BoardTheme>(…) and no direct 'dark' class toggling outside the theme store", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join("lib", "theme-store.ts"))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/useState<BoardTheme>|classList\.(toggle|add|remove)\(\s*["']dark["']/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "Use useBoardTheme() from @/lib/theme-store: it defaults to dark, honours the saved choice and matches the <head> boot script."
    ).toEqual([]);
  });
});
