# Feature verification and the deploy gate

## How code reaches production

```
you / agents ──push──> skot-launch ──Gate workflow──> main ──Vercel──> https://skot.lightslips.ai
                          │  lint, typecheck, unit tests, next build,
                          │  next start + every feature check
                          └─ all green: fast-forward main to that commit
                             any red:   main stays put, evidence uploaded
```

- **Push to `skot-launch`. Never push to `main`.** The Gate workflow (`.github/workflows/gate.yml`) is
  the only thing that moves `main`, and only by fast-forward to a commit it verified.
- If someone did push to `main` directly, the next promotion fails with "main has commits that
  skot-launch does not". Merge `origin/main` into `skot-launch` and push again.
- Pull requests into `skot-launch` or `main` run the same checks (without promoting).
- After Vercel deploys production, `.github/workflows/post-deploy.yml` runs the read-only production
  subset against https://skot.lightslips.ai and opens a `prod-verify` issue if it fails. It also runs
  every 6 hours.

## The suite

`verify/features.yml` lists every user-facing feature and the check that proves it.
`verify/features/test_features.py` has one user-level check per feature. Each drives the real UI through
`verify/features/driver.py` (keys, clicks, typing, pen strokes; page evaluation only reads state) and
leaves evidence: `verify/out/<check>.png` and one JSON line in `verify/out/results.jsonl`.

Python Playwright, because the agent driver it reuses (`skot-bot`) and the cstack verify-app kit are
Python, and the repo had no browser e2e tooling to stay consistent with.

```sh
python -m pip install -r verify/requirements.txt && python -m playwright install chromium
pnpm build
python -m pytest verify/features --launch              # starts next start itself, all checks
python -m pytest verify/features --launch -k fork      # one check
python -m pytest verify/features --base-url https://skot.lightslips.ai --subset prod   # read-only
python verify/summarize.py verify/out/results.jsonl    # markdown table of the last run
```

- `--launch` runs the server with `TRUST_PROXY=cloudflare` and gives every check its own
  `CF-Connecting-IP`, so checks behave like separate visitors and do not share one IP's signaling limits.
- `--subset prod` runs only features marked `prod: true`: page loads, keyboard zoom, static assets. No
  drawing, so no rank or AI Gateway calls, and Vercel Analytics beacons are stubbed out.
- `two-person-sync` needs one long-running server (signaling rooms live in one process's memory), so it
  runs under `--launch` and is skipped against Vercel with that reason.
- A feature with `known_failure:` runs as a strict xfail: it is reported, does not block the gate, and turns
  the suite red the day it starts passing so the marker gets removed.

## Adding or changing a feature

1. Add the feature to `verify/features.yml` with its `sources` and a `check` id.
2. Add `@check("<id>")` to a test in `verify/features/test_features.py` that does what a user does and
   asserts what the user would see.
3. `pnpm test` fails until both exist: `verify/features-manifest.test.ts` requires every
   `src/components/jev/*.tsx` and every `src/app/**/{page.tsx,route.ts,manifest.ts}` to be listed in some
   feature's `sources` (or under `internal` with a reason), and the manifest and the Python checks to match
   one to one.
4. When a bug slips through, add the assertion that would have caught it to the feature's check.
