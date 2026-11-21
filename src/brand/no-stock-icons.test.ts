import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const STOCK_ICON_PACKAGES =
  /^(lucide-react|lucide|react-icons(\/.*)?|@heroicons\/.*|heroicons|@tabler\/icons(-react)?|@radix-ui\/react-icons|@phosphor-icons\/.*|phosphor-react|react-feather|@fortawesome\/.*|@mui\/icons-material|@iconify\/.*|@hugeicons\/.*|@remixicon\/.*|remixicon)$/;
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

const rel = (f: string) => path.relative(ROOT, f);
const parse = (f: string) =>
  ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

describe("Skot icons: no emoji, no stock icon sets", () => {
  it("no string literal or JSX text under src/ contains an emoji / pictographic character (draw it with an icon from src/brand/icons)", () => {
    const hits: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const sf = parse(f);
      const visit = (node: ts.Node) => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)) &&
          PICTOGRAPHIC.test(node.text)
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push(`${rel(f)}:${line + 1} ${node.text.trim().slice(0, 60)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(hits).toEqual([]);
  });

  it("no stock icon package is imported (use the Skot set in src/brand/icons)", () => {
    const hits: string[] = [];
    for (const f of sourceFiles(SRC)) {
      for (const stmt of parse(f).statements) {
        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
          if (STOCK_ICON_PACKAGES.test(stmt.moduleSpecifier.text)) {
            hits.push(`${rel(f)} imports ${stmt.moduleSpecifier.text}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("package.json does not depend on a stock icon package", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => STOCK_ICON_PACKAGES.test(d))).toEqual([]);
  });

  it("shadcn is configured not to pull a stock icon library into new components", () => {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "components.json"), "utf8"));
    expect(cfg.iconLibrary ?? "").not.toMatch(STOCK_ICON_PACKAGES);
  });
});
