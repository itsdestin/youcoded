// Mesh relay wire protocol: message shapes, limits and close codes.
//
// WHY THIS LIVES HERE AND NOT IN A SHARED FILE: the app shares protocol types with the
// Worker by hand-copying (see desktop/src/shared/fill-protocol.ts, which sits in the APP
// repo). The app repo was off limits for this piece of work, so the relay's wire types are
// defined here; when the app side of the Mesh is built, copy this file's `Mesh*` types and
// constants into the app's shared folder (and keep the two in step, as fill-protocol does).
//
// The relay never reads message content: every `payload` below is an opaque, already
// encrypted and signed frame. Only the small JSON header is the relay's business.

/** Highest and lowest protocol version this relay speaks. A client outside the range is refused
 *  with CLOSE_VERSION_REFUSED (no negotiation, no downgrade; design 5.11, threat model L-8). */
export const MESH_PROTOCOL_VERSION = 1;
export const MESH_MIN_PROTOCOL_VERSION = 1;

// ---- Sizes (T7 investigation, section 3.5 and 4) ----
/** Largest sealed frame the relay will hold or pass (1 MiB). WHY: the platform allows 32 MiB per
 *  message but the object has 128 MB of memory and every copy of a payload is another allocation. */
export const MAX_FRAME_BYTES = 1 << 20;
/** Largest JSON header. Headers are tiny; a big one is an attack, not a message. */
export const MAX_HEADER_BYTES = 8 * 1024;
/** Anything bigger than this is refused before it is parsed (4 length bytes + header + frame). */
export const MAX_MESSAGE_BYTES = 4 + MAX_HEADER_BYTES + MAX_FRAME_BYTES;
/** Per-set storage ceiling. WHY 900 MiB and not 1 GiB: T7 found the free plan's per-object
 *  storage limit is stated as 1 GB in one place and 10 GB in another, and 1 GiB of payload took
 *  1.0045 GiB on disk; 900 MiB is safe under either reading and under both plans. */
export const SET_CAP_BYTES = 900 * 1024 * 1024;
/** Allowance until a second device has joined the set (T7 abuse protection 1). WHY: a stranger
 *  with no account can create a set; until a second device pairs, nobody but the creator can
 *  benefit from stored data, so the smaller allowance costs real users nothing. */
export const PRE_PAIR_CAP_BYTES = 100 * 1024 * 1024;
/** "Nearly full" is announced from this fraction of the ceiling. */
export const NEARLY_FULL_FRACTION = 0.9;
/** A reply to fetch-after carries at most this many frame bytes before it says `more`. */
export const FETCH_PAGE_BYTES = 4 * 1024 * 1024;
export const REGISTER_MAX_BYTES = 16 * 1024;
export const MAX_REGISTERS = 4096;
export const MAX_GROUPS = 5000;
export const MAX_DEVICES = 16;
/** Authenticated connections per set. */
export const MAX_SOCKETS = 64;
/** WHY a separate, small cap (review finding 5): sockets that have not proved who they are are the only
 *  thing a stranger who merely knows a room id can hold. They never count against MAX_SOCKETS, and when all
 *  of these slots are taken the OLDEST (past the minimum age) is dropped for a newcomer, so members can always
 *  get in. */
export const MAX_UNAUTH_SOCKETS = 8;
/** An unauthenticated socket is closed this long after it connects (by an alarm, not only by the next connect). */
export const UNAUTH_DEADLINE_MS = 10_000;
/** A newcomer may evict the oldest unauthenticated socket only if it has had this long to answer (so a flood of
 *  new connections cannot knock out a member who is mid-handshake). */
export const UNAUTH_MIN_AGE_MS = 2_000;
/** Before authentication the only valid message is a small auth answer; anything bigger is closed at once (finding 12). */
export const UNAUTH_MAX_MESSAGE_BYTES = 16 * 1024;
/** A room object that nobody has registered a device in erases itself this long after it was first touched (finding 4). */
export const ABANDON_MS = 10 * 60_000;
/** Bytes one connection may be sent in reply to fetch/list requests per RATE_WINDOW_MS (finding 9). */
export const OUT_WINDOW_BYTES = 64 * 1024 * 1024;
/** Per sender (device), how many distinct run sessions the relay remembers for duplicate checks. */
export const MAX_SESSIONS_PER_DEVICE = 16;

// ---- Time ----
export const CHALLENGE_TTL_MS = 30_000;
export const DAY_MS = 86_400_000;
/** A chat's group is dropped this long after its last line (design 5.6). */
export const GROUP_TTL_MS = 30 * DAY_MS;
/** A set nobody has connected to for this long is erased entirely (design 5.6). */
export const SET_IDLE_ERASE_MS = 90 * DAY_MS;

// ---- Flood limits (per connection; in-memory on purpose, see relay-room.ts) ----
export const RATE_WINDOW_MS = 10_000;
/** Beats (one per 10 s), live words (4 a second) and fetch bursts all fit far below this. */
export const RATE_MAX_MESSAGES = 300;
export const RATE_MAX_HOLDS = 100;

// ---- Close codes. 4005 follows shared/fill-protocol.ts (old app refused, "update your app"). ----
export const CLOSE_NOT_AUTHED = 4001;       // sent something before proving who it is
export const CLOSE_AUTH_FAILED = 4002;      // bad signature, not on the roster, stale challenge
export const CLOSE_DEVICE_REMOVED = 4003;   // this device was removed from the set
export const CLOSE_SET_ERASED = 4004;       // the set was erased (90 idle days or empty roster)
export const CLOSE_VERSION_REFUSED = 4005;  // protocol version outside [MIN, current]
export const CLOSE_BAD_MESSAGE = 4006;      // malformed (not binary, bad header, bad length)
export const CLOSE_TOO_LARGE = 4007;
export const CLOSE_TOO_FAST = 4008;
export const CLOSE_RELAY_BUSY = 4009;
export const CLOSE_MEET_ENDED = 4010;       // pairing meeting point closed, expired or used up (never a member's room)
export const CLOSE_MEET_REFUSED = 4011;     // a meeting-point socket the meeting will not take (busy, wrong ticket, full)

// ---- Pairing meeting point (T5 C10, threat model P-3 / P-9, design 5.1) ----
/** A meeting point lives at most as long as the invite does (pairing.ts INVITE_LIFETIME_MS). */
export const MEET_LIFETIME_MS = 5 * 60_000;
/** One relayed pairing message. WHY 16 KiB: a CPace message is ~100 bytes and the welcome (set secret + the signed roster
 *  log) is a few KiB for a normal set; far above that is an abuse of a pipe that exists only to introduce two devices. */
export const MEET_MAX_MESSAGE_BYTES = 16 * 1024;
/** Whole meeting, both directions (threat model P-9: "at most 64 KiB total"). */
export const MEET_MAX_TOTAL_BYTES = 64 * 1024;
export const MEET_MAX_MESSAGES = 64;
/** Open sockets per meeting (host + guest + one newcomer being refused). */
export const MEET_MAX_SOCKETS = 4;
/** Guest connections ever made to one meeting: a stranger who knows the id can burn at most this many, then the meeting ends. */
export const MEET_MAX_GUEST_CONNECTS = 8;
/** A socket must say who it is (meet-join) within this long, and a guest must send its first message within it. */
export const MEET_JOIN_DEADLINE_MS = 10_000;
/** Per room: meetings open at once, and opened in the last hour. A room is opened by an authenticated member only. */
export const MEET_MAX_OPEN_PER_ROOM = 2;
export const MEET_OPENS_PER_HOUR = 12;
/** Per-socket flood ceiling on a meeting point (far below RATE_MAX_MESSAGES: the exchange is a handful of messages). */
export const MEET_RATE_MAX_MESSAGES = 40;

// ---- Identifier shapes: lowercase hex, fixed length ----
export const ROOM_HEX = 64;      // SHA-256 (T5 C2)
export const DEVICE_HEX = 32;    // first 16 bytes of SHA-256
export const KEY_HEX = 64;       // Ed25519 public key
export const SIG_HEX = 128;      // Ed25519 signature
export const NONCE_HEX = 64;
export const SESSION_HEX = 32;
export const MEET_HEX = 64;      // meeting id: SHA-256 of the typed code's random meeting part (never of the secret part)

export function isHex(v: unknown, len: number): v is string {
  return typeof v === "string" && v.length === len && /^[0-9a-f]+$/.test(v);
}
/** Group names are opaque (HMAC-truncated by the app, threat model L-5); the relay only bounds them. */
export function isGroupName(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9:_.-]{1,100}$/.test(v);
}
export function isRegisterKey(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9:_.-]{1,128}$/.test(v);
}
export function isCount(v: unknown, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
}

// ---- Fill state (T7: "Relay full" wording is the app's; the relay only reports the state) ----
export type MeshFill = "ok" | "nearly-full" | "full";
export interface MeshUsage { bytes: number; cap: number; fill: MeshFill; paired: boolean }

// ---- Messages. Client to relay (every one is a binary message: header JSON + optional payload). ----
// `id` is an optional caller-chosen correlation string (max 64 chars) echoed in the reply.
export type MeshClientMessage =
  | { op: "auth"; v: number; dev: string; sig: string; signKey?: string; id?: string }
  | { op: "hold"; g: string; from: string; session: string; n: number; line?: boolean; id?: string }       // + payload = sealed frame
  | { op: "fetch-after"; g: string; seq: number; id?: string }
  | { op: "received"; g: string; through: number; id?: string }
  | { op: "drop-group"; g: string; id?: string }
  | { op: "reg-get"; key: string; id?: string }
  | { op: "reg-list"; sinceRev?: number; id?: string }
  | { op: "reg-set"; key: string; expectToken: number; id?: string }                                       // + payload = value
  | { op: "presence"; id?: string }
  | { op: "pass"; g: string; to: string; id?: string }                                                     // + payload
  | { op: "beat"; n: number }
  // A roster change signed by a current member (review finding 8). `entry` is the id of the app's roster entry this
  // statement is about; the statement itself names only public ids and keys, never a device name.
  | { op: "roster-put"; kind: "add" | "remove"; signer: string; target: string; targetKey?: string; entry: string; seen: string[]; at: number; sig: string; id?: string }
  // Pairing meeting point. meet-open is sent on an authenticated ROOM socket; the rest on a /mesh/meet/<id> socket.
  | { op: "meet-open"; m: string; id?: string }
  | { op: "meet-join"; role: "host" | "guest"; ticket?: string; id?: string }
  | { op: "meet-relay"; n: number; id?: string }                                                           // + payload
  | { op: "meet-close"; id?: string }
  | { op: "usage"; id?: string };

// Relay to client.
export type MeshServerMessage =
  | { op: "challenge"; aud: string; nonce: string; v: number; min: number }
  | { op: "auth-result"; r: "ok" | "not-on-roster" | "bad-signature" | "stale-challenge" | "bad-request" | "removed" | "rate-limited"; created?: boolean; usage?: MeshUsage; devices?: string[]; id?: string }
  | { op: "version-refused"; min: number; max: number }
  | { op: "stored"; id?: string; g: string; seq: number; fill: MeshFill }
  | { op: "duplicate"; id?: string; g: string; n: number }
  | { op: "over-limit"; id?: string; why: "frame" | "group" | "set" | "groups" | "register" | "rate"; fill?: MeshFill }
  | { op: "refused"; id?: string; reason: string }
  | { op: "frame"; id?: string; g: string; seq: number }                                                   // + payload
  | { op: "frames-end"; id?: string; g: string; more: boolean; last?: number; empty?: boolean }
  | { op: "gap"; id?: string; g: string; through: number }
  | { op: "released"; g: string; throughSeq: number }
  | { op: "reg-result"; id?: string; regs: Array<{ key: string; token: number; len: number }> }            // + payload = value
  | { op: "reg-list-result"; id?: string; rev: number; more: boolean; regs: Array<{ key: string; token: number; len: number }> }
  | { op: "reg-ok"; id?: string; token: number }
  | { op: "conflict"; id?: string; token: number; len: number }                                            // + payload = current value
  | { op: "presence-result"; id?: string; devices: string[] }
  | { op: "presence-change"; device: string; state: "on" | "off" }
  | { op: "pass"; from: string; g: string }                                                                // + payload
  | { op: "beat"; from: string; n: number }
  | { op: "roster-changed"; change: "added" | "removed"; dev: string }
  // Doorbell: a frame was stored for this set. Numbered (the stored seq) so a device can tell a stale bell from a new one; no body, no size.
  | { op: "doorbell"; g: string; seq: number }
  | { op: "meet-opened"; id?: string; m: string; ticket: string; ttlMs: number }
  | { op: "meet-joined"; id?: string; role: "host" | "guest"; gen: number; peer: boolean }
  | { op: "meet-peer"; state: "on" | "off"; gen: number }
  | { op: "meet-relay"; from: "host" | "guest"; gen: number; n: number }                                   // + payload
  | { op: "meet-ended"; why: string }
  | { op: "ok"; id?: string }
  | { op: "usage-result"; id?: string; usage: MeshUsage }
  | { op: "error"; id?: string; reason: string };

// ---- Framing: [u32 big-endian header length][header JSON][payload bytes] ----
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function packMessage(header: object, payload?: ArrayBuffer | Uint8Array | null): ArrayBuffer {
  const hb = enc.encode(JSON.stringify(header));
  const pl = payload ? (payload instanceof Uint8Array ? payload : new Uint8Array(payload)) : null;
  const out = new Uint8Array(4 + hb.length + (pl ? pl.length : 0));
  new DataView(out.buffer).setUint32(0, hb.length);
  out.set(hb, 4);
  if (pl) out.set(pl, 4 + hb.length);
  return out.buffer;
}

export type Unpacked =
  | { ok: true; header: Record<string, unknown>; op: string; payload: Uint8Array }
  | { ok: false; reason: string };

/** Never throws: hostile input must come back as `ok:false`, not as an exception. */
export function unpackMessage(buf: ArrayBuffer): Unpacked {
  if (buf.byteLength < 5) return { ok: false, reason: "short" };
  const n = new DataView(buf).getUint32(0);
  if (n === 0 || n > MAX_HEADER_BYTES || 4 + n > buf.byteLength) return { ok: false, reason: "bad-header-length" };
  let header: unknown;
  try { header = JSON.parse(dec.decode(new Uint8Array(buf, 4, n))); } catch { return { ok: false, reason: "bad-json" }; }
  if (!header || typeof header !== "object" || Array.isArray(header)) return { ok: false, reason: "header-not-object" };
  const h = header as Record<string, unknown>;
  if (typeof h.op !== "string" || h.op.length === 0 || h.op.length > 32) return { ok: false, reason: "bad-op" };
  return { ok: true, header: h, op: h.op, payload: new Uint8Array(buf, 4 + n) };
}
