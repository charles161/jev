# Jev — Shared Intelligent Whiteboard

An Excalidraw-reimagined collaborative diagramming studio powered by **TypeSafe AI's Jev** (`POST https://api.typesafe.ai/v1/systemone`, `jev-latest`) — a System One probabilistic decision model returning calibrated typed decisions (`choice`, `noul`, `score`) in milliseconds without text generation.

## Key Capabilities

- **Write to Draw Instantaneously (`/`)**:
  - **Single-component rapid chaining**: Type `app` → `Enter` → `server` → `Enter` → `postgres` → `Enter` to chain cleanly spaced nodes (`128px` gap) with thin curved arrows automatically wired via Jev (`connect_target` + `should_connect`). Clicking an upstream node and adding another component fans into a downstream column (`96px` vertical spacing).
  - **Predictable flow stacking**: Typing sequential flows (`app -> server`, then `app -> gateway -> server`) uses Jev (`placement_slot` + `is_flow_iteration`) to stack collision-free rows downward, left-aligned for easy comparison without resetting zoom.
  - **WYSIWYG live ghost & `Tab` switching**: While typing, the live ghost shows exact placement and auto-connections; press `Tab` (or click the placement pill) to cycle candidate targets/slots before pressing `Enter`.
- **3-Option `Tab` + `Enter` Predictive Drafting (`/api/jev/decide`)**:
  - On drag, edit, or creation, Jev evaluates parallel System One questions (`user_intent`, `next_action`, `should_auto_connect`) and ranks the Top 3 ghost-previewable next moves with calibrated probability bars.
  - Works when the Thought Bar is empty (`Tab` cycles predictions, `Enter` applies, `⌘Z`/`⌘Shift+Z` undoes/redoes).
- **Excalidraw-Style Canvas & Slim Contextual Controls**:
  - **Marquee selection & multi-select**: Click and drag on empty canvas in Select (`V`) mode to select groups; `Shift + Click` toggles, `⌘A` selects all; pan via Hand (`H`), `Space + Drag`, middle-click, or trackpad scroll.
  - **In-place title editing**: Double-click any shape/frame/arrow, click the pencil icon, or press `F2` / `Enter` to edit titles directly on canvas.
  - **Slim floating pill & keyboard colors**: Clicking a single element floats a compact single-row pill above/below the shape (collision- and zoom-aware). Press `←` / `→` (or `[` / `]`) to cycle through all 7 color tones from the keyboard.
  - **Sketch vs. Clean modes & Themes**: Hand-drawn `roughjs` Sketch mode or crisp Clean vectors, Studio Vellum (light) and Midnight Blueprint (dark), plus SVG export.
- **Peer-to-Peer WebRTC Collaboration**: Real `RTCPeerConnection` + `RTCDataChannel` sync with live cursors via `/api/signal`, automatic same-origin `BroadcastChannel` multi-tab sync, and a zero-server manual SDP Offer/Answer handshake tab.

## Tech Stack

- **Framework**: Next.js 16.4.6 (App Router, Turbopack) & React 19.3
- **Language**: TypeScript 5 (strict mode), Zod runtime validation, Vitest
- **Styling & UI**: Tailwind CSS v4 (`@tailwindcss/turbopack`), shadcn/ui (`@base-ui/react`), `lucide-react`
- **Canvas Rendering**: SVG + `roughjs`
- **Intelligence**: TypeSafe AI Jev System One API (`POST https://api.typesafe.ai/v1/systemone`) with honest `"heuristic"` fallback when no API key is configured
- **Collaboration**: WebRTC (`RTCPeerConnection` / `RTCDataChannel`), `BroadcastChannel`, authenticated HTTP signaling relay (`/api/signal`) using `>=128-bit` room IDs, hash-fragment per-room secrets (`#room=<id>&k=<secret>`), and server-issued peer tokens
- **Package Manager**: `pnpm` (`10.x`)

## Architecture

- `src/components/jev/JevWorkspace.tsx` — Main workspace state, keyboard shortcuts, live Thought Bar + Jev placement orchestration, `localStorage` room persistence, multi-select bar, and P2P session lifecycle.
- `src/components/jev/JevCanvas.tsx` — Infinite SVG/`roughjs` canvas, marquee multi-selection, drag/resize/edge-connect handles, ghost preview layer, and native in-place title editor.
- `src/components/jev/SelectionInspector.tsx` — Compact single-row floating pill with keyboard-navigable color swatches, shape-kind icons, and actions.
- `src/components/jev/ThoughtBar.tsx` & `PredictionHud.tsx` — Bottom intelligence dock, live Jev placement pill, and 3-option `Tab + Enter` HUD.
- `src/components/jev/ShareP2PDialog.tsx` — Room link sharing, multi-tab test trigger, demo peer toggle, and zero-server manual SDP Offer/Answer flow.
- `src/lib/jev/placement-engine.ts` — Deterministic collision-free spatial placement planner, downward flow stacking, and single-component auto-connect layout.
- `src/lib/jev/diagram-parser.ts` — Arrow-shorthand and natural-language diagram parser.
- `src/lib/jev/intent-engine.ts` & `prediction-engine.ts` — Spatial drag-intent detection and candidate action pool generation.
- `src/lib/jev/popover-placement.ts` — Zoom- and collision-aware floating toolbar placement.
- `src/lib/jev/typesafe-client.ts` & `src/app/api/jev/decide/route.ts` — Server-side TypeSafe AI Jev System One client (strict timeout, typed error fallback) and hardened decision API (`rank_actions`, `classify_prompt`, `place_diagram`) with Zod validation, UTF-8 byte caps, per-IP rate limiting, and `Cache-Control: no-store`.
- `src/lib/jev/webrtc-collab.ts` & `src/app/api/signal/route.ts` — WebRTC P2P + `BroadcastChannel` collaboration with roster-driven glare-free peer discovery, ICE candidate buffering, content-bearing host election, connection-bound peer identity, tombstone horizon & epoch resync, logical `titleRev` merging (`src/lib/jev/board-sync.ts`), Zod inbound validation (`src/lib/jev/sync-validation.ts`), exponential backoff with jitter & `Retry-After`, per-message signal isolation, and validated, rate-limited ephemeral signaling relay.
- `src/app/api/ice-config/route.ts` & `src/lib/server/ice-config.ts` — Dynamic runtime STUN/TURN ICE server configuration endpoint (`GET /api/ice-config`, `Cache-Control: no-store`) minting short-lived (~10 min TTL) coturn REST/HMAC credentials exclusively for authenticated signaling peers, returning STUN-only when unauthenticated or unconfigured.
- `src/lib/jev/board-history.ts` — Pre-drag undo snapshot history controller and throttled drag broadcast scheduler.
- `src/app/api/health/route.ts` — Readiness endpoint (`GET /api/health`, `Cache-Control: no-store`).
- `src/lib/server/` — Shared server utilities for streaming byte-capped JSON parsing, bounded sliding-window rate limiting, and structured JSON logging.
- `src/app/error.tsx` & `src/app/global-error.tsx` — Client recovery boundaries with retry and safe local-board `localStorage` reset.
- `src/proxy.ts` & `next.config.ts` — Per-request cryptographic CSP nonce (`script-src 'self' 'nonce-...' 'strict-dynamic'`, no `'unsafe-inline'` in `script-src`) via Next.js 16 Proxy plus HTTP security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`).

## Environment Variables

Copy `.env.example` to `.env.local` if you want to configure optional variables:

| Variable | Required | Description |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Optional | Server-side API key for live calls to `https://api.typesafe.ai/v1/systemone`. When unset, `/api/jev/decide` runs on the calibrated local fallback with zero errors. |
| `JEV_UPSTREAM_MAX_PER_MINUTE` | Optional | Global per-minute upstream call cap for `/api/jev/decide` (default `120`). When exhausted, requests fall back to honest `"heuristic"` mode. |
| `JEV_UPSTREAM_MAX_PER_DAY` | Optional | Global per-day upstream call cap for `/api/jev/decide` (default `5000`). When exhausted, requests fall back to honest `"heuristic"` mode. |
| `TRUST_PROXY` | Required in prod | Client IP resolution mode for rate limits and signaling room caps: `cloudflare` (trusts `CF-Connecting-IP` only, ignores `X-Forwarded-For`) or `none` (ignores proxy headers; in production requires a direct peer IP or `ALLOW_SINGLE_USER_LOCAL=1`). API routes fail fast with `503` in production when unset. |
| `ALLOW_SINGLE_USER_LOCAL` | Optional | Set to `1` alongside `TRUST_PROXY=none` only for single-user local production runs without a reverse proxy. |
| `ICE_SERVERS_JSON` | Optional | Server-side JSON array of STUN `RTCIceServer` objects served via `GET /api/ice-config` (`Cache-Control: no-store`). Static TURN entries are ignored; falls back to Google STUN when unset or invalid. |
| `TURN_URLS` | Optional | Comma-separated `turn:` / `turns:` / `stun:` server URLs paired with default STUN via `GET /api/ice-config`. `turn:`/`turns:` URLs are served only when `TURN_SHARED_SECRET` is set and the caller authenticates with a valid room secret and peer token. |
| `TURN_SHARED_SECRET` | Optional | Shared secret (`static-auth-secret` / `use-auth-secret` in coturn) used to mint short-lived (~10 min TTL) HMAC-SHA1 TURN credentials (`username = "<unixExpiry>:<peerId>"`) for authenticated room peers. |

## Development, Checks & Production Build

```bash
# Install dependencies
pnpm install

# Start development server (default http://localhost:3000)
pnpm dev

# Generate Next.js route types & run strict TypeScript check
pnpm typecheck

# Run unit & API security tests
pnpm test

# Run ESLint
pnpm run lint

# Build for production & start server (set TRUST_PROXY=cloudflare behind Cloudflare, or TRUST_PROXY=none ALLOW_SINGLE_USER_LOCAL=1 for local single-user prod)
pnpm run build
TRUST_PROXY=cloudflare pnpm start
```

### Continuous Integration

GitHub Actions (`.github/workflows/ci.yml`) runs automatically on every pull request and push to `main` on Node 22 with minimal `contents: read` permissions:

- **Secret Scan**: full-history `gitleaks` scan (`fetch-depth: 0`).
- **Verify**: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm run lint`, `pnpm test` (Vitest unit & API tests, no `TYPESAFE_API_KEY` required), and `pnpm run build`.

> **Note on signaling & persistence**: Out of the box, `/api/signal` uses an in-memory room relay (single-instance dev/demo scope) and boards persist per room in browser `localStorage`. Multi-instance production deployments should back `/api/signal` with shared state (e.g. Redis/Upstash or WebSockets) and configure TURN credentials alongside Google STUN for restrictive NATs.
