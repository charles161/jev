import { PEER_COLORS } from "./colors";
import { JevElement, PeerCursor } from "./types";

export type CollabWireMessage =
  | {
      kind: "hello";
      peerId: string;
      name: string;
      color: string;
      ts: number;
    }
  | {
      kind: "cursor";
      peerId: string;
      name: string;
      color: string;
      x: number;
      y: number;
      selectedId?: string | null;
      ts: number;
    }
  | {
      kind: "sync_state";
      peerId: string;
      elements: JevElement[];
      boardTitle: string;
      ts: number;
    }
  | {
      kind: "request_sync";
      peerId: string;
      ts: number;
    }
  | {
      kind: "ping";
      peerId: string;
      sentAt: number;
    }
  | {
      kind: "pong";
      peerId: string;
      sentAt: number;
    };

export interface CollabCallbacks {
  onPeersChange: (peers: PeerCursor[]) => void;
  onRemoteState: (elements: JevElement[], boardTitle: string) => void;
  onGetLocalState: () => { elements: JevElement[]; boardTitle: string };
  onStatusChange: (status: {
    webrtcPeers: number;
    broadcastPeers: number;
    signalingActive: boolean;
  }) => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function encodeCompactJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeCompactJson<T>(code: string): T {
  const cleaned = code.trim();
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as T;
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs);
    const onState = () => {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onState);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

export class JevP2PCollab {
  readonly roomId: string;
  private readonly roomSecret: string;
  peerId: string;
  readonly name: string;
  readonly color: string;

  private callbacks: CollabCallbacks;
  private bc: BroadcastChannel | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private peers = new Map<string, PeerCursor>();
  private manualPc: RTCPeerConnection | null = null;
  private pollTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private signalCursor = 0;
  private peerToken: string | null = null;
  private serverEpoch: string | null = null;
  private pollInFlight = false;
  private signalingActive = false;
  private destroyed = false;

  constructor(
    roomId: string,
    roomSecret: string,
    peerName: string,
    callbacks: CollabCallbacks
  ) {
    this.roomId = roomId;
    this.roomSecret = roomSecret;
    this.peerId = `p_${Math.random().toString(36).slice(2, 14)}`;
    this.name = peerName;
    this.color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
    this.callbacks = callbacks;
  }

  start() {
    if (typeof window === "undefined") return;

    // 1. Instant same-origin multi-tab mesh via BroadcastChannel
    if ("BroadcastChannel" in window) {
      try {
        this.bc = new BroadcastChannel(`jev-room-${this.roomId}`);
        this.bc.onmessage = (ev) => {
          const msg = ev.data as CollabWireMessage;
          if (!msg || msg.peerId === this.peerId) return;
          this.handleWireMessage(msg, "broadcast");
        };
        this.bc.postMessage({
          kind: "hello",
          peerId: this.peerId,
          name: this.name,
          color: this.color,
          ts: Date.now(),
        } satisfies CollabWireMessage);
        this.bc.postMessage({
          kind: "request_sync",
          peerId: this.peerId,
          ts: Date.now(),
        } satisfies CollabWireMessage);
      } catch {
        this.bc = null;
      }
    }

    // 2. Real WebRTC P2P auto-mesh via authenticated /api/signal relay
    if ("RTCPeerConnection" in window) {
      this.signalingActive = true;
      void this.joinSignalingRoom();
      this.pollTimer = window.setInterval(() => {
        void this.pollSignals();
      }, 1500);
    }

    // 3. Peer liveness & RTT heartbeat
    this.heartbeatTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peers.entries()) {
        if (peer.transport !== "simulated" && now - peer.lastSeen > 12000) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this.emitPeers();

      // Ping open WebRTC DataChannels to measure real RTT
      for (const ch of this.channels.values()) {
        if (ch.readyState === "open") {
          try {
            ch.send(
              JSON.stringify({
                kind: "ping",
                peerId: this.peerId,
                sentAt: performance.now(),
              } satisfies CollabWireMessage)
            );
          } catch {
            // ignore transient send errors
          }
        }
      }
      this.bc?.postMessage({
        kind: "hello",
        peerId: this.peerId,
        name: this.name,
        color: this.color,
        ts: now,
      } satisfies CollabWireMessage);
    }, 3500);

    this.emitStatus();
  }

  destroy() {
    this.destroyed = true;
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    void this.postSignal({ type: "leave" });
    this.bc?.close();
    for (const ch of this.channels.values()) ch.close();
    for (const pc of this.pcs.values()) pc.close();
    this.manualPc?.close();
    this.channels.clear();
    this.pcs.clear();
    this.peers.clear();
  }

  broadcastCursor(x: number, y: number, selectedId?: string | null) {
    const msg: CollabWireMessage = {
      kind: "cursor",
      peerId: this.peerId,
      name: this.name,
      color: this.color,
      x,
      y,
      selectedId,
      ts: Date.now(),
    };
    this.sendToAll(msg);
  }

  broadcastState(elements: JevElement[], boardTitle: string) {
    const msg: CollabWireMessage = {
      kind: "sync_state",
      peerId: this.peerId,
      elements,
      boardTitle,
      ts: Date.now(),
    };
    this.sendToAll(msg);
  }

  private sendToAll(msg: CollabWireMessage) {
    try {
      this.bc?.postMessage(msg);
    } catch {
      // ignore closed channel
    }
    const serialized = JSON.stringify(msg);
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open") {
        try {
          ch.send(serialized);
        } catch {
          // ignore
        }
      }
    }
  }

  private handleWireMessage(
    msg: CollabWireMessage,
    transport: "webrtc" | "broadcast"
  ) {
    const now = Date.now();
    if (msg.kind === "hello") {
      const existing = this.peers.get(msg.peerId);
      this.peers.set(msg.peerId, {
        peerId: msg.peerId,
        name: msg.name,
        color: msg.color,
        x: existing?.x ?? 260,
        y: existing?.y ?? 200,
        selectedId: existing?.selectedId ?? null,
        transport: existing?.transport === "webrtc" ? "webrtc" : transport,
        lastSeen: now,
        rttMs: existing?.rttMs,
      });
      this.emitPeers();
      return;
    }

    if (msg.kind === "cursor") {
      const existing = this.peers.get(msg.peerId);
      this.peers.set(msg.peerId, {
        peerId: msg.peerId,
        name: msg.name,
        color: msg.color,
        x: msg.x,
        y: msg.y,
        selectedId: msg.selectedId ?? null,
        transport: existing?.transport === "webrtc" ? "webrtc" : transport,
        lastSeen: now,
        rttMs: existing?.rttMs,
      });
      this.emitPeers();
      return;
    }

    if (msg.kind === "request_sync") {
      const state = this.callbacks.onGetLocalState();
      this.sendToAll({
        kind: "sync_state",
        peerId: this.peerId,
        elements: state.elements,
        boardTitle: state.boardTitle,
        ts: now,
      });
      return;
    }

    if (msg.kind === "sync_state") {
      this.callbacks.onRemoteState(msg.elements, msg.boardTitle);
      return;
    }

    if (msg.kind === "ping") {
      const ch = this.channels.get(msg.peerId);
      if (ch && ch.readyState === "open") {
        ch.send(
          JSON.stringify({
            kind: "pong",
            peerId: this.peerId,
            sentAt: msg.sentAt,
          } satisfies CollabWireMessage)
        );
      }
      return;
    }

    if (msg.kind === "pong") {
      const existing = this.peers.get(msg.peerId);
      if (existing) {
        existing.rttMs = Math.max(1, Math.round(performance.now() - msg.sentAt));
        existing.lastSeen = now;
        this.emitPeers();
      }
    }
  }

  private async joinSignalingRoom() {
    if (this.destroyed || !this.roomSecret) return;
    try {
      const res = await fetch("/api/signal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-room-secret": this.roomSecret,
        },
        body: JSON.stringify({
          room: this.roomId,
          type: "join",
          name: this.name,
          color: this.color,
        }),
      });
      if (!res.ok) {
        this.signalingActive = false;
        this.emitStatus();
        return;
      }
      const data = (await res.json()) as {
        seq?: number;
        peerId?: string;
        peerToken?: string;
        epoch?: string;
        roster?: Array<{ peerId: string; name?: string; color?: string }>;
      };
      if (data.peerId && data.peerToken) {
        this.peerId = data.peerId;
        this.peerToken = data.peerToken;
        this.serverEpoch = data.epoch ?? null;
        this.signalCursor = typeof data.seq === "number" ? data.seq : 0;
        this.signalingActive = true;
        this.emitStatus();

        for (const remote of data.roster ?? []) {
          if (remote.peerId !== this.peerId && this.peerId < remote.peerId) {
            void this.initiateWebRTC(remote.peerId);
          }
        }
      }
    } catch {
      this.signalingActive = false;
      this.emitStatus();
    }
  }

  private async postSignal(data: {
    type: "offer" | "answer" | "ice" | "leave";
    to?: string;
    payload?: unknown;
  }) {
    if (this.destroyed && data.type !== "leave") return;
    if (!this.roomSecret || !this.peerToken) return;
    try {
      await fetch("/api/signal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-room-secret": this.roomSecret,
          "x-peer-token": this.peerToken,
        },
        body: JSON.stringify({
          room: this.roomId,
          from: this.peerId,
          ...data,
        }),
      });
    } catch {
      this.signalingActive = false;
      this.emitStatus();
    }
  }

  private async pollSignals() {
    if (this.destroyed || this.pollInFlight) return;
    if (!this.roomSecret || !this.peerToken) return;
    this.pollInFlight = true;
    try {
      const res = await fetch(
        `/api/signal?room=${encodeURIComponent(this.roomId)}&since=${this.signalCursor}`,
        {
          headers: {
            "x-room-secret": this.roomSecret,
            "x-peer-token": this.peerToken,
          },
        }
      );
      if (res.status === 404) {
        // Server restarted or room expired — reset cursor and rejoin
        this.signalCursor = 0;
        this.peerToken = null;
        this.serverEpoch = null;
        await this.joinSignalingRoom();
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as {
        cursor: number;
        epoch?: string;
        roster?: Array<{ peerId: string; name?: string; color?: string }>;
        messages: Array<{
          from: string;
          type: "join" | "offer" | "answer" | "ice" | "leave";
          payload?: unknown;
          name?: string;
          color?: string;
        }>;
      };
      if (data.epoch && this.serverEpoch && data.epoch !== this.serverEpoch) {
        this.serverEpoch = data.epoch;
        this.signalCursor = 0;
      }
      this.signalCursor = Math.max(this.signalCursor, data.cursor ?? 0);

      for (const m of data.messages ?? []) {
        if (m.type === "join") {
          // Deterministic initiator avoids WebRTC offer glare
          if (this.peerId < m.from) {
            await this.initiateWebRTC(m.from);
          }
        } else if (m.type === "offer" && m.payload) {
          await this.handleOffer(
            m.from,
            m.payload as RTCSessionDescriptionInit
          );
        } else if (m.type === "answer" && m.payload) {
          const pc = this.pcs.get(m.from);
          if (pc && pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(
              new RTCSessionDescription(m.payload as RTCSessionDescriptionInit)
            );
          }
        } else if (m.type === "ice" && m.payload) {
          const pc = this.pcs.get(m.from);
          if (pc) {
            try {
              await pc.addIceCandidate(
                new RTCIceCandidate(m.payload as RTCIceCandidateInit)
              );
            } catch {
              // ignore out-of-order ICE
            }
          }
        } else if (m.type === "leave") {
          this.cleanupPeer(m.from);
        }
      }
    } catch {
      // silent retry on transient network hiccup
    } finally {
      this.pollInFlight = false;
    }
  }

  private createPeerConnection(remoteId: string): RTCPeerConnection {
    const existing = this.pcs.get(remoteId);
    if (existing) existing.close();

    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.pcs.set(remoteId, pc);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        void this.postSignal({
          type: "ice",
          to: remoteId,
          payload: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        this.cleanupPeer(remoteId);
      }
      this.emitStatus();
    };

    pc.ondatachannel = (ev) => {
      this.attachDataChannel(remoteId, ev.channel);
    };

    return pc;
  }

  private attachDataChannel(remoteId: string, ch: RTCDataChannel) {
    this.channels.set(remoteId, ch);

    ch.onopen = () => {
      ch.send(
        JSON.stringify({
          kind: "hello",
          peerId: this.peerId,
          name: this.name,
          color: this.color,
          ts: Date.now(),
        } satisfies CollabWireMessage)
      );
      const local = this.callbacks.onGetLocalState();
      ch.send(
        JSON.stringify({
          kind: "sync_state",
          peerId: this.peerId,
          elements: local.elements,
          boardTitle: local.boardTitle,
          ts: Date.now(),
        } satisfies CollabWireMessage)
      );
      this.emitStatus();
    };

    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as CollabWireMessage;
        this.handleWireMessage(msg, "webrtc");
      } catch {
        // ignore malformed packets
      }
    };

    ch.onclose = () => {
      this.channels.delete(remoteId);
      this.emitStatus();
    };
  }

  private async initiateWebRTC(remoteId: string) {
    const pc = this.createPeerConnection(remoteId);
    const ch = pc.createDataChannel("jev-sync", { ordered: true });
    this.attachDataChannel(remoteId, ch);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.postSignal({
      type: "offer",
      to: remoteId,
      payload: offer,
    });
  }

  private async handleOffer(
    remoteId: string,
    offer: RTCSessionDescriptionInit
  ) {
    const pc = this.createPeerConnection(remoteId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.postSignal({
      type: "answer",
      to: remoteId,
      payload: answer,
    });
  }

  private cleanupPeer(remoteId: string) {
    this.channels.get(remoteId)?.close();
    this.channels.delete(remoteId);
    this.pcs.get(remoteId)?.close();
    this.pcs.delete(remoteId);
    this.peers.delete(remoteId);
    this.emitPeers();
    this.emitStatus();
  }

  // --- ZERO-SERVER MANUAL WEBRTC HANDSHAKE (Copy Offer -> Paste Answer) ---

  async createManualOfferCode(): Promise<string> {
    this.manualPc?.close();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.manualPc = pc;
    const remoteId = `manual_${Math.random().toString(36).slice(2, 7)}`;
    const ch = pc.createDataChannel("jev-manual-sync", { ordered: true });
    this.attachDataChannel(remoteId, ch);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    return encodeCompactJson({
      v: 1,
      from: this.peerId,
      name: this.name,
      sdp: pc.localDescription,
    });
  }

  async acceptManualOfferAndCreateAnswer(offerCode: string): Promise<string> {
    const parsed = decodeCompactJson<{
      v: number;
      from: string;
      name: string;
      sdp: RTCSessionDescriptionInit;
    }>(offerCode);

    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.pcs.set(parsed.from, pc);
    pc.ondatachannel = (ev) => {
      this.attachDataChannel(parsed.from, ev.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(parsed.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);

    return encodeCompactJson({
      v: 1,
      from: this.peerId,
      name: this.name,
      sdp: pc.localDescription,
    });
  }

  async completeManualAnswer(answerCode: string): Promise<void> {
    if (!this.manualPc) {
      throw new Error("Generate an offer first before pasting an answer.");
    }
    const parsed = decodeCompactJson<{
      v: number;
      from: string;
      name: string;
      sdp: RTCSessionDescriptionInit;
    }>(answerCode);
    await this.manualPc.setRemoteDescription(
      new RTCSessionDescription(parsed.sdp)
    );
  }

  private emitPeers() {
    this.callbacks.onPeersChange(Array.from(this.peers.values()));
    this.emitStatus();
  }

  private emitStatus() {
    let webrtcPeers = 0;
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open") webrtcPeers++;
    }
    const broadcastPeers = Array.from(this.peers.values()).filter(
      (p) => p.transport === "broadcast"
    ).length;
    this.callbacks.onStatusChange({
      webrtcPeers,
      broadcastPeers,
      signalingActive: this.signalingActive,
    });
  }
}
