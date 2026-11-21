import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ICONS, sketchRect } from "./index";

const REQUIRED = [
  "IconSelect", "IconHand", "IconBox", "IconDiamond", "IconDatabase", "IconActor", "IconArrow",
  "IconFrame", "IconPen", "IconText", "IconUndo", "IconRedo", "IconPlus", "IconMinus", "IconFit",
  "IconMoon", "IconSun", "IconDownload", "IconTrash", "IconCopy", "IconCheck", "IconClose",
  "IconChevronRight", "IconArrowRight", "IconArrowLeftRight", "IconEnter", "IconSpark", "IconWand",
  "IconFork", "IconBranch", "IconLayers", "IconSpinner", "IconCpu", "IconScale", "IconPin",
  "IconUsers", "IconBroadcast", "IconWifi", "IconExternal", "IconWarning", "IconReset", "IconEdit",
  "IconLock", "IconUnlock", "IconGroup", "IconImage", "IconAlignCenter", "SkotMark",
  "IconShapes", "IconQueue", "IconCache", "IconLoadBalancer", "IconBlob", "IconExternalSystem", "IconUser",
  "IconZone", "IconEntity", "IconClass", "IconActivation", "IconFragment", "IconInitialState", "IconFinalState",
  "IconApiCard", "IconNoteCard", "IconSequence", "IconStateMachine", "IconEstimate", "IconPacks", "IconSlash",
  "IconEndNone", "IconEndArrow", "IconEndOpen", "IconEndTriangle", "IconEndDiamond", "IconEndOpenDiamond",
  "IconEndOne", "IconEndOnlyOne", "IconEndZeroOne", "IconEndMany", "IconEndOneMany", "IconEndZeroMany",
];

const HEX = /#[0-9a-f]{3,8}\b/i;
const NAMED_COLOR = /(?:fill|stroke)="(?!none"|currentColor")[^"]*"/;

describe("Skot icon registry", () => {
  it("contains every required icon exactly once", () => {
    const names = ICONS.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    expect(REQUIRED.filter((n) => !names.includes(n))).toEqual([]);
  });

  it("draws every icon differently (no copy-pasted glyphs)", () => {
    const bodies = ICONS.map(({ Icon }) => renderToStaticMarkup(<Icon />).replace(/^<svg[^>]*>/, ""));
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});

describe.each(ICONS)("$name", ({ name, Icon }) => {
  const plain = renderToStaticMarkup(<Icon />);
  const titled = renderToStaticMarkup(<Icon title={`${name} label`} />);

  it("renders a 24-grid currentColor svg", () => {
    expect(plain.startsWith("<svg")).toBe(true);
    expect(plain).toContain('viewBox="0 0 24 24"');
    expect(plain).toMatch(/^<svg[^>]*\sfill="none"/);
    expect(plain).toMatch(/^<svg[^>]*\sstroke="currentColor"/);
    expect(plain).toMatch(/stroke-linecap="round"/);
    expect(plain).toMatch(/stroke-linejoin="round"/);
  });

  it("uses currentColor only (fill/stroke are none or currentColor, no hex)", () => {
    expect(plain).not.toMatch(HEX);
    expect(plain).not.toMatch(NAMED_COLOR);
  });

  it("is decorative without a title", () => {
    expect(plain).toMatch(/^<svg[^>]*\saria-hidden="true"/);
    expect(plain).toMatch(/^<svg[^>]*\sfocusable="false"/);
    expect(plain).not.toContain("<title>");
    expect(plain).not.toContain('role="img"');
  });

  it("is a labelled image with a title", () => {
    expect(titled).toMatch(/^<svg[^>]*\srole="img"/);
    expect(titled).toContain(`aria-label="${name} label"`);
    expect(titled).toContain(`<title>${name} label</title>`);
    expect(titled).not.toContain("aria-hidden");
  });

  it("forwards className and size", () => {
    const out = renderToStaticMarkup(<Icon className="size-4" size={16} />);
    expect(out).toMatch(/^<svg[^>]*\sclass="size-4"/);
    expect(out).toMatch(/^<svg[^>]*\swidth="16"/);
  });
});

describe("Skot corner", () => {
  it("leaves the top-left corner open: 2px top overshoot, left edge stops 1px short", () => {
    expect(sketchRect(4, 5, 16, 14)).toBe("M2 5H18a2 2 0 0 1 2 2V17a2 2 0 0 1 -2 2H6a2 2 0 0 1 -2 -2V8");
  });
});

describe("favicon", () => {
  const svg = readFileSync(path.resolve(__dirname, "../../app/icon.svg"), "utf8");
  it("is the white mark on a terracotta rounded square", () => {
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toMatch(/<rect[^>]*rx="\d+(\.\d+)?"[^>]*fill="#D94E28"/);
    expect(svg).toContain('stroke="#FFFFFF"');
  });
});

describe("contact sheet under a base path", () => {
  it("serves the favicon preview through appUrl so /skot/icons does not 404", async () => {
    const prev = process.env.NEXT_PUBLIC_BASE_PATH;
    process.env.NEXT_PUBLIC_BASE_PATH = "/skot";
    try {
      const { ContactSheet } = await import("./ContactSheet");
      const html = renderToStaticMarkup(<ContactSheet />);
      expect(html).toContain('src="/skot/icon.svg"');
      expect(html).not.toMatch(/src="\/icon\.svg"/);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
      else process.env.NEXT_PUBLIC_BASE_PATH = prev;
    }
  });
});
