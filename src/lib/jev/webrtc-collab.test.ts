import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStarterElements } from "@/lib/jev/templates";
import type { JevElement } from "@/lib/jev/types";
import {
  computeBackoffDelayMs,
  JevP2PCollab,
  parseRetryAfterMs,
} from "@/lib/jev/webrtc-collab";

class MockRTCDataChannel {
  label: string;
  readyState: RTCDataChannelState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(label: string) {
    this.label = label;
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = "open";
    this.onopen?.();
  }

  deliver(data: string) {
    this.onmessage?.({ data });
  }

  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];

  config: RTCConfiguration;
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null =
    null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: MockRTCDataChannel }) => void) | null = null;

  channels: MockRTCDataChannel[] = [];
  addedIceCandidates: RTCIceCandidateInit[] = [];
  setRemoteDescriptionDelayMs = 0;

  constructor(config: RTCConfiguration = {}) {
    this.config = config;
    MockRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string) {
    const ch = new MockRTCDataChannel(label);
    this.channels.push(ch);
    return ch as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return {
      type: "offer",
      sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n",
    };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return {
      type: "answer",
      sdp: "v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\ns=-\r\n",
    };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
    this.signalingState =
      desc.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    if (this.setRemoteDescriptionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.setRemoteDescriptionDelayMs));
    }
    this.remoteDescription = desc;
    this.signalingState =
      desc.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.remoteDescription) {
      throw new Error("InvalidStateError: remoteDescription not set");
    }
    this.addedIceCandidates.push(candidate);
  }

  close() {
    this.connectionState = "closed";
  }
}

class MockRTCSessionDescription {
  type: RTCSdpType;
  sdp?: string;
  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

class MockRTCIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? "";
    this.sdpMid = init.sdpMid;
    this.sdpMLineIndex = init.sdpMLineIndex;
  }
  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
    };
  }
}

const VALID_ROOM = "room_AbCdEfGhIjKlMnOpQrStUvWx";
const VALID_SECRET = "secr_0123456789abcdefABCDEF0123456789";

function makeElement(id: string, label: string): JevElement {
  return {
    id,
    kind: "node",
    x: 120,
    y: 120,
    width: 160,
    height: 70,
    label,
    tone: "cobalt",
    seed: 42,
    createdAt: 1700000005000,
    updatedAt: 1700000005000,
    rev: 1,
  };
}

describe("Blockers 3, 4 & 5 (client): JevP2PCollab handshake, roster, ICE buffering, epoch & ICE config", () => {
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const origRTCPC = globalThis.RTCPeerConnection;
  const origRTCSD = globalThis.RTCSessionDescription;
  const origRTCIC = globalThis.RTCIceCandidate;

  beforeEach(() => {
    MockRTCPeerConnection.instances = [];
    // Minimal browser-like globals for JevP2PCollab in node Vitest environment
    const fakeWindow = {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      RTCPeerConnection: MockRTCPeerConnection,
    };
    Object.defineProperty(globalThis, "window", {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: MockRTCPeerConnection,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "RTCSessionDescription", {
      value: MockRTCSessionDescription,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "RTCIceCandidate", {
      value: MockRTCIceCandidate,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: origWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "fetch", {
      value: origFetch,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: origRTCPC,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "RTCSessionDescription", {
      value: origRTCSD,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "RTCIceCandidate", {
      value: origRTCIC,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("Blocker 3: fresh joiner sends request_sync on DataChannel open (never sync_state) and adopts host board without wiping host", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({
            iceServers: [{ urls: "stun:stun.example.org:3478" }],
          }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string; name?: string };
        if (body.type === "join") {
          const isHost = body.name === "Host";
          return new Response(
            JSON.stringify({
              ok: true,
              seq: isHost ? 1 : 2,
              peerId: isHost ? "p_aaaa_host_1234" : "p_zzzz_join_5678",
              peerToken: isHost
                ? "tok_host_0123456789abcdef012345"
                : "tok_join_0123456789abcdef012345",
              epoch: "epoch_1",
              roster: isHost
                ? [{ peerId: "p_aaaa_host_1234", name: "Host", joinedAt: 1000 }]
                : [
                    { peerId: "p_aaaa_host_1234", name: "Host", joinedAt: 1000 },
                    { peerId: "p_zzzz_join_5678", name: "Joiner", joinedAt: 2000 },
                  ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 3, epoch: "epoch_1" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ messages: [], cursor: 2, epoch: "epoch_1", roster: [] }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const hostBoard = [makeElement("host_only", "Host Diagram")];
    const hostOnRemote = vi.fn();
    const joinerOnRemote = vi.fn();

    const host = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Host", {
      onPeersChange: vi.fn(),
      onRemoteState: hostOnRemote,
      onGetLocalState: () => ({
        elements: hostBoard,
        boardTitle: "Host Board",
        hasLocalEdits: true,
        titleUpdatedAt: 5000,
        tombstones: {},
      }),
      onStatusChange: vi.fn(),
    });

    const joiner = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Joiner", {
      onPeersChange: vi.fn(),
      onRemoteState: joinerOnRemote,
      onGetLocalState: () => ({
        elements: createStarterElements(),
        boardTitle: "System Sketch",
        hasLocalEdits: false,
        titleUpdatedAt: 0,
        tombstones: {},
      }),
      onStatusChange: vi.fn(),
    });

    host.start();
    joiner.start();
    await new Promise((r) => setTimeout(r, 20));

    // Simulate an opened DataChannel pair between host and joiner
    const hostCh = new MockRTCDataChannel("jev-sync");
    const joinerCh = new MockRTCDataChannel("jev-sync");

    // Wire attachDataChannel via internal access or simulated ondatachannel
    const hostPc = new MockRTCPeerConnection();
    const joinerPc = new MockRTCPeerConnection();
    void hostPc;
    void joinerPc;

    // Trigger DataChannel attach on both sides via public/internal hook
    (host as unknown as { attachDataChannel: (id: string, ch: RTCDataChannel) => void }).attachDataChannel(
      "p_zzzz_join_5678",
      hostCh as unknown as RTCDataChannel
    );
    (joiner as unknown as { attachDataChannel: (id: string, ch: RTCDataChannel) => void }).attachDataChannel(
      "p_aaaa_host_1234",
      joinerCh as unknown as RTCDataChannel
    );

    joinerCh.open();
    hostCh.open();

    const joinerSentKinds = joinerCh.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind
    );
    const hostSentKinds = hostCh.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind
    );

    // Joiner MUST send request_sync and NEVER send sync_state on open!
    expect(joinerSentKinds).toContain("request_sync");
    expect(joinerSentKinds).not.toContain("sync_state");

    // Host sends authoritative sync_state
    expect(hostSentKinds).toContain("sync_state");

    // Deliver all joiner messages to host and host messages to joiner
    for (const raw of joinerCh.sent) hostCh.deliver(raw);
    for (const raw of hostCh.sent) joinerCh.deliver(raw);

    // Host must NEVER have its board overwritten by joiner
    expect(hostOnRemote).not.toHaveBeenCalled();

    // Joiner adopts host's board
    expect(joinerOnRemote).toHaveBeenCalled();
    const [adoptedElements, adoptedTitle] = joinerOnRemote.mock.calls[0];
    expect((adoptedElements as JevElement[]).map((e) => e.id)).toEqual([
      "host_only",
    ]);
    expect(adoptedTitle).toBe("Host Board");

    // Malformed DataChannel packet is dropped safely without throwing or calling onRemoteState
    hostOnRemote.mockClear();
    hostCh.deliver(
      JSON.stringify({
        kind: "sync_state",
        peerId: "p_zzzz_join_5678",
        boardTitle: "Evil",
        ts: Date.now(),
        elements: [{ ...makeElement("bad_1", "Bad"), tone: "corrupt-tone" }],
      })
    );
    expect(hostOnRemote).not.toHaveBeenCalled();

    host.destroy();
    joiner.destroy();
  });

  it("Blocker 5: connects to peers from poll roster even if join message was evicted, and does not tear down active connections", async () => {
    let pollCount = 0;
    const postedSignals: Array<{ type: string; to?: string }> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({
            iceServers: [
              {
                urls: "turn:turn.example.org:3478",
                username: "u",
                credential: "p",
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string; to?: string };
        postedSignals.push(body);
        if (body.type === "join") {
          return new Response(
            JSON.stringify({
              ok: true,
              seq: 1,
              peerId: "p_0001_local_peer",
              peerToken: "tok_local_0123456789abcdef0123",
              epoch: "epoch_a",
              roster: [{ peerId: "p_0001_local_peer", joinedAt: 1000 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 2, epoch: "epoch_a" }), {
          status: 200,
        });
      }
      // GET /api/signal poll: return Peer B ONLY in roster (join message evicted from ring buffer!)
      pollCount += 1;
      return new Response(
        JSON.stringify({
          cursor: 10 + pollCount,
          epoch: "epoch_a",
          roster: [
            { peerId: "p_0001_local_peer", joinedAt: 1000 },
            { peerId: "p_9999_remote_peer", joinedAt: 2000 },
          ],
          messages: [],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Alpha", {
      onPeersChange: vi.fn(),
      onRemoteState: vi.fn(),
      onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 30));

    // Trigger two consecutive polls directly
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();

    // Should have initiated exactly ONE offer to p_9999_remote_peer from the poll roster
    const offers = postedSignals.filter(
      (s) => s.type === "offer" && s.to === "p_9999_remote_peer"
    );
    expect(offers).toHaveLength(1);

    // And the created RTCPeerConnection should have used the /api/ice-config TURN servers
    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(MockRTCPeerConnection.instances[0].config.iceServers).toEqual([
      {
        urls: "turn:turn.example.org:3478",
        username: "u",
        credential: "p",
      },
    ]);

    collab.destroy();
  });

  it("Blocker 5: buffers incoming ICE candidates until setRemoteDescription completes and flushes them in order", async () => {
    let pollStep = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string };
        if (body.type === "join") {
          return new Response(
            JSON.stringify({
              ok: true,
              seq: 1,
              peerId: "p_zzzz_answerer_1",
              peerToken: "tok_ans_0123456789abcdef012345",
              epoch: "epoch_ice",
              roster: [
                { peerId: "p_aaaa_offerer_1", joinedAt: 1000 },
                { peerId: "p_zzzz_answerer_1", joinedAt: 2000 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 5, epoch: "epoch_ice" }), {
          status: 200,
        });
      }

      pollStep += 1;
      if (pollStep === 1) {
        // ICE candidate 1 & 2 arrive BEFORE the offer!
        return new Response(
          JSON.stringify({
            cursor: 3,
            epoch: "epoch_ice",
            roster: [
              { peerId: "p_aaaa_offerer_1", joinedAt: 1000 },
              { peerId: "p_zzzz_answerer_1", joinedAt: 2000 },
            ],
            messages: [
              {
                seq: 2,
                from: "p_aaaa_offerer_1",
                type: "ice",
                payload: { candidate: "candidate:1 1 udp 1 1.1.1.1 5000 typ host" },
              },
              {
                seq: 3,
                from: "p_aaaa_offerer_1",
                type: "ice",
                payload: { candidate: "candidate:2 1 udp 1 1.1.1.1 5001 typ host" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          cursor: 4,
          epoch: "epoch_ice",
          roster: [
            { peerId: "p_aaaa_offerer_1", joinedAt: 1000 },
            { peerId: "p_zzzz_answerer_1", joinedAt: 2000 },
          ],
          messages: [
            {
              seq: 4,
              from: "p_aaaa_offerer_1",
              type: "offer",
              payload: {
                type: "offer",
                sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n",
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Answerer", {
      onPeersChange: vi.fn(),
      onRemoteState: vi.fn(),
      onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 20));

    // Poll 1: receives 2 ICE candidates before offer
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    // Poll 2: receives offer -> sets remote description -> flushes buffered ICE candidates in order!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    const pc = MockRTCPeerConnection.instances[0];
    expect(pc.addedIceCandidates.map((c) => c.candidate)).toEqual([
      "candidate:1 1 udp 1 1.1.1.1 5000 typ host",
      "candidate:2 1 udp 1 1.1.1.1 5001 typ host",
    ]);

    collab.destroy();
  });

  it("Blocker 5: resets cursor on server epoch change and prevents overlapping polls", async () => {
    const requestedSince: string[] = [];
    let releaseFirstPoll: (() => void) | null = null;
    let pollIdx = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            seq: 50,
            peerId: "p_epoch_peer_1234",
            peerToken: "tok_ep_0123456789abcdef0123456",
            epoch: "epoch_old",
            roster: [{ peerId: "p_epoch_peer_1234", joinedAt: 1000 }],
          }),
          { status: 200 }
        );
      }

      const parsedUrl = new URL(url, "http://localhost");
      requestedSince.push(parsedUrl.searchParams.get("since") ?? "");
      pollIdx += 1;

      if (pollIdx === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPoll = resolve;
        });
        // Server epoch changed and cursor restarted at 3!
        return new Response(
          JSON.stringify({
            cursor: 3,
            epoch: "epoch_new",
            roster: [{ peerId: "p_epoch_peer_1234", joinedAt: 1000 }],
            messages: [],
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          cursor: 4,
          epoch: "epoch_new",
          roster: [{ peerId: "p_epoch_peer_1234", joinedAt: 1000 }],
          messages: [],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "EpochPeer", {
      onPeersChange: vi.fn(),
      onRemoteState: vi.fn(),
      onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 20));

    // Fire two overlapping pollSignals calls while first is still in flight
    const p1 = (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    const p2 = (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    await p2; // Should return immediately because p1 is in-flight!
    expect(requestedSince).toEqual(["50"]);

    releaseFirstPoll!();
    await p1;

    // Next poll must use the reset cursor "3" from the new epoch (NOT stuck at "50")!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(requestedSince).toEqual(["50", "3"]);

    collab.destroy();
  });

  it("Blocker 4 & 5: drops malformed BroadcastChannel payloads and buffers offerer ICE candidates until answer setRemoteDescription completes", async () => {
    const channels: Array<{
      name: string;
      onmessage: ((ev: { data: unknown }) => void) | null;
      postMessage: (data: unknown) => void;
      close: () => void;
    }> = [];

    class MockBroadcastChannel {
      name: string;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      posted: unknown[] = [];
      constructor(name: string) {
        this.name = name;
        channels.push(this);
      }
      postMessage(data: unknown) {
        this.posted.push(data);
      }
      close() {}
    }

    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: MockBroadcastChannel,
      configurable: true,
      writable: true,
    });
    (globalThis.window as unknown as Record<string, unknown>).BroadcastChannel =
      MockBroadcastChannel;

    let pollStep = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response("server error", { status: 500 });
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string };
        if (body.type === "join") {
          return new Response(
            JSON.stringify({
              ok: true,
              seq: 1,
              peerId: "p_0001_offerer_bc",
              peerToken: "tok_off_0123456789abcdef012345",
              epoch: "epoch_bc",
              roster: [
                { peerId: "p_0001_offerer_bc", joinedAt: 1000 },
                { peerId: "p_9999_ans_bc", joinedAt: 2000 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 2, epoch: "epoch_bc" }), {
          status: 200,
        });
      }

      pollStep += 1;
      if (pollStep === 1) {
        // Early ICE candidate arrives BEFORE answer
        return new Response(
          JSON.stringify({
            cursor: 3,
            epoch: "epoch_bc",
            roster: [
              { peerId: "p_0001_offerer_bc", joinedAt: 1000 },
              { peerId: "p_9999_ans_bc", joinedAt: 2000 },
            ],
            messages: [
              {
                seq: 3,
                from: "p_9999_ans_bc",
                type: "ice",
                payload: { candidate: "candidate:early 1 udp 1 2.2.2.2 6000 typ srflx" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          cursor: 4,
          epoch: "epoch_bc",
          roster: [
            { peerId: "p_0001_offerer_bc", joinedAt: 1000 },
            { peerId: "p_9999_ans_bc", joinedAt: 2000 },
          ],
          messages: [
            {
              seq: 4,
              from: "p_9999_ans_bc",
              type: "answer",
              payload: {
                type: "answer",
                sdp: "v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\ns=-\r\n",
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onRemoteState = vi.fn();
    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Offerer", {
      onPeersChange: vi.fn(),
      onRemoteState,
      onGetLocalState: () => ({
        elements: [makeElement("el_1", "Keep")],
        boardTitle: "Host",
        hasLocalEdits: true,
      }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 30));

    // Malformed BroadcastChannel message with bad tone is dropped safely
    expect(channels).toHaveLength(1);
    channels[0].onmessage?.({
      data: {
        kind: "sync_state",
        peerId: "p_9999_ans_bc",
        boardTitle: "Evil",
        ts: Date.now(),
        elements: [{ ...makeElement("el_bad", "Bad"), tone: "invalid-tone" }],
      },
    });
    expect(onRemoteState).not.toHaveBeenCalled();

    // Poll 1 delivers ICE before answer; Poll 2 delivers answer -> ICE flushes cleanly
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(MockRTCPeerConnection.instances[0].addedIceCandidates).toHaveLength(0);

    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(
      MockRTCPeerConnection.instances[0].addedIceCandidates.map((c) => c.candidate)
    ).toEqual(["candidate:early 1 udp 1 2.2.2.2 6000 typ srflx"]);

    // Also verifies /api/ice-config 500 fell back safely to default Google STUN
    expect(MockRTCPeerConnection.instances[0].config.iceServers?.length).toBeGreaterThanOrEqual(
      1
    );

    collab.destroy();
    delete (globalThis as unknown as Record<string, unknown>).BroadcastChannel;
  });

  it("Review (b): recovers automatically when pruned (403 peer_expired) or server restarted (404), but never spins on invalid_room_secret", async () => {
    let joinCalls = 0;
    let pollCalls = 0;
    const requestedSince: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string };
        if (body.type === "join") {
          joinCalls += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              seq: joinCalls === 1 ? 15 : 2,
              peerId: `p_rejoin_peer_${joinCalls}`,
              peerToken: `tok_rejoin_${joinCalls}_0123456789abcdef`,
              epoch: joinCalls === 3 ? "epoch_restarted" : "epoch_initial",
              roster: [
                { peerId: "p_0001_existing_host", joinedAt: 1000 },
                { peerId: `p_rejoin_peer_${joinCalls}`, joinedAt: 2000 + joinCalls },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 16, epoch: "epoch_initial" }), {
          status: 200,
        });
      }

      const parsedUrl = new URL(url, "http://localhost");
      requestedSince.push(parsedUrl.searchParams.get("since") ?? "");
      pollCalls += 1;

      if (pollCalls === 1) {
        // Peer was pruned after 45s inactivity -> 403 peer_expired
        return new Response(
          JSON.stringify({
            error: "Peer session expired",
            code: "peer_expired",
            epoch: "epoch_initial",
          }),
          { status: 403 }
        );
      }
      if (pollCalls === 2) {
        // Server restarted -> 404 room_not_found
        return new Response(
          JSON.stringify({
            error: "Room session not found",
            code: "room_not_found",
            epoch: "epoch_restarted",
          }),
          { status: 404 }
        );
      }
      // 3rd poll hits invalid_room_secret -> must stop cleanly without rejoining!
      return new Response(
        JSON.stringify({
          error: "Invalid room secret",
          code: "invalid_room_secret",
        }),
        { status: 403 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Sleeper", {
      onPeersChange: vi.fn(),
      onRemoteState: vi.fn(),
      onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(joinCalls).toBe(1);
    expect(collab.peerId).toBe("p_rejoin_peer_1");

    // Poll 1: receives 403 peer_expired -> automatically rejoins with new peerId & reset cursor!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(joinCalls).toBe(2);
    expect(collab.peerId).toBe("p_rejoin_peer_2");

    // Poll 2: receives 404 room_not_found -> automatically rejoins again!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(joinCalls).toBe(3);
    expect(collab.peerId).toBe("p_rejoin_peer_3");
    expect(requestedSince).toEqual(["15", "2"]);

    // Poll 3: receives 403 invalid_room_secret -> does NOT rejoin or spin!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(joinCalls).toBe(3);

    // Subsequent poll call is a no-op once permanently auth-failed
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(pollCalls).toBe(3);

    collab.destroy();
  });

  it("Fix 2: fetches /api/ice-config AFTER joining /api/signal, passing room query + x-room-secret + x-peer-token", async () => {
    const callOrder: string[] = [];
    let iceConfigUrl = "";
    let iceConfigHeaders: Record<string, string> = {};

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string };
        if (body.type === "join") {
          callOrder.push("signal_join");
          return new Response(
            JSON.stringify({
              ok: true,
              seq: 1,
              peerId: "p_0001_ice_auth",
              peerToken: "tok_ice_auth_0123456789abcdef",
              epoch: "epoch_ice_auth",
              roster: [
                { peerId: "p_0001_ice_auth", joinedAt: 1000 },
                { peerId: "p_9999_ice_peer", joinedAt: 2000 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 2, epoch: "epoch_ice_auth" }), {
          status: 200,
        });
      }
      if (url.startsWith("/api/ice-config")) {
        callOrder.push("ice_config");
        iceConfigUrl = url;
        iceConfigHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response(
          JSON.stringify({
            iceServers: [
              {
                urls: "turns:turn.example.org:5349",
                username: "1900000000:p_0001_ice_auth",
                credential: "hmac-cred-abc",
              },
            ],
            hasTurn: true,
            ttlSeconds: 600,
            expiresAt: 1900000000,
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ messages: [], cursor: 1, epoch: "epoch_ice_auth", roster: [] }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "IceAuthPeer", {
      onPeersChange: vi.fn(),
      onRemoteState: vi.fn(),
      onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 30));

    expect(callOrder[0]).toBe("signal_join");
    expect(callOrder).toContain("ice_config");
    expect(iceConfigUrl).toBe(`/api/ice-config?room=${encodeURIComponent(VALID_ROOM)}`);
    expect(iceConfigHeaders["x-room-secret"]).toBe(VALID_SECRET);
    expect(iceConfigHeaders["x-peer-token"]).toBe("tok_ice_auth_0123456789abcdef");

    collab.destroy();
  });

  it("Fix 3 (transport): binds DataChannel messages to verified remotePeerId and ignores self-declared authoritative: true", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            seq: 1,
            peerId: "p_honest_host_1",
            peerToken: "tok_honest_0123456789abcdef0123",
            epoch: "epoch_trust",
            roster: [
              { peerId: "p_honest_host_1", joinedAt: 1000 },
              { peerId: "p_aaa_mallory_2", joinedAt: 2000 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ messages: [], cursor: 1, epoch: "epoch_trust", roster: [] }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onRemoteState = vi.fn();
    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "Honest", {
      onPeersChange: vi.fn(),
      onRemoteState,
      onGetLocalState: () => ({
        elements: [makeElement("el_1", "Host")],
        boardTitle: "Host Board",
        hasLocalEdits: true,
        titleRev: 2,
        tombstones: {},
      }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 20));

    const ch = new MockRTCDataChannel("jev-sync");
    (collab as unknown as { attachDataChannel: (id: string, ch: RTCDataChannel) => void }).attachDataChannel(
      "p_aaa_mallory_2",
      ch as unknown as RTCDataChannel
    );
    ch.open();

    // Mallory sends sync_state spoofing peerId="p_zzz_spoof" and authoritative=true
    ch.deliver(
      JSON.stringify({
        kind: "sync_state",
        peerId: "p_zzz_spoof",
        boardTitle: "Spoofed",
        ts: Date.now(),
        hasLocalEdits: true,
        authoritative: true,
        elements: [makeElement("el_1", "Mallory")],
      })
    );

    expect(onRemoteState).toHaveBeenCalledTimes(1);
    const meta = onRemoteState.mock.calls[0][2] as {
      senderPeerId: string;
      verifiedSenderPeerId?: string;
      authoritative?: boolean;
      authoritativePeerId?: string | null;
    };
    expect(meta.senderPeerId).toBe("p_aaa_mallory_2");
    expect(meta.verifiedSenderPeerId).toBe("p_aaa_mallory_2");
    expect(meta.authoritative).toBe(false);
    expect(meta.authoritativePeerId).toBe("p_honest_host_1");

    collab.destroy();
  });

  it("Fix 4 (transport): after server restart, fresh joiner who rejoined FIRST never becomes authoritative over edited peer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string; name?: string };
        if (body.type === "join") {
          const isFresh = body.name === "FreshFirst";
          return new Response(
            JSON.stringify({
              ok: true,
              seq: isFresh ? 1 : 2,
              peerId: isFresh ? "p_fresh_first_01" : "p_edited_second2",
              peerToken: isFresh
                ? "tok_fresh_0123456789abcdef01234"
                : "tok_edit_0123456789abcdef012345",
              epoch: "epoch_restarted_4",
              roster: [
                // Fresh peer rejoined FIRST (earlier joinedAt!)
                { peerId: "p_fresh_first_01", name: "FreshFirst", joinedAt: 1000 },
                // Edited peer rejoined SECOND (later joinedAt!)
                { peerId: "p_edited_second2", name: "EditedSecond", joinedAt: 2000 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, seq: 3, epoch: "epoch_restarted_4" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ messages: [], cursor: 2, epoch: "epoch_restarted_4", roster: [] }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const freshOnRemote = vi.fn();
    const editedOnRemote = vi.fn();

    const freshPeer = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "FreshFirst", {
      onPeersChange: vi.fn(),
      onRemoteState: freshOnRemote,
      onGetLocalState: () => ({
        elements: createStarterElements(),
        boardTitle: "System Sketch",
        hasLocalEdits: false,
        titleRev: 0,
        tombstones: {},
      }),
      onStatusChange: vi.fn(),
    });

    const editedPeer = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "EditedSecond", {
      onPeersChange: vi.fn(),
      onRemoteState: editedOnRemote,
      onGetLocalState: () => ({
        elements: [{ ...makeElement("el_real", "Edited Work"), rev: 7 }],
        boardTitle: "Edited Board",
        hasLocalEdits: true,
        titleRev: 3,
        tombstones: {},
      }),
      onStatusChange: vi.fn(),
    });

    freshPeer.start();
    editedPeer.start();
    await new Promise((r) => setTimeout(r, 30));

    const freshCh = new MockRTCDataChannel("jev-sync");
    const editedCh = new MockRTCDataChannel("jev-sync");
    (freshPeer as unknown as { attachDataChannel: (id: string, ch: RTCDataChannel) => void }).attachDataChannel(
      "p_edited_second2",
      freshCh as unknown as RTCDataChannel
    );
    (editedPeer as unknown as { attachDataChannel: (id: string, ch: RTCDataChannel) => void }).attachDataChannel(
      "p_fresh_first_01",
      editedCh as unknown as RTCDataChannel
    );

    freshCh.open();
    editedCh.open();

    // Fresh peer (despite earliest joinedAt=1000!) MUST NOT send sync_state on open!
    const freshSentKinds = freshCh.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind
    );
    expect(freshSentKinds).toContain("request_sync");
    expect(freshSentKinds).not.toContain("sync_state");

    // Edited peer (joinedAt=2000, contentRev=7) sends sync_state!
    const editedSentKinds = editedCh.sent.map(
      (raw) => (JSON.parse(raw) as { kind: string }).kind
    );
    expect(editedSentKinds).toContain("sync_state");

    // Exchange all messages
    for (const raw of freshCh.sent) editedCh.deliver(raw);
    for (const raw of editedCh.sent) freshCh.deliver(raw);

    // Edited peer is NOT overwritten; Fresh peer receives edited board
    expect(editedOnRemote).not.toHaveBeenCalled();
    expect(freshOnRemote).toHaveBeenCalled();
    expect((freshOnRemote.mock.calls[0][0] as JevElement[]).map((e) => e.id)).toEqual([
      "el_real",
    ]);

    freshPeer.destroy();
    editedPeer.destroy();
  });

  it("Fix 7: applies exponential backoff + jitter on 429/503/rejoin, honors Retry-After (seconds & HTTP-date), and resets on success", async () => {
    const now = 1_750_000_000_000;
    expect(parseRetryAfterMs("7", now)).toBe(7000);
    expect(
      parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now)
    ).toBe(12_000);
    expect(parseRetryAfterMs("invalid-header", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();

    // Exponential growth + cap at 30_000ms + jitter
    const d0 = computeBackoffDelayMs({ attempt: 0, baseMs: 1500, random: () => 0.5 });
    const d1 = computeBackoffDelayMs({ attempt: 1, baseMs: 1500, random: () => 0.5 });
    const d2 = computeBackoffDelayMs({ attempt: 2, baseMs: 1500, random: () => 0.5 });
    const dCap = computeBackoffDelayMs({ attempt: 10, baseMs: 1500, random: () => 1 });
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
    expect(dCap).toBeLessThanOrEqual(30_000);

    // Random jitter produces distinct values for different random draws
    const lowJitter = computeBackoffDelayMs({ attempt: 1, baseMs: 1500, random: () => 0 });
    const highJitter = computeBackoffDelayMs({ attempt: 1, baseMs: 1500, random: () => 1 });
    expect(highJitter).toBeGreaterThan(lowJitter);

    // Retry-After is strictly honored
    expect(
      computeBackoffDelayMs({
        attempt: 0,
        baseMs: 1500,
        retryAfterMs: 9000,
        random: () => 0,
      })
    ).toBeGreaterThanOrEqual(9000);

    // Integration: inspect delays scheduled by JevP2PCollab on 429 + Retry-After, 503, then 200 reset
    const scheduledDelays: number[] = [];
    const origSetTimeout = globalThis.window.setTimeout;
    (globalThis.window as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number
    ) => {
      scheduledDelays.push(ms ?? 0);
      return origSetTimeout(fn, 60_000);
    }) as unknown as typeof setTimeout;

    let pollStep = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            seq: 1,
            peerId: "p_backoff_peer_1",
            peerToken: "tok_backoff_0123456789abcdef01",
            epoch: "epoch_bo",
            roster: [{ peerId: "p_backoff_peer_1", joinedAt: 1000 }],
          }),
          { status: 200 }
        );
      }
      pollStep += 1;
      if (pollStep === 1) {
        return new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "Retry-After": "6" },
        });
      }
      if (pollStep === 2) {
        return new Response(JSON.stringify({ error: "Unavailable" }), {
          status: 503,
        });
      }
      return new Response(
        JSON.stringify({
          cursor: 2,
          epoch: "epoch_bo",
          roster: [{ peerId: "p_backoff_peer_1", joinedAt: 1000 }],
          messages: [],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(
      VALID_ROOM,
      VALID_SECRET,
      "BackoffPeer",
      {
        onPeersChange: vi.fn(),
        onRemoteState: vi.fn(),
        onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
        onStatusChange: vi.fn(),
      },
      { pollIntervalMs: 1500, random: () => 0.5 }
    );

    collab.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduledDelays.length = 0;

    // Poll 1: 429 with Retry-After: 6 -> scheduled delay >= 6000ms
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(scheduledDelays[0]).toBeGreaterThanOrEqual(6000);

    // Poll 2: 503 -> exponential backoff (> 1500ms)
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(scheduledDelays[1]).toBeGreaterThan(1500);

    // Poll 3: 200 OK -> resets backoff back to base 1500ms!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    expect(scheduledDelays[2]).toBe(1500);

    collab.destroy();
  });

  it("Fix 8: per-message try/catch in pollSignals ensures one throwing signal never drops remaining messages in the batch", async () => {
    const postedAnswers: Array<{ to?: string; type: string }> = [];

    // Make setRemoteDescription throw specifically for a bad SDP ("BAD_SDP")
    const origSetRemote = MockRTCPeerConnection.prototype.setRemoteDescription;
    vi.spyOn(
      MockRTCPeerConnection.prototype,
      "setRemoteDescription"
    ).mockImplementation(async function (
      this: MockRTCPeerConnection,
      desc: RTCSessionDescriptionInit
    ) {
      if (desc.sdp?.includes("BAD_SDP")) {
        throw new Error("InvalidStateError: bad remote SDP");
      }
      return origSetRemote.call(this, desc);
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string; to?: string };
        if (body.type === "join") {
          return new Response(
            JSON.stringify({
              ok: true,
              seq: 1,
              peerId: "p_zzzz_batch_rx",
              peerToken: "tok_batch_0123456789abcdef0123",
              epoch: "epoch_batch",
              roster: [{ peerId: "p_zzzz_batch_rx", joinedAt: 1000 }],
            }),
            { status: 200 }
          );
        }
        if (body.type === "answer") {
          postedAnswers.push({ type: body.type, to: body.to });
        }
        return new Response(JSON.stringify({ ok: true, seq: 10, epoch: "epoch_batch" }), {
          status: 200,
        });
      }

      // Single poll batch containing ONE throwing offer followed by ONE valid offer!
      return new Response(
        JSON.stringify({
          cursor: 5,
          epoch: "epoch_batch",
          roster: [
            { peerId: "p_zzzz_batch_rx", joinedAt: 1000 },
            { peerId: "p_aaaa_bad_offer", joinedAt: 1100 },
            { peerId: "p_bbbb_good_offer", joinedAt: 1200 },
          ],
          messages: [
            {
              seq: 2,
              from: "p_aaaa_bad_offer",
              type: "offer",
              payload: {
                type: "offer",
                sdp: "v=0\r\no=BAD_SDP 1 1 IN IP4 127.0.0.1\r\ns=-\r\n",
              },
            },
            {
              seq: 3,
              from: "p_bbbb_good_offer",
              type: "offer",
              payload: {
                type: "offer",
                sdp: "v=0\r\no=GOOD_SDP 1 1 IN IP4 127.0.0.1\r\ns=-\r\n",
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "BatchRx", {
      onPeersChange: vi.fn(),
      onRemoteState: vi.fn(),
      onGetLocalState: () => ({ elements: [], boardTitle: "Board" }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 20));

    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();

    // Even though message 1 threw in setRemoteDescription, message 2 MUST still have been processed!
    expect(postedAnswers).toEqual([
      { type: "answer", to: "p_bbbb_good_offer" },
    ]);

    collab.destroy();
  });

  it("JW-10 (transport): server-side authority ignores attacker's baseRev=1e9 fullResync wipe and falls back to earliest joinedAt if creator leaves", async () => {
    let pollStage = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ice-config")) {
        return new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
          { status: 200 }
        );
      }
      if (url === "/api/signal" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            seq: 1,
            peerId: "p_honest_member",
            peerToken: "tok_honest_member_0123456789abcd",
            epoch: "epoch_jw10",
            creatorPeerId: "p_room_creator",
            roster: [
              { peerId: "p_room_creator", joinedAt: 1000 },
              { peerId: "p_honest_member", joinedAt: 2000 },
              { peerId: "p_mallory_late", joinedAt: 3000 },
            ],
          }),
          { status: 200 }
        );
      }
      pollStage += 1;
      // On poll 1: p_room_creator has left! Only p_honest_member (2000) and p_mallory_late (3000) remain.
      return new Response(
        JSON.stringify({
          cursor: 2 + pollStage,
          epoch: "epoch_jw10",
          creatorPeerId: "p_room_creator",
          roster: [
            { peerId: "p_honest_member", joinedAt: 2000 },
            { peerId: "p_mallory_late", joinedAt: 3000 },
          ],
          messages: [],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onRemoteState = vi.fn();
    const collab = new JevP2PCollab(VALID_ROOM, VALID_SECRET, "HonestMember", {
      onPeersChange: vi.fn(),
      onRemoteState,
      onGetLocalState: () => ({
        elements: [
          makeElement("el_1", "One"),
          makeElement("el_2", "Two"),
          makeElement("el_3", "Three"),
          makeElement("el_4", "Four"),
        ],
        boardTitle: "Real Board",
        hasLocalEdits: true,
        titleRev: 1,
        tombstones: {},
      }),
      onStatusChange: vi.fn(),
    });

    collab.start();
    await new Promise((r) => setTimeout(r, 25));

    const ch = new MockRTCDataChannel("jev-sync");
    (
      collab as unknown as {
        attachDataChannel: (id: string, ch: RTCDataChannel) => void;
      }
    ).attachDataChannel("p_mallory_late", ch as unknown as RTCDataChannel);
    ch.open();

    // Mallory sends hello claiming huge contentRev + sync_state { baseRev: 1e9, fullResync: true, elements: [] }
    ch.deliver(
      JSON.stringify({
        kind: "hello",
        peerId: "p_mallory_late",
        name: "Mallory",
        color: "#D94E28",
        ts: Date.now(),
        hasLocalEdits: true,
        contentRev: 1_000_000_000,
      })
    );
    ch.deliver(
      JSON.stringify({
        kind: "sync_state",
        peerId: "p_mallory_late",
        boardTitle: "Wiped",
        ts: Date.now(),
        hasLocalEdits: true,
        baseRev: 1_000_000_000,
        contentRev: 1_000_000_000,
        fullResync: true,
        elements: [],
      })
    );

    expect(onRemoteState).toHaveBeenCalledTimes(1);
    const meta1 = onRemoteState.mock.calls[0][2] as {
      authoritativePeerId?: string | null;
      authoritative?: boolean;
    };
    // Creator is active in roster -> creator MUST be authoritative, NOT Mallory!
    expect(meta1.authoritativePeerId).toBe("p_room_creator");
    expect(meta1.authoritative).toBe(false);

    // Now creator leaves on next poll -> earliest joinedAt (p_honest_member at 2000) MUST become authoritative, NOT Mallory (3000)!
    await (collab as unknown as { pollSignals: () => Promise<void> }).pollSignals();
    onRemoteState.mockClear();
    ch.deliver(
      JSON.stringify({
        kind: "sync_state",
        peerId: "p_mallory_late",
        boardTitle: "Wiped Again",
        ts: Date.now(),
        hasLocalEdits: true,
        baseRev: 1_000_000_000,
        fullResync: true,
        elements: [],
      })
    );
    const meta2 = onRemoteState.mock.calls[0][2] as {
      authoritativePeerId?: string | null;
      authoritative?: boolean;
    };
    expect(meta2.authoritativePeerId).toBe("p_honest_member");
    expect(meta2.authoritative).toBe(false);

    collab.destroy();
  });
});
