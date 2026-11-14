// Relay challenge-response (T5 C9; design 5.6 item 1, threat model Y-3).
//
// Lets a device prove it belongs to a room's roster WITHOUT revealing any key: it only signs.
//   relay -> device : { aud: relay host, nonce: 32 random bytes }   (single use, valid 30 s)
//   device checks   : aud equals the host it actually DIALLED (else a malicious relay could
//                     forward another relay's challenge to harvest a signature), then signs
//   LABEL+"relay-auth\0" || canonical{ aud, room, nonce, dev }
//   relay checks    : nonce is its own, unused, fresh; `dev` is on `room`'s roster; signature valid.
// The room is named INSIDE the signed message and verified against that room's roster, never
// trusted (gap G16: a device can be in two sets during a join).
import { LABEL, concat, random, toHex, utf8, requireLen, type Bytes } from './bytes';
import { encode } from './cbor';
import { MeshCryptoError } from './errors';
import { signWith, verifySig, type DeviceIdentity } from './identity';

export const CHALLENGE_LIFETIME_MS = 30_000;
const MAX_PENDING = 1024;

export interface RelayChallenge {
  aud: string;
  nonce: Buffer;
}
export interface RelayAuthResponse {
  room: Buffer;
  nonce: Buffer;
  dev: Buffer;
  sig: Buffer;
}

const message = (aud: string, room: Bytes, nonce: Bytes, dev: Bytes): Buffer =>
  concat(utf8(LABEL + 'relay-auth\0'), encode({ aud, room, nonce, dev }));

/** Device side. Throws 'relay-mismatch' if the relay names a host other than the one dialled. */
export function answerRelayChallenge(id: DeviceIdentity, dialledHost: string, room: Bytes, ch: RelayChallenge): RelayAuthResponse {
  if (ch.aud !== dialledHost) throw new MeshCryptoError('relay-mismatch');
  requireLen(room, 32, 'room');
  requireLen(ch.nonce, 32, 'nonce');
  return { room: Buffer.from(room), nonce: Buffer.from(ch.nonce), dev: id.deviceId, sig: signWith(id, message(ch.aud, room, ch.nonce, id.deviceId)) };
}

export type RelayVerdict = { ok: true; room: Buffer; dev: Buffer } | { ok: false; why: 'stale-or-unknown-nonce' | 'not-on-roster' | 'bad-signature' | 'malformed' };

/** Relay side (also what the worker's logic will be ported from). */
export class RelayAuthVerifier {
  private readonly pending = new Map<string, number>();
  constructor(
    private readonly aud: string,
    /** Return the device's signing key if `dev` is on `room`'s roster, else undefined. */
    private readonly lookup: (room: Buffer, dev: Buffer) => Bytes | undefined,
    private readonly now: () => number = Date.now,
  ) {}
  challenge(): RelayChallenge {
    const nonce = random(32);
    // Bounded memory: an unauthenticated peer can request challenges, so the oldest are dropped.
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(toHex(nonce), this.now());
    return { aud: this.aud, nonce };
  }
  verify(resp: RelayAuthResponse): RelayVerdict {
    if (!(resp?.nonce instanceof Uint8Array) || !(resp.room instanceof Uint8Array) || !(resp.dev instanceof Uint8Array) || !(resp.sig instanceof Uint8Array)) return { ok: false, why: 'malformed' };
    // WHY first: the nonce is attacker-sized; check its length before any hex-encoding or map lookup.
    if (resp.nonce.length !== 32 || resp.room.length !== 32 || resp.dev.length !== 16) return { ok: false, why: 'malformed' };
    const k = toHex(resp.nonce);
    const t = this.pending.get(k);
    this.pending.delete(k); // single use, even on failure
    if (t === undefined || this.now() - t > CHALLENGE_LIFETIME_MS) return { ok: false, why: 'stale-or-unknown-nonce' };
    const signKey = this.lookup(Buffer.from(resp.room), Buffer.from(resp.dev));
    if (!signKey) return { ok: false, why: 'not-on-roster' };
    return verifySig(signKey, message(this.aud, resp.room, resp.nonce, resp.dev), resp.sig)
      ? { ok: true, room: Buffer.from(resp.room), dev: Buffer.from(resp.dev) }
      : { ok: false, why: 'bad-signature' };
  }
}
