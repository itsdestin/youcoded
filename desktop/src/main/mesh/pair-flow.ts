// Pairing, device layer: wraps the crypto library's Existing / NewDevice so that a successful pairing is made DURABLE
// before it is acknowledged, over any pipe (design 5.1 "Pairing").
//
// THE PIPE. These classes take and return BYTES and know nothing about transport. In the product the bytes travel over the
// relay's pairing meeting point (meeting-client.ts, driven by service.ts). The direct carriers, a plain function call in unit
// tests and the rig's orchestrator forwarding bytes between two test-control ports, remain ONLY as test carriers.
//
// HOST (the existing device):
//  * open() makes a typed-code invite. The code and the meeting point are returned to the caller to SHOW; they are never
//    logged here.
//  * decide() answers "Add this device?". The welcome (set secrets + roster) leaves ONLY after the new `add` entry has
//    been appended to the durable roster log and the relay (if any) has been told the new device's public key, so a
//    device that received a welcome is always one the host can prove it added and the relay will let in.
// JOINER (the new device):
//  * adoptPairing() stores the received secrets in the key store and appends every roster entry, in order, through the
//    verifying roster store. Nothing is stored unless the whole welcome verified (the crypto library checked it).
import { CODE_ALPHABET, Existing, NewDevice, generateCode, normalizeCode, type AddPromptInfo, type ExistingState, type Invite, type PairingSuccess } from './crypto/pairing';
import { utf8 } from './crypto/bytes';
import { MeshCryptoError } from './crypto/errors';
import { encode } from './crypto/cbor';
import type { DeviceIdentity } from './crypto/identity';
import type { SignedEntry } from './crypto/roster';
import type { MeshKeyStore } from './keystore';
import type { RosterStore } from './roster-store';

export interface PendingPrompt { conn: string; info: AddPromptInfo }

export interface HostOptions {
  identity: DeviceIdentity;
  setId: Buffer;
  secrets: () => Map<number, Buffer>;
  roster: RosterStore;
  /** Tell the relay (when there is one) about the new device: its public signing key, and the signed `add` entry that admits it
   *  (the relay checks a statement signed by this device, service.ts), so the newcomer can sign in. */
  admitAtRelay?: (signKeyHex: string, entry: SignedEntry) => Promise<void>;
  /** After the add is durable (publish it to the other devices here). */
  afterAdded?: (entry: SignedEntry) => Promise<void> | void;
  now?: () => number;
}

export class PairingHost {
  readonly #o: HostOptions;
  readonly #state: ExistingState;
  readonly #existing: Existing;
  #prompt: PendingPrompt | null = null;
  #added: SignedEntry | null = null;
  constructor(o: HostOptions) {
    this.#o = o;
    this.#state = { setId: o.setId, secrets: o.secrets(), roster: [...o.roster.entries] };
    this.#existing = new Existing(o.identity, this.#state, {
      // undefined = "a human answers later through decide()"; the screen reads prompt().
      onAddPrompt: (info, conn) => { this.#prompt = { conn, info }; return undefined; },
      onAdded: (entry) => { this.#added = entry; },
      now: o.now,
    });
  }
  /** Start a typed-code invite. `room` is the meeting point (the relay will hand one out; random here). */
  open(room?: Buffer): { room: Buffer; code: string; invite: Invite } {
    this.#state.roster = [...this.#o.roster.entries];
    this.#state.secrets = this.#o.secrets();
    const invite = this.#existing.openInvite('code', room);
    return { room: invite.room, code: invite.code as string, invite };
  }
  get prompt(): PendingPrompt | null {
    return this.#prompt;
  }
  get events(): readonly string[] {
    return this.#existing.events;
  }
  onMessage(conn: string, bytes: Uint8Array): Buffer[] {
    return this.#existing.onMessage(conn, bytes);
  }
  dropConnection(conn: string): void {
    this.#existing.dropConnection(conn);
  }
  /** The human's answer. Resolves with the messages to send back; the welcome is released only once everything is durable. */
  async decide(conn: string, approved: boolean): Promise<Buffer[]> {
    this.#state.roster = [...this.#o.roster.entries];
    this.#added = null;
    const out = this.#existing.decide(conn, approved);
    this.#prompt = null;
    const add = this.#added as SignedEntry | null;
    if (!add) return out; // declined, expired or refused: nothing was added
    try {
      await this.#o.roster.append(add); // verified + fsynced
      const key = (add.body as { signKey: Uint8Array }).signKey;
      await this.#o.admitAtRelay?.(Buffer.from(key).toString('hex'), add);
      await this.#o.afterAdded?.(add);
    } catch {
      // The new device must not hold a welcome for a membership this device could not record.
      return [encode({ t: 'closed' })]; // the joiner reads 'closed' as a failed pairing and can start over
    }
    return out;
  }
}

export class PairingJoiner {
  readonly #nd: NewDevice;
  constructor(identity: DeviceIdentity, invite: { room: Buffer; code: string }, me: { name: string; platform: string }) {
    // normalizeCode throws MeshCryptoError('invalid-code') for a typo: the screen shows "check the code".
    this.#nd = new NewDevice(identity, { room: invite.room, secret: utf8(normalizeCode(invite.code)) }, 'code', me);
  }
  start(): Buffer {
    return this.#nd.start();
  }
  onMessage(bytes: Uint8Array): Buffer[] {
    return this.#nd.onMessage(bytes);
  }
  get sas(): string | undefined {
    return this.#nd.sas;
  }
  get stage(): string {
    return this.#nd.stageName;
  }
  get result(): PairingSuccess | { ok: false; why: string } | null {
    return this.#nd.result;
  }
}

/** Joiner side: make a successful pairing durable. Throws (storing nothing further) if any entry fails verification. */
export async function adoptPairing(success: PairingSuccess, keys: MeshKeyStore, roster: RosterStore): Promise<void> {
  // Keys first, roster second: a kill between them leaves secrets with no roster, which the service reads as "not in a
  // set yet" (it needs both), never a roster whose secrets are missing.
  await keys.update((k) => {
    k.setId = success.setId;
    k.secrets = new Map(success.secrets);
  });
  for (const e of success.roster) await roster.append(e);
}

// ---- The typed code a person reads off one screen and types on the other (design 5.1, T5 C10, threat model P-3).
// It is TWO independent random parts: a 13-symbol MEETING part (65 bits) that names the relay's meeting point, and the 6-symbol
// SECRET (30 bits) that is the PAKE password. WHY independent: the relay sees only SHA-256(meeting part) (the meeting id), so if the
// secret were derived from or contained in it the relay could test guesses offline. As built, the relay can brute-force the
// meeting part (2^65 hashes) and learns nothing about the secret by doing so; the secret can be tested only online, against
// the host, three evaluated tries per code.
export const MEETING_PART_LENGTH = 13;
export const TYPED_CODE_LENGTH = MEETING_PART_LENGTH + 6;

export function newTypedCode(secret: string, meetingPart: string = generateCode(MEETING_PART_LENGTH)): { meetingPart: string; display: string } {
  const all = meetingPart + secret;
  // Groups of four so a person can read it aloud: XXXX-XXXX-XXXX-XXXX-XXX
  return { meetingPart, display: all.match(/.{1,4}/g)!.join('-') };
}
/** Throws MeshCryptoError('invalid-code') for anything that is not exactly 19 symbols of the alphabet (case, spaces, dashes ignored). */
export function parseTypedCode(input: string): { meetingPart: string; secret: string } {
  const all = normalizeCode(input, TYPED_CODE_LENGTH);
  for (const ch of all) if (!CODE_ALPHABET.includes(ch)) throw new MeshCryptoError('invalid-code');
  return { meetingPart: all.slice(0, MEETING_PART_LENGTH), secret: all.slice(MEETING_PART_LENGTH) };
}
