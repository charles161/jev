import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SlidingWindowRateLimiter } from "@/lib/server/rate-limit";

export type ValidSignalPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | {
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
      usernameFragment?: string | null;
    };

export interface SignalMessage {
  seq: number;
  from: string;
  to?: string;
  type: "join" | "offer" | "answer" | "ice" | "leave";
  payload?: ValidSignalPayload;
  name?: string;
  color?: string;
  ts: number;
}

export interface PeerRosterEntry {
  peerId: string;
  name?: string;
  color?: string;
  joinedAt: number;
}

interface StoredPeer {
  peerId: string;
  tokenHash: Buffer;
  name?: string;
  color?: string;
  joinedAt: number;
  lastSeen: number;
}

interface StoredMessage {
  msg: SignalMessage;
  byteLength: number;
}

interface RoomBucket {
  secretHash: Buffer;
  creatorIp: string;
  messages: StoredMessage[];
  totalMessageBytes: number;
  peers: Map<string, StoredPeer>;
  lastActive: number;
  nextSeq: number;
}

export interface SignalStoreConfig {
  maxRooms?: number;
  maxRoomsPerIp?: number;
  maxPeersPerRoom?: number;
  maxMessagesPerRoom?: number;
  maxRoomBytes?: number;
  roomTtlMs?: number;
  peerTtlMs?: number;
}

export type SignalErrorCode =
  | "invalid_room_secret"
  | "room_not_found"
  | "peer_expired"
  | "peer_identity_mismatch"
  | "room_peer_limit"
  | "ip_room_limit"
  | "capacity_reached"
  | "invalid_target"
  | "target_peer_not_found";

export type JoinRoomResult =
  | {
      ok: true;
      seq: number;
      peerId: string;
      peerToken: string;
      epoch: string;
      roster: PeerRosterEntry[];
    }
  | {
      ok: false;
      status: 403 | 429 | 503;
      code: SignalErrorCode;
      error: string;
      retryAfterSeconds?: number;
    };

export type PollRoomResult =
  | {
      ok: true;
      messages: SignalMessage[];
      cursor: number;
      epoch: string;
      roster: PeerRosterEntry[];
    }
  | {
      ok: false;
      status: 401 | 403 | 404;
      code: SignalErrorCode;
      error: string;
      epoch?: string;
    };

export type AuthenticateRoomPeerResult =
  | {
      ok: true;
      peerId: string;
    }
  | {
      ok: false;
      status: 403 | 404;
      code: SignalErrorCode;
      error: string;
    };

export type PostSignalResult =
  | {
      ok: true;
      seq: number;
      epoch: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404;
      code: SignalErrorCode;
      error: string;
      epoch?: string;
    };

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeHashEquals(secret: string, expectedHash: Buffer): boolean {
  const actualHash = sha256Buffer(secret);
  if (actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(actualHash, expectedHash);
}

export class SignalStore {
  readonly epoch: string;
  private readonly maxRooms: number;
  private readonly maxRoomsPerIp: number;
  private readonly maxPeersPerRoom: number;
  private readonly maxMessagesPerRoom: number;
  private readonly maxRoomBytes: number;
  private readonly roomTtlMs: number;
  private readonly peerTtlMs: number;

  private readonly rooms = new Map<string, RoomBucket>();
  private readonly roomsByIp = new Map<string, number>();

  constructor(config: SignalStoreConfig = {}) {
    this.epoch = randomBytes(8).toString("hex");
    this.maxRooms = config.maxRooms ?? 150;
    this.maxRoomsPerIp = config.maxRoomsPerIp ?? 5;
    this.maxPeersPerRoom = config.maxPeersPerRoom ?? 24;
    this.maxMessagesPerRoom = config.maxMessagesPerRoom ?? 80;
    this.maxRoomBytes = config.maxRoomBytes ?? 128 * 1024;
    this.roomTtlMs = config.roomTtlMs ?? 5 * 60 * 1000;
    this.peerTtlMs = config.peerTtlMs ?? 45 * 1000;
  }

  private decrementIpCount(ip: string): void {
    const prev = this.roomsByIp.get(ip) ?? 0;
    if (prev <= 1) {
      this.roomsByIp.delete(ip);
    } else {
      this.roomsByIp.set(ip, prev - 1);
    }
  }

  private pruneExpiredRooms(now: number): void {
    for (const [roomId, bucket] of this.rooms.entries()) {
      if (now - bucket.lastActive > this.roomTtlMs) {
        this.rooms.delete(roomId);
        this.decrementIpCount(bucket.creatorIp);
      }
    }
  }

  private pruneStalePeers(bucket: RoomBucket, now: number): void {
    for (const [peerId, peer] of bucket.peers.entries()) {
      if (now - peer.lastSeen > this.peerTtlMs) {
        bucket.peers.delete(peerId);
      }
    }
  }

  private getRoster(bucket: RoomBucket): PeerRosterEntry[] {
    return Array.from(bucket.peers.values()).map((peer) => ({
      peerId: peer.peerId,
      ...(peer.name ? { name: peer.name } : {}),
      ...(peer.color ? { color: peer.color } : {}),
      joinedAt: peer.joinedAt,
    }));
  }

  private authenticatePeer(
    bucket: RoomBucket,
    peerToken: string
  ): StoredPeer | null {
    const providedHash = sha256Buffer(peerToken);
    let matched: StoredPeer | null = null;
    for (const peer of bucket.peers.values()) {
      if (
        peer.tokenHash.length === providedHash.length &&
        timingSafeEqual(peer.tokenHash, providedHash)
      ) {
        matched = peer;
      }
    }
    return matched;
  }

  private appendMessage(bucket: RoomBucket, msg: SignalMessage): void {
    const byteLength = Buffer.byteLength(JSON.stringify(msg), "utf8");
    bucket.messages.push({ msg, byteLength });
    bucket.totalMessageBytes += byteLength;

    while (
      bucket.messages.length > this.maxMessagesPerRoom ||
      (bucket.messages.length > 1 && bucket.totalMessageBytes > this.maxRoomBytes)
    ) {
      const removed = bucket.messages.shift();
      if (!removed) break;
      bucket.totalMessageBytes = Math.max(
        0,
        bucket.totalMessageBytes - removed.byteLength
      );
    }
  }

  joinRoom(params: {
    room: string;
    roomSecret: string;
    clientIp: string;
    name?: string;
    color?: string;
    now?: number;
  }): JoinRoomResult {
    const now = params.now ?? Date.now();
    this.pruneExpiredRooms(now);

    let bucket = this.rooms.get(params.room);
    if (bucket) {
      if (!constantTimeHashEquals(params.roomSecret, bucket.secretHash)) {
        return {
          ok: false,
          status: 403,
          code: "invalid_room_secret",
          error: "Invalid room secret",
        };
      }
      this.pruneStalePeers(bucket, now);
      if (bucket.peers.size >= this.maxPeersPerRoom) {
        return {
          ok: false,
          status: 429,
          code: "room_peer_limit",
          error: "Room peer limit reached",
          retryAfterSeconds: 30,
        };
      }
    } else {
      const currentForIp = this.roomsByIp.get(params.clientIp) ?? 0;
      if (currentForIp >= this.maxRoomsPerIp) {
        return {
          ok: false,
          status: 429,
          code: "ip_room_limit",
          error: "Per-IP room limit reached",
          retryAfterSeconds: 60,
        };
      }
      if (this.rooms.size >= this.maxRooms) {
        return {
          ok: false,
          status: 503,
          code: "capacity_reached",
          error: "Signaling capacity reached",
          retryAfterSeconds: 30,
        };
      }

      bucket = {
        secretHash: sha256Buffer(params.roomSecret),
        creatorIp: params.clientIp,
        messages: [],
        totalMessageBytes: 0,
        peers: new Map(),
        lastActive: now,
        nextSeq: 1,
      };
      this.rooms.set(params.room, bucket);
      this.roomsByIp.set(params.clientIp, currentForIp + 1);
    }

    const peerId = `p_${randomBytes(12).toString("base64url")}`;
    const peerToken = randomBytes(24).toString("base64url");
    const peer: StoredPeer = {
      peerId,
      tokenHash: sha256Buffer(peerToken),
      name: params.name,
      color: params.color,
      joinedAt: now,
      lastSeen: now,
    };
    bucket.peers.set(peerId, peer);

    const msg: SignalMessage = {
      seq: bucket.nextSeq++,
      from: peerId,
      type: "join",
      name: params.name,
      color: params.color,
      ts: now,
    };
    this.appendMessage(bucket, msg);
    bucket.lastActive = now;

    return {
      ok: true,
      seq: msg.seq,
      peerId,
      peerToken,
      epoch: this.epoch,
      roster: this.getRoster(bucket),
    };
  }

  pollRoom(params: {
    room: string;
    roomSecret: string;
    peerToken: string;
    peerIdHint?: string;
    since: number;
    now?: number;
  }): PollRoomResult {
    const now = params.now ?? Date.now();
    this.pruneExpiredRooms(now);

    const bucket = this.rooms.get(params.room);
    if (!bucket) {
      return {
        ok: false,
        status: 404,
        code: "room_not_found",
        error: "Room session not found",
        epoch: this.epoch,
      };
    }

    if (!constantTimeHashEquals(params.roomSecret, bucket.secretHash)) {
      return {
        ok: false,
        status: 403,
        code: "invalid_room_secret",
        error: "Invalid room secret",
      };
    }

    const authPeer = this.authenticatePeer(bucket, params.peerToken);
    if (!authPeer) {
      return {
        ok: false,
        status: 403,
        code: "peer_expired",
        error: "Peer session expired or invalid",
        epoch: this.epoch,
      };
    }

    if (params.peerIdHint && params.peerIdHint !== authPeer.peerId) {
      return {
        ok: false,
        status: 403,
        code: "peer_identity_mismatch",
        error: "Peer identity mismatch",
      };
    }

    authPeer.lastSeen = now;
    this.pruneStalePeers(bucket, now);
    bucket.lastActive = now;

    const messages = bucket.messages
      .map((entry) => entry.msg)
      .filter(
        (m) =>
          m.seq > params.since &&
          m.from !== authPeer.peerId &&
          (!m.to || m.to === authPeer.peerId)
      );
    const cursor =
      bucket.messages.length > 0
        ? bucket.messages[bucket.messages.length - 1].msg.seq
        : params.since;

    return {
      ok: true,
      messages,
      cursor,
      epoch: this.epoch,
      roster: this.getRoster(bucket),
    };
  }

  authenticateRoomPeer(params: {
    room: string;
    roomSecret: string;
    peerToken: string;
    now?: number;
  }): AuthenticateRoomPeerResult {
    const now = params.now ?? Date.now();
    this.pruneExpiredRooms(now);

    const bucket = this.rooms.get(params.room);
    if (!bucket) {
      return {
        ok: false,
        status: 404,
        code: "room_not_found",
        error: "Room session not found",
      };
    }

    if (!constantTimeHashEquals(params.roomSecret, bucket.secretHash)) {
      return {
        ok: false,
        status: 403,
        code: "invalid_room_secret",
        error: "Invalid room secret",
      };
    }

    this.pruneStalePeers(bucket, now);
    const authPeer = this.authenticatePeer(bucket, params.peerToken);
    if (!authPeer) {
      return {
        ok: false,
        status: 403,
        code: "peer_expired",
        error: "Peer session expired or invalid",
      };
    }

    return { ok: true, peerId: authPeer.peerId };
  }

  postSignal(params: {
    room: string;
    roomSecret: string;
    peerToken: string;
    fromHint?: string;
    to?: string;
    type: "offer" | "answer" | "ice" | "leave";
    payload?: ValidSignalPayload;
    now?: number;
  }): PostSignalResult {
    const now = params.now ?? Date.now();
    this.pruneExpiredRooms(now);

    const bucket = this.rooms.get(params.room);
    if (!bucket) {
      return {
        ok: false,
        status: 404,
        code: "room_not_found",
        error: "Room session not found",
        epoch: this.epoch,
      };
    }

    if (!constantTimeHashEquals(params.roomSecret, bucket.secretHash)) {
      return {
        ok: false,
        status: 403,
        code: "invalid_room_secret",
        error: "Invalid room secret",
      };
    }

    const authPeer = this.authenticatePeer(bucket, params.peerToken);
    if (!authPeer) {
      return {
        ok: false,
        status: 403,
        code: "peer_expired",
        error: "Peer session expired or invalid",
        epoch: this.epoch,
      };
    }

    if (params.fromHint && params.fromHint !== authPeer.peerId) {
      return {
        ok: false,
        status: 403,
        code: "peer_identity_mismatch",
        error: "Peer identity mismatch",
      };
    }

    if (params.type === "leave") {
      bucket.peers.delete(authPeer.peerId);
      const seq = bucket.nextSeq++;
      if (bucket.peers.size === 0) {
        this.rooms.delete(params.room);
        this.decrementIpCount(bucket.creatorIp);
      } else {
        this.appendMessage(bucket, {
          seq,
          from: authPeer.peerId,
          type: "leave",
          ts: now,
        });
        bucket.lastActive = now;
      }
      return { ok: true, seq, epoch: this.epoch };
    }

    if (!params.to || params.to === authPeer.peerId) {
      return {
        ok: false,
        status: 400,
        code: "invalid_target",
        error: "Invalid target peer",
      };
    }

    if (!bucket.peers.has(params.to)) {
      return {
        ok: false,
        status: 404,
        code: "target_peer_not_found",
        error: "Target peer not active",
      };
    }

    authPeer.lastSeen = now;
    bucket.lastActive = now;

    const msg: SignalMessage = {
      seq: bucket.nextSeq++,
      from: authPeer.peerId,
      to: params.to,
      type: params.type,
      payload: params.payload,
      ts: now,
    };
    this.appendMessage(bucket, msg);

    return { ok: true, seq: msg.seq, epoch: this.epoch };
  }
}

export function createSignalStore(config?: SignalStoreConfig): SignalStore {
  return new SignalStore(config);
}

let defaultSignalStore = createSignalStore();
let signalGetLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 240,
  maxEntries: 2000,
});
let signalPostLimiter = new SlidingWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  maxEntries: 2000,
});

export function getDefaultSignalStore(): SignalStore {
  return defaultSignalStore;
}

export function getSignalGetRateLimiter(): SlidingWindowRateLimiter {
  return signalGetLimiter;
}

export function getSignalPostRateLimiter(): SlidingWindowRateLimiter {
  return signalPostLimiter;
}

export function resetDefaultSignalStoreForTests(): void {
  defaultSignalStore = createSignalStore();
  signalGetLimiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 240,
    maxEntries: 2000,
  });
  signalPostLimiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 120,
    maxEntries: 2000,
  });
}
