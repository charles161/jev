# Jev — Shared Intelligent Whiteboard

An Excalidraw-reimagined collaborative diagramming studio powered by **TypeSafe AI's Jev** (`POST https://api.typesafe.ai/v1/systemone`, `jev-latest` / `jev-1.14.0`) — a System One probabilistic decision model built to return calibrated typed decisions (`choice`, `noul`, `score`) in milliseconds without text generation.

## How TypeSafe Jev Powers the Canvas

- **Parallel System One Decisions on Every Move/Edit (`/api/jev/decide`)**: When you drag, edit, or add a node, Jev sends the compact canvas graph state plus parallel typed questions to `POST https://api.typesafe.ai/v1/systemone`:
  - `user_intent` (`choice`): classifies your drag gesture (`splice_into_edge`, `open_pipeline_gap`, `align_pipeline`, `branch_out`, `connect_nearby`, `decision_branch`, `extend_flow`).
  - `next_action` (`choice`): scores a pool of concrete next canvas actions and returns a **calibrated probability distribution** — we take the **Top 3** probabilities directly for `Tab` + `Enter` ghost previews.
  - `should_auto_connect` (`noul`): yes/no probability (`0..1`) on whether to wire an edge automatically.
- **Write to Draw Instantaneously (`/`)**: Press `/` and type natural language or arrow shorthand (`User -> Login -> Valid Token? -> [Yes: Dashboard, No: Retry] -> Postgres`). TypeSafe Jev's `choice` + `noul` primitives classify prose prompts into architectural patterns while the deterministic layout engine draws instantaneously.
- **Zero-Key Local Fallback**: If `TYPESAFE_API_KEY` is not set, the app runs seamlessly on a local calibrated fallback and upgrades automatically to live `jev-1.14.0` decisions once `TYPESAFE_API_KEY` is configured.
- **Peer-to-Peer WebRTC Collaboration**: Real `RTCPeerConnection` + `RTCDataChannel` sync with live cursors via a lightweight `/api/signal` relay, automatic same-origin `BroadcastChannel` multi-tab sync, and a zero-server manual SDP Offer/Answer handshake mode.

## Running Locally

```bash
pnpm install
pnpm dev
```

Set `TYPESAFE_API_KEY` in your local environment to enable live calls to `https://api.typesafe.ai/v1/systemone`. Without it, the whiteboard runs with the local fallback.
