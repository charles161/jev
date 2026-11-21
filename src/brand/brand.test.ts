import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { BRAND_NAME, BRAND_TAGLINE, siteMetadata as metadata } from "@/brand/brand";
import { sanitizeExportFilename } from "@/lib/jev/svg-export";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const OLD_NAME = /\bJev\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

function visibleTextHits(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (isText) {
      const value = node.getText(sf);
      if (OLD_NAME.test(value)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${path.relative(ROOT, file)}:${line + 1} ${value.trim().slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("Skot brand", () => {
  it("no string literal or JSX text under src/ shows the old name 'Jev' (use BRAND_NAME from src/brand/brand.ts)", () => {
    const hits = sourceFiles(SRC).flatMap(visibleTextHits);
    expect(hits).toEqual([]);
  });

  it("page metadata introduces Skot with its tagline", () => {
    expect(BRAND_NAME).toBe("Skot");
    expect(BRAND_TAGLINE).toBe("sketch at the speed of thought");
    expect(String(metadata.title)).toContain("Skot");
    expect(String(metadata.description).toLowerCase()).toContain(BRAND_TAGLINE);
    expect(metadata.openGraph?.title).toContain("Skot");
    expect(metadata.applicationName).toBe("Skot");
  });

  it("the root layout serves siteMetadata", () => {
    const layout = readFileSync(path.join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/export const metadata(: Metadata)? = siteMetadata;/);
  });

  it("README and package.json carry the new name", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme.split("\n")[0]).toContain("Skot");
    expect(readme).toContain(BRAND_TAGLINE);
    expect(readme).not.toMatch(OLD_NAME);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("skot");
  });

  it("default export filename uses the new name", () => {
    expect(sanitizeExportFilename("")).toBe("skot-board.svg");
  });
});
