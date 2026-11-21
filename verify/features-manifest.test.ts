import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/*
 * verify/features.yml is the list of every user-facing feature and the end-to-end check that proves it.
 *
 * Heuristic (kept deliberately simple): a "feature surface" is
 *   - any component file src/components/jev/*.tsx, or
 *   - any App Router entry under src/app: page.tsx, route.ts, manifest.ts.
 * Each surface must be named in some feature's `sources`, or in `internal` with a reason.
 * Each feature's `check` must exist in the Python suite as @check("<id>") in verify/features/test_*.py,
 * and every check there must be in the manifest.
 */

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "verify/features.yml");
const SUITE_DIR = path.join(ROOT, "verify/features");

type Feature = {
  id: string;
  title: string;
  check: string;
  sources: string[];
  prod?: boolean;
  needs?: string;
  known_failure?: string;
};
type Manifest = { features: Feature[]; internal: { path: string; reason: string }[] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

function featureSurfaces(): string[] {
  const components = readdirSync(path.join(ROOT, "src/components/jev"))
    .filter((f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f))
    .map((f) => `src/components/jev/${f}`);
  const appEntries = walk(path.join(ROOT, "src/app"))
    .map(rel)
    .filter((f) => /\/(page\.tsx|route\.ts|manifest\.ts)$/.test(f));
  return [...components, ...appEntries].sort();
}

function suiteChecks(): string[] {
  return readdirSync(SUITE_DIR)
    .filter((f) => /^test_.*\.py$/.test(f))
    .flatMap((f) =>
      [...readFileSync(path.join(SUITE_DIR, f), "utf8").matchAll(/@check\("([a-z0-9-]+)"\)/g)].map((m) => m[1])
    )
    .sort();
}

function loadManifest(): Manifest {
  expect(existsSync(MANIFEST), "verify/features.yml is missing: it lists every feature and its check").toBe(true);
  const doc = parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  return { features: doc?.features ?? [], internal: doc?.internal ?? [] };
}

describe("feature manifest (verify/features.yml)", () => {
  it("names every feature component and route, so nothing ships without an end-to-end check", () => {
    const m = loadManifest();
    const listed = new Set([...m.features.flatMap((f) => f.sources ?? []), ...m.internal.map((i) => i.path)]);
    const missing = featureSurfaces().filter((s) => !listed.has(s));
    expect(
      missing,
      `New feature surface without a manifest entry. Add it to the \`sources\` of the feature it belongs to in ` +
        `verify/features.yml (and a @check in verify/features/test_features.py if it is a new feature), or list it ` +
        `under \`internal\` with the reason it is not user-facing`
    ).toEqual([]);
  });

  it("has no stale paths: every listed source exists", () => {
    const m = loadManifest();
    const paths = [...m.features.flatMap((f) => f.sources ?? []), ...m.internal.map((i) => i.path)];
    const gone = paths.filter((p) => !existsSync(path.join(ROOT, p)));
    expect(gone, "Remove or rename these entries in verify/features.yml: the files no longer exist").toEqual([]);
  });

  it("gives every feature a unique id, a title, sources and a check", () => {
    const m = loadManifest();
    expect(m.features.length).toBeGreaterThan(0);
    const ids = m.features.map((f) => f.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), "duplicate feature ids").toEqual([]);
    for (const f of m.features) {
      expect(f.title, `feature ${f.id} needs a title`).toBeTruthy();
      expect(f.check, `feature ${f.id} needs a check id`).toMatch(/^[a-z0-9-]+$/);
      expect(f.sources?.length ?? 0, `feature ${f.id} needs at least one source file`).toBeGreaterThan(0);
    }
    for (const i of m.internal) expect(i.reason, `internal entry ${i.path} needs a reason`).toBeTruthy();
  });

  it("matches the Python suite one to one: every manifest check is implemented and every check is listed", () => {
    const m = loadManifest();
    const manifestChecks = [...new Set(m.features.map((f) => f.check))].sort();
    const implemented = suiteChecks();
    expect(
      manifestChecks.filter((c) => !implemented.includes(c)),
      'Manifest checks with no @check("<id>") test in verify/features/test_*.py'
    ).toEqual([]);
    expect(
      implemented.filter((c) => !manifestChecks.includes(c)),
      "Checks in verify/features/test_*.py that no feature in verify/features.yml points to"
    ).toEqual([]);
    expect(
      implemented.filter((c, i) => implemented.indexOf(c) !== i),
      "A check id is implemented twice"
    ).toEqual([]);
  });
});
