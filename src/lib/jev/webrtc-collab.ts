import {
  computeMaxKnownRev,
  electAuthoritativePeer,
  PeerAuthorityCandidate,
} from "./board-sync";
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
  titleRev?: number;
  titleUpdatedBy?: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  tombstoneHorizonRev?: number;
  tombstoneHorizonAt?: number;
  boardEpoch?: string;
  boardEpochCreatedAt?: number;
  baseRev?: number;
  baseTimestamp?: number;
  hasLocalEdits?: boolean;
}

export interface RemoteStateMeta {
  senderPeerId: string;
  verifiedSenderPeerId?: string;
  authoritativePeerId?: string | null;
  titleRev?: number;
  titleUpdatedBy?: string;
  titleUpdatedAt?: number;
  tombstones?: TombstoneMap;
  tombstoneHorizonRev?: number;
  tombstoneHorizonAt?: number;
  boardEpoch?: string;
  boardEpochCreatedAt?: number;
  baseRev?: number;
  baseTimestamp?: number;
  fullResync?: boolean;
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
  random?: () => number;
}

const MAX_BACKOFF_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 300_000;

/**
 * Parses an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
    }
    return null;
  }

  const parsedDateMs = Date.parse(trimmed);
  if (Number.isFinite(parsedDateMs)) {
    return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, parsedDateMs - nowMs));
  }
  return null;
}

/**
 * Computes exponential backoff with random jitter, capped at `maxMs` (default 30s),
 * while strictly honoring server-provided `Retry-After` delays when present.
 */
export function computeBackoffDelayMs(params: {
  attempt: number;
  baseMs?: number;
  maxMs?: number;
  retryAfterMs?: number | null;
  random?: () => number;
}): number {
  const baseMs = Math.max(100, params.baseMs ?? 1500);
  const maxMs = Math.max(baseMs, params.maxMs ?? MAX_BACKOFF_DELAY_MS);
  const attempt = Math.max(0, Math.min(20, Math.floor(params.attempt)));
  const rand = params.random ?? Math.random;
  const r = Math.max(0, Math.min(1, rand()));

  const expDelay = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  // Equal-plus jitter in [0.5 * expDelay, expDelay], capped at maxMs
  const jittered = Math.min(
    maxMs,
    Math.round(expDelay * (0.5 + 0.5 * r))
  );

  if (
    typeof params.retryAfterMs === "number" &&
    Number.isFinite(params.retryAfterMs) &&
    params.retryAfterMs > 0
  ) {
    return Math.max(jittered, Math.ceil(params.retryAfterMs));
  }
  return jittered;
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

export class JevP2PCollab {
  readonly roomId: string;
  private readonly roomSecret: string;
  peerId: string;
  readonly name: string;
  readonly color: string;

  private callbacks: CollabCallbacks;
  private readonly isRoomCreator: boolean;
  private readonly pollIntervalMs: number;
  private readonly randomFn: () => number;
  private retryAttempt = 0;
  private nextPollDelayOverrideMs: number | null = null;
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
  private serverCreatorPeerId: string | null = null;
  private serverRoster = new Map<string, number>();
  private peerSyncInfo = new Map<string, { hasLocalEdits: boolean }>();
  private pollInFlight = false;
  private signalingActive = false;
  private permanentAuthFailure = false;
  private started = false;
  private destroyed = false;
  private resolvedIceConfig: RTCConfiguration | null = null;
  private iceConfigPromise: Promise<RTCConfiguration> | null = null;
  private iceConfigPinned = false;
  private iceConfigFetchedWithAuth = false;
  private iceConfigExpiresAtMs: number | null = null;

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
    this.randomFn = options.random ?? Math.random;
    if (options.iceServers && options.iceServers.length > 0) {
      this.resolvedIceConfig = { iceServers: options.iceServers };
      this.iceConfigPinned = true;
    }
  }

  private getAuthoritativePeerId(): string | null {
    if (this.serverRoster.size === 0) return null;

    const local = this.callbacks.onGetLocalState();
    const candidates: PeerAuthorityCandidate[] = [];

    for (const [pid, joinedAt] of this.serverRoster.entries()) {
      if (pid === this.peerId) {
        candidates.push({
          peerId: pid,
          joinedAt,
          inServerRoster: true,
          hasLocalEdits: Boolean(local.hasLocalEdits),
        });
      } else {
        const info = this.peerSyncInfo.get(pid);
        candidates.push({
          peerId: pid,
          joinedAt,
          inServerRoster: true,
          // Treat an active server-roster peer as eligible unless they explicitly reported as a fresh unmodified joiner
          hasLocalEdits: info ? info.hasLocalEdits : true,
        });
      }
    }

    return electAuthoritativePeer(candidates, {
      creatorPeerId: this.serverCreatorPeerId,
    });
  }

  private isRoomHost(): boolean {
    const local = this.callbacks.onGetLocalState();
    // A fresh/unmodified starter board is NEVER authoritative
    if (!local.hasLocalEdits) {
      return false;
    }
    if (this.serverRoster.size > 0) {
      return this.getAuthoritativePeerId() === this.peerId;
    }
    return this.isRoomCreator;
  }

  private shouldPushSyncOnOpen(): boolean {
    const local = this.callbacks.onGetLocalState();
    return Boolean(local.hasLocalEdits);
  }

  getConnectedPeerCount(): number {
    let openChannels = 0;
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open") openChannels += 1;
    }
    const broadcastPeers = Array.from(this.peers.values()).filter(
      (p) => p.transport === "broadcast"
    ).length;
    return openChannels + broadcastPeers;
  }

  private invalidateIceConfigCache(): void {
    if (this.iceConfigPinned) return;
    this.resolvedIceConfig = null;
    this.iceConfigPromise = null;
    this.iceConfigFetchedWithAuth = false;
    this.iceConfigExpiresAtMs = null;
  }

  private async getIceConfig(): Promise<RTCConfiguration> {
    if (this.iceConfigPinned && this.resolvedIceConfig) {
      return this.resolvedIceConfig;
    }
    const hasPeerAuth = Boolean(this.roomId && this.roomSecret && this.peerToken);
    const isExpired =
      this.iceConfigExpiresAtMs !== null &&
      Date.now() >= this.iceConfigExpiresAtMs - 60_000;
    const needsAuthUpgrade = hasPeerAuth && !this.iceConfigFetchedWithAuth;

    if (this.resolvedIceConfig && !isExpired && !needsAuthUpgrade) {
      return this.resolvedIceConfig;
    }
    if (isExpired || needsAuthUpgrade) {
      this.resolvedIceConfig = null;
      this.iceConfigPromise = null;
    }

    if (!this.iceConfigPromise) {
      const fetchWithAuth = hasPeerAuth;
      const url = fetchWithAuth
        ? `/api/ice-config?room=${encodeURIComponent(this.roomId)}`
        : "/api/ice-config";
      const headers: Record<string, string> = fetchWithAuth
        ? {
            "x-room-secret": this.roomSecret,
            "x-peer-token": this.peerToken!,
          }
        : {};

      this.iceConfigPromise = (async () => {
        try {
          const res = await fetch(url, {
            method: "GET",
            cache: "no-store",
            ...(fetchWithAuth ? { headers } : {}),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              iceServers?: unknown;
              expiresAt?: unknown;
            };
            if (Array.isArray(data.iceServers)) {
              const valid = data.iceServers.filter(isValidIceServer);
              if (valid.length > 0) {
                this.resolvedIceConfig = { iceServers: valid };
                this.iceConfigFetchedWithAuth = fetchWithAuth;
                this.iceConfigExpiresAtMs =
                  typeof data.expiresAt === "number" &&
                  Number.isFinite(data.expiresAt)
                    ? data.expiresAt * 1000
                    : null;
                return this.resolvedIceConfig;
              }
            }
          }
        } catch {
          // fall back to default STUN servers
        }
        this.resolvedIceConfig = { iceServers: DEFAULT_ICE_SERVERS };
        this.iceConfigFetchedWithAuth = fetchWithAuth;
        this.iceConfigExpiresAtMs = null;
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
        } satisfies CollabWireMessage);
        this.bc.postMessage({
          kind: "request_sync",
          peerId: this.peerId,
          ts: Date.now(),
          reason: "initial",
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
        } satisfies CollabWireMessage);
      } catch {
        // ignore closed channel
      }
    }, 3500);

    this.emitStatus();
  }

  private async bootstrapSignaling() {
    await this.joinSignalingRoom();
    if (this.destroyed) return;
    if (this.peerToken) {
      await this.getIceConfig();
    }
    if (!this.destroyed) {
      this.scheduleNextPoll();
    }
  }

  private recordRetryBackoff(retryAfterHeader?: string | null) {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    this.nextPollDelayOverrideMs = computeBackoffDelayMs({
      attempt: this.retryAttempt,
      baseMs: this.pollIntervalMs,
      maxMs: MAX_BACKOFF_DELAY_MS,
      retryAfterMs,
      random: this.randomFn,
    });
    this.retryAttempt += 1;
  }

  private resetRetryBackoff() {
    this.retryAttempt = 0;
    this.nextPollDelayOverrideMs = null;
  }

  private scheduleNextPoll() {
    if (this.destroyed || !this.started || this.permanentAuthFailure) return;
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const delayMs = this.nextPollDelayOverrideMs ?? this.pollIntervalMs;
    this.nextPollDelayOverrideMs = null;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.pollSignals();
    }, delayMs);
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
      titleRev?: number;
      titleUpdatedBy?: string;
      titleUpdatedAt?: number;
      tombstones?: TombstoneMap;
      tombstoneHorizonRev?: number;
      tombstoneHorizonAt?: number;
      boardEpoch?: string;
      boardEpochCreatedAt?: number;
      baseRev?: number;
      baseTimestamp?: number;
      hasLocalEdits?: boolean;
      authoritative?: boolean;
      fullResync?: boolean;
    }
  ) {
    const hasEdits = meta?.hasLocalEdits ?? true;
    const baseRev =
      meta?.baseRev ??
      computeMaxKnownRev({
        elements,
        tombstones: meta?.tombstones,
        titleRev: meta?.titleRev,
        tombstoneHorizonRev: meta?.tombstoneHorizonRev,
      });
    const msg: CollabWireMessage = {
      kind: "sync_state",
      peerId: this.peerId,
      elements,
      boardTitle,
      ts: Date.now(),
      hasLocalEdits: hasEdits,
      baseRev,
      ...(meta?.titleRev !== undefined ? { titleRev: meta.titleRev } : {}),
      ...(meta?.titleUpdatedBy ? { titleUpdatedBy: meta.titleUpdatedBy } : {}),
      ...(meta?.titleUpdatedAt !== undefined
        ? { titleUpdatedAt: meta.titleUpdatedAt }
        : {}),
      ...(meta?.tombstones ? { tombstones: meta.tombstones } : {}),
      ...(meta?.tombstoneHorizonRev !== undefined
        ? { tombstoneHorizonRev: meta.tombstoneHorizonRev }
        : {}),
      ...(meta?.tombstoneHorizonAt !== undefined
        ? { tombstoneHorizonAt: meta.tombstoneHorizonAt }
        : {}),
      ...(meta?.boardEpoch ? { boardEpoch: meta.boardEpoch } : {}),
      ...(meta?.boardEpochCreatedAt !== undefined
        ? { boardEpochCreatedAt: meta.boardEpochCreatedAt }
        : {}),
      ...(meta?.baseTimestamp !== undefined
        ? { baseTimestamp: meta.baseTimestamp }
        : {}),
      ...(meta?.fullResync ? { fullResync: true } : {}),
    };
    this.sendToAll(msg);
  }

  requestFullResync(targetPeerId?: string) {
    const msg: CollabWireMessage = {
      kind: "request_sync",
      peerId: this.peerId,
      ts: Date.now(),
      reason: "resync",
    };
    if (targetPeerId) {
      const ch = this.channels.get(targetPeerId);
      if (ch && ch.readyState === "open") {
        this.sendToChannel(ch, msg);
        return;
      }
    }
    this.sendToAll(msg);
  }

  sendFullResync(targetPeerId?: string) {
    if (!this.shouldPushSyncOnOpen()) return;
    const msg = this.buildSyncStateMessage(Date.now(), true);
    if (targetPeerId) {
      const ch = this.channels.get(targetPeerId);
      if (ch && ch.readyState === "open") {
        this.sendToChannel(ch, msg);
        return;
      }
    }
    this.sendToAll(msg);
  }

  private buildSyncStateMessage(
    now: number,
    fullResync = false
  ): CollabWireMessage {
    const state = this.callbacks.onGetLocalState();
    const hasEdits = Boolean(state.hasLocalEdits);
    const baseRev =
      state.baseRev ??
      computeMaxKnownRev({
        elements: state.elements,
        tombstones: state.tombstones,
        titleRev: state.titleRev,
        tombstoneHorizonRev: state.tombstoneHorizonRev,
      });
    return {
      kind: "sync_state",
      peerId: this.peerId,
      elements: state.elements,
      boardTitle: state.boardTitle,
      ts: now,
      hasLocalEdits: hasEdits,
      baseRev,
      ...(state.titleRev !== undefined ? { titleRev: state.titleRev } : {}),
      ...(state.titleUpdatedBy
        ? { titleUpdatedBy: state.titleUpdatedBy }
        : {}),
      ...(state.titleUpdatedAt !== undefined
        ? { titleUpdatedAt: state.titleUpdatedAt }
        : {}),
      ...(state.tombstones ? { tombstones: state.tombstones } : {}),
      ...(state.tombstoneHorizonRev !== undefined
        ? { tombstoneHorizonRev: state.tombstoneHorizonRev }
        : {}),
      ...(state.tombstoneHorizonAt !== undefined
        ? { tombstoneHorizonAt: state.tombstoneHorizonAt }
        : {}),
      ...(state.boardEpoch ? { boardEpoch: state.boardEpoch } : {}),
      ...(state.boardEpochCreatedAt !== undefined
        ? { boardEpochCreatedAt: state.boardEpochCreatedAt }
        : {}),
      ...(state.baseTimestamp !== undefined
        ? { baseTimestamp: state.baseTimestamp }
        : {}),
      ...(fullResync ? { fullResync: true } : {}),
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
    transport: "webrtc" | "broadcast",
    verifiedSenderPeerId?: string
  ) {
    const senderId = verifiedSenderPeerId ?? msg.peerId;
    if (!senderId || senderId === this.peerId) return;

    const now = Date.now();
    if (msg.kind === "hello") {
      const hasEdits = Boolean(msg.hasLocalEdits);
      this.peerSyncInfo.set(senderId, {
        hasLocalEdits: hasEdits,
      });

      const existing = this.peers.get(senderId);
      this.peers.set(senderId, {
        peerId: senderId,
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
      const existing = this.peers.get(senderId);
      this.peers.set(senderId, {
        peerId: senderId,
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
      // Only a content-bearing peer answers sync requests; fresh joiners never push starter state.
      if (!this.shouldPushSyncOnOpen()) {
        return;
      }
      const isResyncRequest = msg.reason === "resync";
      if (isResyncRequest && !this.isRoomHost()) {
        return;
      }
      const reply = this.buildSyncStateMessage(
        now,
        isResyncRequest && this.isRoomHost()
      );
      if (transport === "webrtc") {
        const ch = this.channels.get(senderId);
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
      const remoteHasEdits = msg.hasLocalEdits === true;
      this.peerSyncInfo.set(senderId, {
        hasLocalEdits: remoteHasEdits,
      });

      // Never allow a fresh unmodified joiner to overwrite a content-bearing board
      if (msg.hasLocalEdits === false && this.shouldPushSyncOnOpen()) {
        return;
      }

      // Derive authority strictly from server-side creatorPeerId + roster joinedAt (ignore wire msg.authoritative / baseRev!)
      const authoritativePeerId = this.getAuthoritativePeerId();
      const verifiedAuthoritative =
        authoritativePeerId !== null && authoritativePeerId === senderId;

      this.callbacks.onRemoteState(msg.elements, msg.boardTitle, {
        senderPeerId: senderId,
        verifiedSenderPeerId: senderId,
        authoritativePeerId,
        titleRev: msg.titleRev,
        titleUpdatedBy: senderId,
        titleUpdatedAt: msg.titleUpdatedAt,
        tombstones: msg.tombstones,
        tombstoneHorizonRev: msg.tombstoneHorizonRev,
        tombstoneHorizonAt: msg.tombstoneHorizonAt,
        boardEpoch: msg.boardEpoch,
        boardEpochCreatedAt: msg.boardEpochCreatedAt,
        baseRev: msg.baseRev,
        baseTimestamp: msg.baseTimestamp,
        fullResync: msg.fullResync,
        hasLocalEdits: msg.hasLocalEdits,
        authoritative: verifiedAuthoritative,
      });
      return;
    }

    if (msg.kind === "ping") {
      const ch = this.channels.get(senderId);
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
      const existing = this.peers.get(senderId);
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

  private reconcileRoster(
    roster: SignalRosterEntry[],
    creatorPeerId?: string | null
  ) {
    if (this.destroyed) return;
    if (typeof creatorPeerId === "string" && creatorPeerId.length > 0) {
      this.serverCreatorPeerId = creatorPeerId;
    }
    if (roster.length === 0) return;

    const nextRoster = new Map<string, number>();
    for (const entry of roster) {
      if (!entry.peerId) continue;
      nextRoster.set(
        entry.peerId,
        typeof entry.joinedAt === "number"
          ? entry.joinedAt
          : Number.MAX_SAFE_INTEGER
      );
    }
    this.serverRoster = nextRoster;

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
        if (!this.permanentAuthFailure) {
          this.recordRetryBackoff(res.headers.get("retry-after"));
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
        creatorPeerId?: string;
        roster?: SignalRosterEntry[];
      };
      if (data.peerId && data.peerToken) {
        const peerChanged =
          this.peerId !== data.peerId || this.peerToken !== data.peerToken;
        this.peerId = data.peerId;
        this.peerToken = data.peerToken;
        if (peerChanged) {
          this.invalidateIceConfigCache();
        }
        this.serverEpoch = data.epoch ?? null;
        this.signalCursor = typeof data.seq === "number" ? data.seq : 0;
        this.signalingActive = true;
        this.permanentAuthFailure = false;
        this.resetRetryBackoff();
        this.emitStatus();

        this.reconcileRoster(data.roster ?? [], data.creatorPeerId);
      }
    } catch {
      this.recordRetryBackoff(null);
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
              this.serverCreatorPeerId = null;
              this.serverRoster.clear();
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
        // Server restarted or room expired — reset cursor and rejoin with backoff on failure
        this.signalCursor = 0;
        this.peerToken = null;
        this.serverEpoch = null;
        this.serverCreatorPeerId = null;
        this.serverRoster.clear();
        this.recordRetryBackoff(res.headers.get("retry-after"));
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
            this.serverCreatorPeerId = null;
            this.serverRoster.clear();
            this.recordRetryBackoff(res.headers.get("retry-after"));
            await this.joinSignalingRoom();
          }
        } catch {
          this.recordRetryBackoff(res.headers.get("retry-after"));
        }
        return;
      }
      if (!res.ok) {
        this.recordRetryBackoff(res.headers.get("retry-after"));
        return;
      }

      this.resetRetryBackoff();

      const data = (await res.json()) as {
        cursor?: number;
        epoch?: string;
        creatorPeerId?: string;
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
        this.reconcileRoster(data.roster, data.creatorPeerId);
      }

      for (const m of data.messages ?? []) {
        try {
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
                new RTCSessionDescription(
                  m.payload as RTCSessionDescriptionInit
                )
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
        } catch {
          // Isolate bad/stale individual signal so remaining messages in the batch still process
        }
      }
    } catch {
      // Exponential backoff with jitter on transient network hiccup
      this.recordRetryBackoff(null);
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
      });

      if (this.shouldPushSyncOnOpen()) {
        // Content-bearing peer pushes its board directly to this peer
        this.sendToChannel(ch, this.buildSyncStateMessage(now));
      } else {
        // Fresh unmodified joiner requests sync ONLY — never pushes starter state
        this.sendToChannel(ch, {
          kind: "request_sync",
          peerId: this.peerId,
          ts: now,
          reason: "initial",
        });
      }
      this.emitStatus();
    };

    ch.onmessage = (ev) => {
      const msg = parseRawDataChannelMessage(ev.data);
      if (!msg) return;
      // Bind every WebRTC DataChannel message strictly to the RTCPeerConnection's verified remoteId
      this.handleWireMessage(msg, "webrtc", remoteId);
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
    this.peerSyncInfo.delete(remoteId);
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
