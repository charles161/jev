# Jev — Shared Intelligent Whiteboard

An Excalidraw-reimagined collaborative diagramming studio powered by **TypeSafe AI's Jev** (`POST https://api.typesafe.ai/v1/systemone`, `jev-latest` / `jev-1.14.0`) — a System One probabilistic decision model returning calibrated typed decisions (`choice`, `noul`, `score`) in milliseconds without text generation.

## Key Capabilities

- **Write to Draw Instantaneously (`/`)**:
  - **Single-component rapid chaining**: Type `app` → `Enter` → `server` → `Enter` → `postgres` → `Enter` to chain cleanly spaced nodes (`128px` gap) with thin curved arrows automatically wired via Jev (`connect_target` + `should_connect`). Clicking an upstream node and adding another component fans cleanly into a downstream column (`96px` vertical spacing).
  - **Predictable flow stacking**: Typing sequential flows (`app -> server`, then `app -> gateway -> server`) uses Jev (`placement_slot` + `is_flow_iteration`) to stack collision-free rows neatly downward, left-aligned for easy comparison—without resetting your zoom.
  - **WYSIWYG live ghost & `Tab` switching**: While typing, the live ghost shows exact placement and auto-connections; press `Tab` (or click the placement pill) to cycle candidate targets/slots before pressing `Enter`.
- **3-Option `Tab` + `Enter` Predictive Drafting (`/api/jev/decide`)**:
  - On drag, edit, or creation, Jev evaluates parallel System One questions (`user_intent`, `next_action`, `should_auto_connect`) and ranks the Top 3 ghost-previewable next moves with calibrated probability bars.
  - Works seamlessly when the Thought Bar is empty (`Tab` cycles predictions, `Enter` applies, `⌘Z`/`⌘Shift+Z` undoes/redoes).
- **Excalidraw-Style Canvas & Slim Contextual Controls**:
  - **Marquee selection & multi-select**: Click and drag on empty canvas in Select (`V`) mode to select groups; `Shift + Click` toggles, `⌘A` selects all; pan via Hand (`H`), `Space + Drag`, middle-click, or trackpad scroll.
  - **In-place title editing**: Double-click any shape/frame/arrow, click the pencil icon, or press `F2` / `Enter` to edit titles directly on canvas (no subtitles).
  - **Slim floating pill & keyboard colors**: Clicking a single element floats a compact single-row pill above/below the shape (collision- and zoom-aware). Press `←` / `→` (or `[` / `]`) to cycle through all 7 color tones from the keyboard.
  - **Sketch vs. Clean modes & Themes**: Hand-drawn `roughjs` Sketch mode or crisp Clean vectors, Studio Vellum (light) and Midnight Blueprint (dark), plus SVG export.
- **Peer-to-Peer WebRTC Collaboration**: Real `RTCPeerConnection` + `RTCDataChannel` sync with live cursors via `/api/signal`, automatic same-origin `BroadcastChannel` multi-tab sync, and a zero-server manual SDP Offer/Answer handshake tab.

## Project Architecture

- `src/components/jev/JevWorkspace.tsx` — Main workspace state, keyboard shortcuts, live Thought Bar + Jev placement orchestration, multi-select bar, and P2P session lifecycle.
- `src/components/jev/JevCanvas.tsx` — Infinite SVG/`roughjs` canvas, marquee multi-selection, drag/resize/edge-connect handles, ghost preview layer, and native in-place title editor.
- `src/components/jev/SelectionInspector.tsx` — Compact single-row floating pill with keyboard-navigable color swatches, shape-kind icons, and actions.
- `src/components/jev/ThoughtBar.tsx` & `PredictionHud.tsx` — Bottom intelligence dock, live Jev placement pill, and 3-option `Tab + Enter` HUD.
- `src/lib/jev/placement-engine.ts` — Deterministic collision-free spatial placement planner, downward flow stacking, and single-component auto-connect layout.
- `src/lib/jev/diagram-parser.ts` — Instant arrow-shorthand and natural-language diagram parser.
- `src/lib/jev/intent-engine.ts` & `prediction-engine.ts` — Spatial drag-intent detection and candidate action pool generation.
- `src/lib/jev/popover-placement.ts` — Zoom- and collision-aware floating toolbar placement.
- `src/lib/jev/typesafe-client.ts` & `src/app/api/jev/decide/route.ts` — Server-side TypeSafe AI Jev System One client and decision API (`rank_actions`, `classify_prompt`, `place_diagram`) with zero-key local fallback.
- `src/lib/jev/webrtc-collab.ts` & `src/app/api/signal/route.ts` — WebRTC P2P + `BroadcastChannel` collaboration and signaling relay.

## Running Locally

```bash
pnpm install
pnpm dev
```

Set `TYPESAFE_API_KEY` in your environment to enable live calls to `https://api.typesafe.ai/v1/systemone`. Without it, the whiteboard runs seamlessly on the local calibrated fallback.
