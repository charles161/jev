import { PEER_COLORS } from "./colors";
import {
  parseManualSdpPayload,
  parseRawDataChannelMessage,
  parseWireMessage,
  ValidatedCollabWireMessage,
} from "./sync-validation";
import { JevElement, PeerCursor, TombstoneMap } from "./types";

export type CollabWireMessage = ValidatedCollabWireMessage;

export interface LocalBoardState {
  elements: JevElement[];
  boardTitle: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  hasLocalEdits?: boolean;
}

export interface RemoteStateMeta {
  senderPeerId: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  hasLocalEdits?: boolean;
  authoritative?: boolean;
}

export interface CollabCallbacks {
  onPeersChange: (peers: PeerCursor[]) => void;
  onRemoteState: (
    elements: JevElement[],
    boardTitle: string,
    meta?: RemoteStateMeta
  ) => void;
  onGetLocalState: () => LocalBoardState;
  onStatusChange: (status: {
    webrtcPeers: number;
    broadcastPeers: number;
    signalingActive: boolean;
  }) => void;
}

export interface JevP2PCollabOptions {
  isRoomCreator?: boolean;
  iceServers?: RTCIceServer[];
  pollIntervalMs?: number;
}

interface SignalRosterEntry {
  peerId: string;
  name?: string;
  color?: string;
  joinedAt?: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const ICE_URL_PATTERN = /^(stuns?|turns?):[^\s]{1,512}$/i;
const MAX_PENDING_ICE_PER_PEER = 100;

function isValidIceServer(entry: unknown): entry is RTCIceServer {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Record<string, unknown>;
  const urls = candidate.urls;
  const validUrls =
    (typeof urls === "string" && ICE_URL_PATTERN.test(urls)) ||
    (Array.isArray(urls) &&
      urls.length > 0 &&
      urls.length <= 8 &&
      urls.every((u) => typeof u === "string" && ICE_URL_PATTERN.test(u)));
  if (!validUrls) return false;
  if (
    candidate.username !== undefined &&
    typeof candidate.username !== "string"
  ) {
    return false;
  }
  if (
    candidate.credential !== undefined &&
    typeof candidate.credential !== "string"
  ) {
    return false;
  }
  return true;
}

function encodeCompactJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeCompactJson(code: string): unknown {
  const cleaned = code.trim();
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as unknown;
}

function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 2500
): Promise<void> {
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

function resolveRoomHostFromRoster(roster: SignalRosterEntry[]): string | null {
  if (roster.length === 0) return null;
  const sorted = [...roster].sort((a, b) => {
    const aTime = typeof a.joinedAt === "number" ? a.joinedAt : Number.MAX_SAFE_INTEGER;
    const bTime = typeof b.joinedAt === "number" ? b.joinedAt : Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });
  return sorted[0]?.peerId ?? null;
}

export class JevP2PCollab {
  readonly roomId: string;
  private readonly roomSecret: string;
  peerId: string;
  readonly name: string;
  readonly color: string;

  private callbacks: CollabCallbacks;
  private readonly isRoomCreator: boolean;
  private readonly pollIntervalMs: number;
  private bc: BroadcastChannel | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private peers = new Map<string, PeerCursor>();
  private pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private remoteDescriptionReady = new Set<string>();
  private initiatingPeers = new Set<string>();
  private manualPc: RTCPeerConnection | null = null;
  private pollTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private signalCursor = 0;
  private peerToken: string | null = null;
  private serverEpoch: string | null = null;
  private rosterHostPeerId: string | null = null;
  private pollInFlight = false;
  private signalingActive = false;
  private permanentAuthFailure = false;
  private started = false;
  private destroyed = false;
  private resolvedIceConfig: RTCConfiguration | null = null;
  private iceConfigPromise: Promise<RTCConfiguration> | null = null;

  constructor(
    roomId: string,
    roomSecret: string,
    peerName: string,
    callbacks: CollabCallbacks,
    options: JevP2PCollabOptions = {}
  ) {
    this.roomId = roomId;
    this.roomSecret = roomSecret;
    this.peerId = `p_${Math.random().toString(36).slice(2, 14)}`;
    this.name = peerName;
    this.color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
    this.callbacks = callbacks;
    this.isRoomCreator = options.isRoomCreator ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    if (options.iceServers && options.iceServers.length > 0) {
      this.resolvedIceConfig = { iceServers: options.iceServers };
    }
  }

  private isRoomHost(): boolean {
    if (this.rosterHostPeerId !== null) {
      return this.rosterHostPeerId === this.peerId;
    }
    return this.isRoomCreator;
  }

  private shouldPushSyncOnOpen(): boolean {
    if (this.isRoomHost()) return true;
    const local = this.callbacks.onGetLocalState();
    return local.hasLocalEdits === true;
  }

  private async getIceConfig(): Promise<RTCConfiguration> {
    if (this.resolvedIceConfig) return this.resolvedIceConfig;
    if (!this.iceConfigPromise) {
      this.iceConfigPromise = (async () => {
        try {
          const res = await fetch("/api/ice-config", {
            method: "GET",
            cache: "no-store",
          });
          if (res.ok) {
            const data = (await res.json()) as { iceServers?: unknown };
            if (Array.isArray(data.iceServers)) {
              const valid = data.iceServers.filter(isValidIceServer);
              if (valid.length > 0) {
                this.resolvedIceConfig = { iceServers: valid };
                return this.resolvedIceConfig;
              }
            }
          }
        } catch {
          // fall back to default STUN servers
        }
        this.resolvedIceConfig = { iceServers: DEFAULT_ICE_SERVERS };
        return this.resolvedIceConfig;
      })();
    }
    return this.iceConfigPromise;
  }

  start() {
    if (typeof window === "undefined" || this.started || this.destroyed) return;
    this.started = true;

    // 1. Instant same-origin multi-tab mesh via BroadcastChannel
    if ("BroadcastChannel" in window) {
      try {
        this.bc = new BroadcastChannel(`jev-room-${this.roomId}`);
        this.bc.onmessage = (ev) => {
          const msg = parseWireMessage(ev.data);
          if (!msg || msg.peerId === this.peerId) return;
          this.handleWireMessage(msg, "broadcast");
        };
        const local = this.callbacks.onGetLocalState();
        this.bc.postMessage({
          kind: "hello",
          peerId: this.peerId,
          name: this.name,
          color: this.color,
          ts: Date.now(),
          hasLocalEdits: Boolean(local.hasLocalEdits),
          isAuthoritative: this.isRoomHost(),
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
      void this.bootstrapSignaling();
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
      const local = this.callbacks.onGetLocalState();
      try {
        this.bc?.postMessage({
          kind: "hello",
          peerId: this.peerId,
          name: this.name,
          color: this.color,
          ts: now,
          hasLocalEdits: Boolean(local.hasLocalEdits),
          isAuthoritative: this.isRoomHost(),
        } satisfies CollabWireMessage);
      } catch {
        // ignore closed channel
      }
    }, 3500);

    this.emitStatus();
  }

  private async bootstrapSignaling() {
    await this.getIceConfig();
    if (this.destroyed) return;
    await this.joinSignalingRoom();
    if (!this.destroyed) {
      this.scheduleNextPoll();
    }
  }

  private scheduleNextPoll() {
    if (this.destroyed || !this.started || this.permanentAuthFailure) return;
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.pollSignals();
    }, this.pollIntervalMs);
  }

  destroy() {
    this.destroyed = true;
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    void this.postSignal({ type: "leave" });
    this.bc?.close();
    for (const ch of this.channels.values()) ch.close();
    for (const pc of this.pcs.values()) pc.close();
    this.manualPc?.close();
    this.channels.clear();
    this.pcs.clear();
    this.peers.clear();
    this.pendingIceCandidates.clear();
    this.remoteDescriptionReady.clear();
    this.initiatingPeers.clear();
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

  broadcastState(
    elements: JevElement[],
    boardTitle: string,
    meta?: {
      titleUpdatedAt?: number;
      tombstones?: TombstoneMap;
      hasLocalEdits?: boolean;
      authoritative?: boolean;
    }
  ) {
    const msg: CollabWireMessage = {
      kind: "sync_state",
      peerId: this.peerId,
      elements,
      boardTitle,
      ts: Date.now(),
      authoritative: meta?.authoritative ?? this.isRoomHost(),
      hasLocalEdits: meta?.hasLocalEdits ?? true,
      ...(meta?.titleUpdatedAt !== undefined
        ? { titleUpdatedAt: meta.titleUpdatedAt }
        : {}),
      ...(meta?.tombstones ? { tombstones: meta.tombstones } : {}),
    };
    this.sendToAll(msg);
  }

  private buildSyncStateMessage(now: number): CollabWireMessage {
    const state = this.callbacks.onGetLocalState();
    return {
      kind: "sync_state",
      peerId: this.peerId,
      elements: state.elements,
      boardTitle: state.boardTitle,
      ts: now,
      authoritative: this.isRoomHost(),
      hasLocalEdits: Boolean(state.hasLocalEdits),
      ...(state.titleUpdatedAt !== undefined
        ? { titleUpdatedAt: state.titleUpdatedAt }
        : {}),
      ...(state.tombstones ? { tombstones: state.tombstones } : {}),
    };
  }

  private sendToChannel(ch: RTCDataChannel, msg: CollabWireMessage) {
    if (ch.readyState !== "open") return;
    try {
      ch.send(JSON.stringify(msg));
    } catch {
      // ignore transient send errors
    }
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
      // Only an authoritative host or peer with local edits answers sync requests.
      // Fresh unmodified joiners never answer request_sync with starter state.
      if (!this.shouldPushSyncOnOpen()) {
        return;
      }
      const reply = this.buildSyncStateMessage(now);
      if (transport === "webrtc") {
        const ch = this.channels.get(msg.peerId);
        if (ch) {
          this.sendToChannel(ch, reply);
        }
      } else {
        try {
          this.bc?.postMessage(reply);
        } catch {
          // ignore closed channel
        }
      }
      return;
    }

    if (msg.kind === "sync_state") {
      // Never allow a fresh unmodified joiner to overwrite a host / edited board
      if (
        msg.hasLocalEdits === false &&
        !msg.authoritative &&
        this.shouldPushSyncOnOpen()
      ) {
        return;
      }
      this.callbacks.onRemoteState(msg.elements, msg.boardTitle, {
        senderPeerId: msg.peerId,
        titleUpdatedAt: msg.titleUpdatedAt,
        tombstones: msg.tombstones,
        hasLocalEdits: msg.hasLocalEdits,
        authoritative: msg.authoritative,
      });
      return;
    }

    if (msg.kind === "ping") {
      const ch = this.channels.get(msg.peerId);
      if (ch && ch.readyState === "open") {
        this.sendToChannel(ch, {
          kind: "pong",
          peerId: this.peerId,
          sentAt: msg.sentAt,
        });
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

  private hasActiveOrConnectingPeer(remoteId: string): boolean {
    const pc = this.pcs.get(remoteId);
    if (!pc) return false;
    return (
      pc.connectionState !== "failed" &&
      pc.connectionState !== "closed" &&
      pc.connectionState !== "disconnected"
    );
  }

  private reconcileRoster(roster: SignalRosterEntry[]) {
    if (this.destroyed || roster.length === 0) return;

    const hostId = resolveRoomHostFromRoster(roster);
    if (hostId) {
      this.rosterHostPeerId = hostId;
    }

    for (const remote of roster) {
      if (!remote.peerId || remote.peerId === this.peerId) continue;
      // Glare-free deterministic offerer selection consistent across all peers
      if (
        this.peerId < remote.peerId &&
        !this.hasActiveOrConnectingPeer(remote.peerId) &&
        !this.initiatingPeers.has(remote.peerId)
      ) {
        void this.initiateWebRTC(remote.peerId);
      }
    }
  }

  private async joinSignalingRoom() {
    if (this.destroyed || this.permanentAuthFailure || !this.roomSecret) return;
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
        if (res.status === 403) {
          try {
            const errData = (await res.json()) as { code?: string };
            if (errData.code === "invalid_room_secret") {
              this.permanentAuthFailure = true;
            }
          } catch {
            // ignore non-json 403
          }
        }
        this.signalingActive = false;
        this.emitStatus();
        return;
      }
      const data = (await res.json()) as {
        seq?: number;
        peerId?: string;
        peerToken?: string;
        epoch?: string;
        roster?: SignalRosterEntry[];
      };
      if (data.peerId && data.peerToken) {
        this.peerId = data.peerId;
        this.peerToken = data.peerToken;
        this.serverEpoch = data.epoch ?? null;
        this.signalCursor = typeof data.seq === "number" ? data.seq : 0;
        this.signalingActive = true;
        this.permanentAuthFailure = false;
        this.emitStatus();

        this.reconcileRoster(data.roster ?? []);
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
    if (!this.roomSecret || !this.peerToken || this.permanentAuthFailure) return;
    try {
      const res = await fetch("/api/signal", {
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
      if (!res.ok && data.type !== "leave") {
        if (res.status === 404 || res.status === 403) {
          try {
            const errData = (await res.json()) as { code?: string };
            if (errData.code === "invalid_room_secret") {
              this.permanentAuthFailure = true;
              this.signalingActive = false;
              this.emitStatus();
            } else if (
              errData.code === "peer_expired" ||
              errData.code === "room_not_found"
            ) {
              this.signalCursor = 0;
              this.peerToken = null;
              this.serverEpoch = null;
              this.rosterHostPeerId = null;
            }
          } catch {
            // ignore non-json errors
          }
        }
      }
    } catch {
      this.signalingActive = false;
      this.emitStatus();
    }
  }

  private async pollSignals() {
    if (this.destroyed || this.pollInFlight || this.permanentAuthFailure) return;
    if (!this.roomSecret || !this.peerToken) {
      if (this.started && !this.destroyed && !this.permanentAuthFailure) {
        await this.joinSignalingRoom();
        this.scheduleNextPoll();
      }
      return;
    }

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
        this.rosterHostPeerId = null;
        await this.joinSignalingRoom();
        return;
      }
      if (res.status === 403) {
        try {
          const errData = (await res.json()) as {
            code?: string;
            epoch?: string;
          };
          if (errData.code === "invalid_room_secret") {
            this.permanentAuthFailure = true;
            this.signalingActive = false;
            this.emitStatus();
            return;
          }
          if (
            errData.code === "peer_expired" ||
            (errData.epoch &&
              this.serverEpoch &&
              errData.epoch !== this.serverEpoch)
          ) {
            this.signalCursor = 0;
            this.peerToken = null;
            this.serverEpoch = null;
            this.rosterHostPeerId = null;
            await this.joinSignalingRoom();
          }
        } catch {
          // ignore non-json 403
        }
        return;
      }
      if (!res.ok) return;

      const data = (await res.json()) as {
        cursor?: number;
        epoch?: string;
        roster?: SignalRosterEntry[];
        messages?: Array<{
          from: string;
          type: "join" | "offer" | "answer" | "ice" | "leave";
          payload?: unknown;
          name?: string;
          color?: string;
        }>;
      };

      const nextCursor = typeof data.cursor === "number" ? data.cursor : 0;
      if (data.epoch && this.serverEpoch && data.epoch !== this.serverEpoch) {
        this.serverEpoch = data.epoch;
        this.signalCursor = nextCursor;
      } else {
        if (data.epoch) this.serverEpoch = data.epoch;
        this.signalCursor = Math.max(this.signalCursor, nextCursor);
      }

      if (Array.isArray(data.roster)) {
        this.reconcileRoster(data.roster);
      }

      for (const m of data.messages ?? []) {
        if (m.type === "join") {
          if (
            this.peerId < m.from &&
            !this.hasActiveOrConnectingPeer(m.from) &&
            !this.initiatingPeers.has(m.from)
          ) {
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
            await this.flushPendingIceCandidates(m.from, pc);
          }
        } else if (m.type === "ice" && m.payload) {
          await this.handleIncomingIceCandidate(
            m.from,
            m.payload as RTCIceCandidateInit
          );
        } else if (m.type === "leave") {
          this.cleanupPeer(m.from);
        }
      }
    } catch {
      // silent retry on transient network hiccup
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }

  private async handleIncomingIceCandidate(
    remoteId: string,
    candidate: RTCIceCandidateInit
  ) {
    const pc = this.pcs.get(remoteId);
    if (pc && this.remoteDescriptionReady.has(remoteId)) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // ignore transient invalid candidate
      }
      return;
    }

    const queue = this.pendingIceCandidates.get(remoteId) ?? [];
    if (queue.length < MAX_PENDING_ICE_PER_PEER) {
      queue.push(candidate);
      this.pendingIceCandidates.set(remoteId, queue);
    }
  }

  private async flushPendingIceCandidates(
    remoteId: string,
    pc: RTCPeerConnection
  ) {
    this.remoteDescriptionReady.add(remoteId);
    const queued = this.pendingIceCandidates.get(remoteId);
    if (!queued || queued.length === 0) return;
    this.pendingIceCandidates.delete(remoteId);

    for (const candidate of queued) {
      if (this.destroyed || this.pcs.get(remoteId) !== pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // ignore stale/incompatible candidate
      }
    }
  }

  private createPeerConnection(
    remoteId: string,
    iceConfig: RTCConfiguration
  ): RTCPeerConnection {
    const existing = this.pcs.get(remoteId);
    if (existing) existing.close();
    this.remoteDescriptionReady.delete(remoteId);

    const pc = new RTCPeerConnection(iceConfig);
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
      const now = Date.now();
      const local = this.callbacks.onGetLocalState();
      this.sendToChannel(ch, {
        kind: "hello",
        peerId: this.peerId,
        name: this.name,
        color: this.color,
        ts: now,
        hasLocalEdits: Boolean(local.hasLocalEdits),
        isAuthoritative: this.isRoomHost(),
      });

      if (this.shouldPushSyncOnOpen()) {
        // Authoritative host or edited peer pushes its board directly to this peer
        this.sendToChannel(ch, this.buildSyncStateMessage(now));
      } else {
        // Fresh unmodified joiner requests sync ONLY — never pushes starter state
        this.sendToChannel(ch, {
          kind: "request_sync",
          peerId: this.peerId,
          ts: now,
        });
      }
      this.emitStatus();
    };

    ch.onmessage = (ev) => {
      const msg = parseRawDataChannelMessage(ev.data);
      if (!msg || msg.peerId === this.peerId) return;
      this.handleWireMessage(msg, "webrtc");
    };

    ch.onclose = () => {
      if (this.channels.get(remoteId) === ch) {
        this.channels.delete(remoteId);
      }
      this.emitStatus();
    };
  }

  private async initiateWebRTC(remoteId: string) {
    if (this.destroyed || this.initiatingPeers.has(remoteId)) return;
    this.initiatingPeers.add(remoteId);
    try {
      const iceConfig = await this.getIceConfig();
      if (this.destroyed) return;
      const pc = this.createPeerConnection(remoteId, iceConfig);
      const ch = pc.createDataChannel("jev-sync", { ordered: true });
      this.attachDataChannel(remoteId, ch);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.postSignal({
        type: "offer",
        to: remoteId,
        payload: offer,
      });
    } finally {
      this.initiatingPeers.delete(remoteId);
    }
  }

  private async handleOffer(
    remoteId: string,
    offer: RTCSessionDescriptionInit
  ) {
    if (this.destroyed) return;
    const iceConfig = await this.getIceConfig();
    if (this.destroyed) return;
    const pc = this.createPeerConnection(remoteId, iceConfig);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.flushPendingIceCandidates(remoteId, pc);
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
    this.pendingIceCandidates.delete(remoteId);
    this.remoteDescriptionReady.delete(remoteId);
    this.initiatingPeers.delete(remoteId);
    this.emitPeers();
    this.emitStatus();
  }

  // --- ZERO-SERVER MANUAL WEBRTC HANDSHAKE (Copy Offer -> Paste Answer) ---

  async createManualOfferCode(): Promise<string> {
    this.manualPc?.close();
    const iceConfig = await this.getIceConfig();
    const pc = new RTCPeerConnection(iceConfig);
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
    const parsed = parseManualSdpPayload(decodeCompactJson(offerCode));
    if (!parsed || parsed.sdp.type !== "offer") {
      throw new Error("Invalid WebRTC offer code.");
    }

    const iceConfig = await this.getIceConfig();
    const pc = new RTCPeerConnection(iceConfig);
    this.pcs.set(parsed.from, pc);
    pc.ondatachannel = (ev) => {
      this.attachDataChannel(parsed.from, ev.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(parsed.sdp));
    await this.flushPendingIceCandidates(parsed.from, pc);
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
    const parsed = parseManualSdpPayload(decodeCompactJson(answerCode));
    if (!parsed || parsed.sdp.type !== "answer") {
      throw new Error("Invalid WebRTC answer code.");
    }
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
