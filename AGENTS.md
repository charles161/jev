<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Shipping

Push to `skot-launch`, never to `main`. The Gate workflow verifies every feature end to end and fast-forwards
`main` (which Vercel deploys) only when all checks pass. Before pushing: `pnpm build && python -m pytest
verify/features --launch`. A new component or route needs a `verify/features.yml` entry and a `@check` test;
`pnpm test` fails without them. See `verify/README.md`.
