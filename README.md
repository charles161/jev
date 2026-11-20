# Jev — Shared Intelligent Whiteboard

An Excalidraw-reimagined collaborative diagramming studio designed to move at the speed of thought.

## Core Capabilities

- **Write to Draw Instantaneously**: Press `/` and type natural language (e.g. `Microservices architecture with API gateway, auth, billing, redis, and postgres`) or arrow shorthand (`User -> Login -> Valid Token? -> [Yes: Dashboard, No: Retry] -> Postgres`). Jev previews the diagram live on the canvas and materializes it on `Enter`.
- **Spatial Intent Understanding**: When you move a node, Jev interprets what you are doing — splicing into an existing arrow, opening a pipeline gap between connected nodes, aligning into a row or column, branching off-axis, or grouping inside a frame.
- **3-Option `Tab` + `Enter` Predictive Drafting**: After every move, edit, or creation, Jev predicts your next 3 most likely actions and renders a live blueprint ghost directly on the canvas. Press `Tab` to cycle between all 3 ghosts and `Enter` to apply immediately.
- **Peer-to-Peer WebRTC Collaboration**: Real `RTCPeerConnection` + `RTCDataChannel` sync with live cursors via a lightweight `/api/signal` relay, automatic same-origin `BroadcastChannel` multi-tab sync, and a zero-server manual SDP Offer/Answer handshake mode.
- **Hand-Drafted Sketch & Clean Vector Modes**: Powered by `roughjs` with instant toggling between sketchy ink and architectural clean vectors, plus **Studio Vellum** (light) and **Midnight Blueprint** (dark) themes and SVG export.

## Running Locally

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` (or pass `-p <port>`) in your browser. To test P2P sync locally, click **Share P2P → Open Peer Tab** to launch a second connected tab in the same room.
