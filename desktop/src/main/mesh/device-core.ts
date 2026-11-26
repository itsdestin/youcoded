// The device layer's decisions as ONE pure-ish unit, used by MeshService and (unchanged) by the convergence fuzz: which roster entries
// are known, parked or wanted; which generation (shared secret) is current; who must make the next one and when; who still lacks one.
// No sockets, no files (the roster store may be in memory), no clocks of its own: `now` is always passed in.
//
// CONVERGENCE BY CONSTRUCTION (review 2, N1-N3, N7, N8; T5 gaps G6-G8). Three rules carry it:
//  1. ROSTER = f(set of signed entries) (crypto/roster.ts). Order, duplicates and arrival time cannot matter. Entries that cannot be
//     judged yet (their ancestors or their signer's introduction have not arrived) are PARKED here, bounded per delivering member so
//     nobody can push another member's entries out, and their missing ancestors are ASKED FOR (`wanted`), never dropped.
//  2. ANTI-ENTROPY: every device announces its heads; a device that sees a peer lacking entries it holds sends them, and asks for heads it
//     does not know. So an entry that never left its author (killed app, dropped frame) still reaches everyone: nothing is "delivered
//     once and forgotten" (N1).
//  3. GENERATIONS are keyed by the removed set they were made for (crypto/generation.ts). A device's CURRENT secret is the one made for
//     exactly the removals its roster holds, from the lowest-id minter it holds. Who makes it is derived, not raced: members ranked by
//     id; rank k acts after k x takeoverMs without a current secret (takeover). If two honest devices both make one, every member
//     receives both and all use the same one. A device that learns of one more removal simply has no current secret until one for the
//     larger set arrives, and seals nothing new in between (so a removed device never reads anything sent after the removal is known).
//     Any holder may re-seal the SAME secret to a member the minter did not seal to (a concurrent add), checked by the signed commitment.
import { toHex } from './crypto/bytes';
import { asMap } from './crypto/cbor';
import { MeshCryptoError } from './crypto/errors';
import { type DeviceIdentity } from './crypto/identity';
import { openSecret, sealSecretTo } from './crypto/keygen';
import { newSetSecret } from './crypto/keys';
import { encodeStatement, parseStatement, removedKey, secretMatches, signStatement, verifyStatement, type GenStatement } from './crypto/generation';
import { makeHelloEntry, seenForNextEntry, type SignedEntry } from './crypto/roster';
import { MeshRosterRejected, type RosterStore } from './roster-store';
import type { CborValue } from './crypto/cbor';
import { KIND_HEADS, KIND_NEED, KIND_REMOVAL, KIND_ROSTER, headsBody, needBody, parseHeadsBody, parseNeedBody, parseRemovalBody, parseRosterBody, removalBody, rosterBody } from './wire';

export interface GenHeld { stmt: GenStatement | null; secret: Buffer }
export interface Bundle { entries: SignedEntry[]; stmt: Buffer; sealed: Map<string, Buffer> }
/** A frame this device wants sent to the roster group (`to`: just that device). The link seals it. */
export interface Out {
  kind: string;
  body: CborValue;
  to?: Buffer;
  /** Must be readable by a device that has been (or is being) removed: sealed under the oldest secret. Only removal bundles, removal entries and the
   *  removal-proof answers to a removed device are wide; everything else is sealed under the secret made for the removals this device knows of, so a
   *  removed device cannot read it (third review, finding 7). */
  wide?: true;
}
export type BundleVerdict = 'accepted' | 'noop' | 'wait' | `reject:${string}`;

const MAX_PARKED_PER_SENDER = 128;
const MAX_PARKED_TOTAL = 1024;
// WHY these numbers (third review, "heads amplification"): a 14-byte `heads` frame used to make a device send 55-100 KiB back with no limit, and forty of
// them filled the roster group's quota at the relay. Now each PEER may cost this device at most REPLY_ENTRIES entries and REPLY_FRAMES answer frames per
// REPLY_WINDOW_MS, whatever it sends, and no single answer carries more than REPLY_ENTRIES_PER_FRAME entries. A long honest catch-up simply takes a few windows.
const REPLY_WINDOW_MS = 30_000;
const REPLY_ENTRIES = 512;
const REPLY_FRAMES = 16;
const REPLY_ENTRIES_PER_FRAME = 128;
const REPLY_BUNDLES = 32;
const MAX_STALE_PER_MINTER = 8;
const MAX_HELD = 256;
const MAX_REPLY_ENTRIES = 512;
const MAX_STMT_ENTRIES = 8;

const waitable = (e: MeshCryptoError): boolean => e.code === 'bad-roster' && /signer not yet|unknown or later/.test(e.message);

export class GenBook {
  readonly held = new Map<number, GenHeld>();
  /** label -> devices (hex) a bundle was seen sealed to (so a holder knows who may still lack it). Memory only. */
  readonly sealedTo = new Map<number, Set<string>>();
  dirty = false;
  set(label: number, h: GenHeld): void {
    this.held.set(label, h);
    this.dirty = true;
  }
  secrets(): Map<number, Buffer> {
    return new Map([...this.held].map(([l, h]) => [l, h.secret]));
  }
}

export class DeviceCore {
  readonly parked = new Map<string, { entry: SignedEntry; from: string }>();
  readonly firstSeen = new Map<string, number>();
  /** Counts for status/tests. */
  readonly counts: Record<string, number> = {};
  /** The last `now` this core was given (its only clock): onMessage uses it for the reply budget. */
  private clock = 0;
  private readonly replies = new Map<string, { t0: number; entries: number; frames: number; bundles: number }>();
  constructor(readonly o: { identity: DeviceIdentity; setId: Buffer; roster: RosterStore; book: GenBook; takeoverMs: number }) {}
  private count(k: string): void {
    this.counts[k] = (this.counts[k] ?? 0) + 1;
  }
  private get me(): string {
    return toHex(this.o.identity.deviceId);
  }

  // ------------------------------------------------------------ roster entries
  /** Take entries delivered by member `from` (hex): append what fits, park what cannot be judged yet. Returns whether anything was appended. */
  async takeEntries(entries: SignedEntry[], from: string): Promise<{ appended: boolean; wanted: Buffer[] }> {
    let appended = false;
    const pending: SignedEntry[] = [...entries];
    for (let round = 0; round < 64; round++) {
      let progress = false;
      const next: SignedEntry[] = [];
      for (const e of pending) {
        try {
          if ((await this.o.roster.append(e, { remote: true, from })) === 'appended') { appended = true; progress = true; }
          this.parked.delete(toHex(e.id));
        } catch (err) {
          if (err instanceof MeshRosterRejected) { this.count(`rejected-${err.why}`); continue; }
          if (err instanceof MeshCryptoError && waitable(err)) { next.push(e); continue; }
          if (err instanceof MeshCryptoError) { this.count(`invalid-${err.code}`); continue; }
          throw err;
        }
      }
      // the entries that waited might fit now; entries parked earlier get another look when something was appended
      if (progress) for (const p of this.parked.values()) if (!next.some((x) => x.id.equals(p.entry.id))) next.push(p.entry);
      pending.length = 0;
      pending.push(...next);
      if (!progress) break;
    }
    for (const e of pending) this.park(e, from);
    return { appended, wanted: this.wanted() };
  }
  private park(e: SignedEntry, from: string): void {
    const k = toHex(e.id);
    if (this.parked.has(k)) return;
    // WHY per sender and never evicting another's (review N4): a member can only fill its own allowance.
    // CAP INVARIANT (roster.ts): the allowance is per delivering member and a member over it loses only its own. When the TOTAL is full, the member holding
    // the MOST loses its oldest (or, if that is the one delivering now, the new entry is dropped): a member with a small share is never the victim.
    const counts = new Map<string, number>();
    for (const p of this.parked.values()) counts.set(p.from, (counts.get(p.from) ?? 0) + 1);
    if ((counts.get(from) ?? 0) >= MAX_PARKED_PER_SENDER) { this.count('park-refused'); return; }
    if (this.parked.size >= MAX_PARKED_TOTAL) {
      let top = from;
      let topN = counts.get(from) ?? 0;
      for (const [who, n] of counts) if (n > topN) { top = who; topN = n; }
      if (top === from) { this.count('park-refused'); return; }
      for (const [id, p] of this.parked) if (p.from === top) { this.parked.delete(id); break; }
      this.count('park-evicted-largest');
    }
    this.parked.set(k, { entry: e, from });
  }
  /** Ids of entries some parked entry cites that we hold neither as entry nor parked: ask for these. */
  wanted(): Buffer[] {
    const out = new Map<string, Buffer>();
    for (const { entry } of this.parked.values()) for (const s of entry.seen) {
      const k = toHex(s);
      if (!this.o.roster.has(s) && !this.parked.has(k)) out.set(k, s);
    }
    return [...out.values()].slice(0, 64);
  }
  /** Entries (with ancestors we hold) that answer a request for `ids`, NEAREST FIRST: the asked entries, then their parents, and so on.
   *  WHY not in log order (third review): an answer is cut to a few hundred entries per window, and a device that asks for what it lacks already holds the
   *  oldest part of the log, so log order would send it the same old entries every time and never the ones it asked for. */
  answerNeed(ids: Buffer[]): SignedEntry[] {
    const seen = new Set<string>();
    const out: SignedEntry[] = [];
    const queue = ids.filter((i) => this.o.roster.has(i)).map((i) => toHex(i));
    for (let qi = 0; qi < queue.length && out.length < MAX_REPLY_ENTRIES; qi++) {
      const k = queue[qi];
      if (seen.has(k)) continue;
      seen.add(k);
      const e = this.o.roster.entryById(Buffer.from(k, 'hex'));
      if (!e) continue;
      out.push(e);
      for (const x of e.seen) queue.push(toHex(x));
    }
    return out;
  }
  heads(): Buffer[] {
    return this.o.roster.heads().slice(0, 64);
  }
  /** A peer announced its heads: what to ask it for, and which of our entries it lacks. */
  onPeerHeads(heads: Buffer[]): { want: Buffer[]; send: SignedEntry[] } {
    const want = heads.filter((h) => !this.o.roster.has(h) && !this.parked.has(toHex(h))).slice(0, 64);
    const v = this.o.roster.verified;
    const known = heads.filter((h) => this.o.roster.has(h));
    const send = this.o.roster.entries.filter((e) => !known.some((h) => h.equals(e.id) || (v?.happenedBefore(e.id, h) ?? false))).slice(0, MAX_REPLY_ENTRIES);
    return { want, send };
  }
  /** After joining: sign the first entry of our own (once). Null when there is nothing to do. */
  async ensureHello(now: number): Promise<SignedEntry | null> {
    const r = this.o.roster;
    if (r.size === 0 || r.confirmedIds().has(this.me) || !r.activeDevices().some((d) => toHex(d.deviceId) === this.me)) return null;
    if (r.entries.some((e) => e.kind === 'hello' && e.device.equals(this.o.identity.deviceId))) return null;
    const e = makeHelloEntry(this.o.identity, seenForNextEntry(r.entries, this.o.identity.deviceId), now);
    await r.append(e);
    return e;
  }

  // ------------------------------------------------------------ generations
  private removedHex(): string[] {
    return [...this.o.roster.excludedIds()];
  }
  /** The label new frames are sealed under, or null when none for the current removals is held yet. */
  currentLabel(): number | null {
    const key = removedKey(this.removedHex().map((h) => Buffer.from(h, 'hex')));
    const active = new Set(this.o.roster.activeDevices().map((d) => toHex(d.deviceId)));
    let best: { label: number; minter: string } | null = null;
    for (const [label, h] of this.o.book.held) {
      // WHY the minter must be a member NOW: a secret made by a device whose admission later turned out void (or that was removed) is not
      // trusted as current, so it can neither split the members nor stay in the hands of a device that is no longer one of them.
      if (!h.stmt || removedKey(h.stmt.removed) !== key || !active.has(toHex(h.stmt.minter))) continue;
      const minter = toHex(h.stmt.minter);
      if (!best || minter < best.minter) best = { label, minter };
    }
    return best ? best.label : null;
  }
  /** Labels held that were made for exactly the removals this device knows of (at most 16). */
  currentLabels(): number[] {
    const key = removedKey(this.removedHex().map((h) => Buffer.from(h, 'hex')));
    const out: number[] = [];
    const active = new Set(this.o.roster.activeDevices().map((d) => toHex(d.deviceId)));
    for (const [label, h] of this.o.book.held) if (h.stmt && removedKey(h.stmt.removed) === key && active.has(toHex(h.stmt.minter))) out.push(label);
    return out.slice(0, 16);
  }
  /** Oldest label held: control traffic every member can read (it carries no secret in the clear). */
  oldestLabel(): number | null {
    let g: number | null = null;
    for (const l of this.o.book.held.keys()) if (g === null || l < g) g = l;
    return g;
  }
  private isActiveSelf(): boolean {
    return this.o.roster.activeDevices().some((d) => toHex(d.deviceId) === this.me);
  }
  /** Who makes the next secret, in order: confirmed members by id, then pending ones. */
  private ranking(): string[] {
    const r = this.o.roster;
    const conf = r.confirmedIds();
    const act = r.activeDevices().map((d) => toHex(d.deviceId)).sort();
    return [...act.filter((a) => conf.has(a)), ...act.filter((a) => !conf.has(a))];
  }
  /** Bundles to send now (a new secret if it is our turn, re-sealing for members that lack one) and the time to look again. */
  plan(now: number): { bundles: Bundle[]; nextAt: number | null } {
    const r = this.o.roster;
    const bundles: Bundle[] = [];
    if (r.size === 0 || !this.isActiveSelf() || this.o.book.held.size === 0) return { bundles, nextAt: null };
    let nextAt: number | null = null;
    const key = removedKey(this.removedHex().map((h) => Buffer.from(h, 'hex')));
    if (this.currentLabel() === null) {
      const first = this.firstSeen.get(key) ?? now;
      this.firstSeen.set(key, first);
      const k = this.ranking().indexOf(this.me);
      const due = first + Math.max(0, k) * this.o.takeoverMs;
      if (now >= due) bundles.push(this.mint());
      else nextAt = due;
    } else {
      for (const [label, h] of this.o.book.held) {
        if (!h.stmt || removedKey(h.stmt.removed) !== key || h.stmt.removed.length === 0 || !r.activeDevices().some((d) => d.deviceId.equals((h.stmt as GenStatement).minter))) continue;
        const have = new Set(h.stmt.members.map((m) => toHex(m)));
        for (const s of this.o.book.sealedTo.get(label) ?? []) have.add(s);
        const targets = r.activeDevices().filter((d) => !have.has(toHex(d.deviceId)) && toHex(d.deviceId) !== this.me);
        if (targets.length) bundles.push(this.sealFor(label, targets.map((d) => toHex(d.deviceId))));
      }
    }
    return { bundles, nextAt };
  }
  private mint(): Bundle {
    const r = this.o.roster;
    const act = r.activeDevices();
    const removed = this.removedHex().map((h) => Buffer.from(h, 'hex'));
    const secret = newSetSecret();
    const stmt = signStatement(this.o.identity, { set: this.o.setId, removed, members: act.map((d) => d.deviceId), secret });
    this.o.book.set(stmt.label, { stmt, secret });
    const b = this.sealFor(stmt.label, act.map((d) => toHex(d.deviceId)).filter((d) => d !== this.me));
    // The removals themselves ride along so a receiver that has not heard of them can apply them first.
    const ents: SignedEntry[] = [];
    for (const t of removed) for (const id of r.removalIdsOf(toHex(t))) { const e = r.entryById(Buffer.from(id, 'hex')); if (e && ents.length < MAX_STMT_ENTRIES) ents.push(e); }
    b.entries = ents;
    return b;
  }
  private sealFor(label: number, to: string[]): Bundle {
    const h = this.o.book.held.get(label) as GenHeld;
    const sealed = new Map<string, Buffer>();
    const sealedSet = this.o.book.sealedTo.get(label) ?? new Set<string>();
    for (const d of to) {
      const dev = this.o.roster.verified?.devices.get(d);
      if (!dev) continue;
      sealed.set(d, sealSecretTo(dev.agreeKey, this.o.setId, label, h.secret, this.o.identity.deviceId, dev.deviceId));
      sealedSet.add(d);
    }
    this.o.book.sealedTo.set(label, sealedSet);
    return { entries: [], stmt: encodeStatement(h.stmt as GenStatement), sealed };
  }
  /** A member asked for generations it could not open: re-seal them (same secrets) to it. */
  answerGenNeed(labels: number[], requester: string): Bundle[] {
    const dev = this.o.roster.verified?.devices.get(requester);
    if (!dev || this.o.roster.isRemoved(Buffer.from(requester, 'hex'))) return [];
    const out: Bundle[] = [];
    for (const l of labels.slice(0, 8)) if (this.o.book.held.get(l)?.stmt) out.push(this.sealFor(l, [requester]));
    return out;
  }

  /** Judge a received bundle (the frame's sender `from` is already a verified current member). */
  acceptBundle(b: Bundle, from: Buffer): BundleVerdict {
    const r = this.o.roster;
    let stmt: GenStatement;
    try { stmt = parseStatement(b.stmt); } catch { return 'reject:bad-statement'; }
    const v = r.verified;
    const minterDev = v?.devices.get(toHex(stmt.minter));
    if (!v || !minterDev) return 'wait';
    const creator = r.entries[0] ? (asMap(r.entries[0].body, 'add').signKey as Buffer) : undefined;
    if (!verifyStatement(stmt, minterDev.signKey, this.o.setId, creator)) return 'reject:bad-statement';
    const removedNow = r.excludedIds();
    for (const x of stmt.removed) if (!removedNow.has(toHex(x))) return 'wait'; // we have not heard of that removal yet
    // (the member list is not checked against this roster: it can name devices whose admission turned out void here, and waiting for them
    // would wait forever; what protects the receiver is that the minter is a member here and the removed set matches)
    const sealedSet = this.o.book.sealedTo.get(stmt.label) ?? new Set<string>();
    for (const k of b.sealed.keys()) sealedSet.add(k);
    this.o.book.sealedTo.set(stmt.label, sealedSet);
    const mine = b.sealed.get(this.me);
    if (!mine) return 'noop';
    if (this.o.book.held.get(stmt.label)?.stmt) return 'noop';
    // bounds: a member cannot make us keep an unbounded number of stale secrets
    const current = removedKey(stmt.removed) === removedKey([...removedNow].map((h) => Buffer.from(h, 'hex')));
    if (!current) {
      let byMinter = 0;
      for (const h of this.o.book.held.values()) if (h.stmt && h.stmt.minter.equals(stmt.minter)) byMinter++;
      if (byMinter >= MAX_STALE_PER_MINTER || this.o.book.held.size >= MAX_HELD) return 'reject:too-many-generations';
    }
    let secret: Buffer;
    try { secret = openSecret(this.o.identity.agreeSecret, mine, this.o.setId, stmt.label, from, this.o.identity.deviceId); } catch { return 'reject:bad-blob'; }
    if (!secretMatches(stmt, secret)) return 'reject:bad-commit';
    this.o.book.set(stmt.label, { stmt, secret });
    return 'accepted';
  }
  /** Joiner: take the secrets and statements a welcome carried; statements that do not check out are dropped (the secret is kept for reading only). */
  adoptWelcome(secrets: Map<number, Buffer>, stmts: Map<number, Buffer>): void {
    const v = this.o.roster.verified;
    const creator = this.o.roster.entries[0] ? (asMap(this.o.roster.entries[0].body, 'add').signKey as Buffer) : undefined;
    for (const [label, secret] of secrets) {
      let stmt: GenStatement | null = null;
      const raw = stmts.get(label);
      if (raw) {
        try {
          const s = parseStatement(raw);
          const mk = v?.devices.get(toHex(s.minter));
          if (mk && s.label === label && verifyStatement(s, mk.signKey, this.o.setId, creator) && secretMatches(s, secret)) stmt = s;
        } catch { /* benign: a statement that does not parse or verify is simply not adopted; the secret itself is kept and the statement can be asked for again */ }
      }
      this.o.book.set(label, { stmt, secret });
    }
  }
  // ------------------------------------------------------------ the glue: one received frame in, frames to send out
  /**
   * Handle one verified frame of the roster group from member `from`. Returns the frames to send in answer and whether the frame must
   * wait ('wait': it rests on roster entries not held yet) or is refused ('reject'). The same code the service runs.
   */
  async onMessage(kind: string, body: unknown, from: Buffer, now?: number): Promise<{ out: Out[]; wait?: true; reject?: string; changed: boolean }> {
    const out: Out[] = [];
    const fromHex = toHex(from);
    if (now !== undefined) this.clock = now;
    // Entries are signed one by one, so roster entries are taken from ANY known device, a removed one included (otherwise two devices that
    // removed each other at the same moment would never learn of each other's removal), and so are the requests for entries that ask for
    // nothing secret (heads, need: they let a removed device learn that it was removed); a generation bundle only from an active member.
    if (!this.o.roster.knownSignKeyFor(from)) return { out, reject: 'sender-not-a-member', changed: false };
    if (kind === KIND_REMOVAL && !this.o.roster.signKeyFor(from)) return { out, reject: 'signer-not-a-member', changed: false };
    let changed = false;
    if (kind === KIND_ROSTER) {
      const r = await this.takeEntries(parseRosterBody(body), fromHex);
      changed = r.appended;
    } else if (kind === KIND_REMOVAL) {
      const b = parseRemovalBody(body);
      const before = this.o.roster.size;
      await this.takeEntries(b.entries, fromHex);
      const v = this.acceptBundle({ entries: b.entries, stmt: b.stmt, sealed: b.sealed }, from);
      changed = this.o.roster.size !== before || v === 'accepted';
      if (v === 'wait') return { out, wait: true, changed };
      if (v.startsWith('reject:')) {
        if (v === 'reject:bad-blob') { try { out.push({ kind: KIND_NEED, body: needBody([], [parseStatement(b.stmt).label]) }); } catch { /* benign: a blob that is not even a statement has no label to ask for; the reject itself is still answered */ } }
        return { out, reject: v.slice(7), changed };
      }
    } else if (kind === KIND_HEADS) {
      const hb = parseHeadsBody(body);
      if (this.peerGens.size < 256 || this.peerGens.has(fromHex)) this.peerGens.set(fromHex, hb.gens.slice(0, 64));
      const { want, send } = this.onPeerHeads(hb.heads);
      // A REMOVED asker is told only what proves its removal. A member that does not yet hold our current secret (it is BEHIND: it has not heard of the
      // removal, and cannot read anything sealed under the new secret, including the entries its acceptance of the removal bundle waits for) is answered
      // under the first secret every member holds ("wide"), with everything it lacks: it needs the whole set to judge the removal the way we do, so its
      // answer cannot be cut down to a "proof" (a view built from a proof alone can be wrong, and it never converges). The cost: for as long as a member is
      // behind, what it lacks is readable by a removed device that is still listening. That is the honest limit of "wide".
      const removedAsker = this.o.roster.isRemoved(from);
      const wideAsker = removedAsker || this.behind(fromHex);
      // a current secret this member lacks (a bundle that never reached it): re-seal it, same secret, to that member (never to a removed one: answerGenNeed refuses)
      for (const b of this.answerGenNeed(this.currentLabels().filter((l) => !hb.gens.includes(l)), fromHex)) if (this.spendBundle(fromHex)) out.push({ kind: KIND_REMOVAL, body: removalBody(b), to: from, wide: true });
      const ents = removedAsker ? this.removalProof(send) : send;
      const n = this.spend(fromHex, Math.min(ents.length, REPLY_ENTRIES_PER_FRAME), 1);
      if (ents.length && n > 0) out.push({ kind: KIND_ROSTER, body: rosterBody(ents.slice(0, n)), to: from, ...(wideAsker ? { wide: true as const } : {}) });
      else if (ents.length) this.count('reply-throttled');
      if (want.length) out.push({ kind: KIND_NEED, body: needBody(want), to: from, ...(wideAsker ? { wide: true as const } : {}) });
    } else if (kind === KIND_NEED) {
      const n = parseNeedBody(body);
      const removedAsker = this.o.roster.isRemoved(from);
      const wideAsker = removedAsker || this.behind(fromHex);
      const all = this.answerNeed(n.want);
      const ents = removedAsker ? this.removalProof(all) : all;
      const k = this.spend(fromHex, Math.min(ents.length, REPLY_ENTRIES_PER_FRAME), 1);
      if (ents.length && k > 0) out.push({ kind: KIND_ROSTER, body: rosterBody(ents.slice(0, k)), to: from, ...(wideAsker ? { wide: true as const } : {}) });
      else if (ents.length) this.count('reply-throttled');
      for (const b of this.answerGenNeed(n.gens, fromHex)) if (this.spendBundle(fromHex)) out.push({ kind: KIND_REMOVAL, body: removalBody(b), to: from, wide: true });
    }
    return { out, changed };
  }
  /** Charge one peer's reply budget: returns how many of `entries` it may be sent now (0 when the window is used up), and counts `frames` frames.
   *  WHY here and not at the link: the amplification is a DEVICE decision (what to send back), so the limit lives with it, per asking peer. */
  /** Re-sealed bundles are small but each costs a seal: a peer gets at most REPLY_BUNDLES per window. */
  private spendBundle(peer: string): boolean {
    this.spend(peer, 0, 0);
    const b = this.replies.get(peer) as { bundles: number };
    if (b.bundles >= REPLY_BUNDLES) return false;
    b.bundles++;
    return true;
  }
  private spend(peer: string, entries: number, frames: number): number {
    let b = this.replies.get(peer);
    if (!b || this.clock - b.t0 >= REPLY_WINDOW_MS) { b = { t0: this.clock, entries: 0, frames: 0, bundles: 0 }; this.replies.set(peer, b); }
    if (this.replies.size > 256) for (const [k, v] of this.replies) if (this.clock - v.t0 >= REPLY_WINDOW_MS) this.replies.delete(k);
    if (b.frames + frames > REPLY_FRAMES) return 0;
    const grant = Math.min(entries, REPLY_ENTRIES - b.entries);
    if (entries > 0 && grant <= 0) return 0;
    b.entries += grant;
    b.frames += frames;
    return entries === 0 ? 1 : grant;
  }
  /** True when a member does not (as far as we know) hold the secret made for the removals we know of: it has not caught up with them yet.
   *  WHY (third review, finding 7): control frames now use the secret that excludes removed devices, so a device that is behind cannot read them, and
   *  the removal bundle that would catch it up needs entries that only such frames carry. Such a member is answered under the first secret, with the proof only. */
  private behind(peerHex: string): boolean {
    if (this.o.roster.removedIds().size === 0 && this.o.roster.excludedIds().size === 0) return false;
    const cur = this.currentLabels();
    if (cur.length === 0) return true; // we know of removals and hold no secret that excludes them yet: nobody can be given more than the proof
    // WHY the peer's own list of secrets it holds (its last `heads`), and not whether the secret was made FOR it: a member the secret was made for may
    // still lack it (the bundle was lost, or this device restarted), and then everything sealed under it is unreadable to that member, including the
    // entries its acceptance of the bundle waits for. Unknown (no heads seen yet) counts as behind: the proof costs nothing and the first heads settle it.
    const known = this.peerGens.get(peerHex);
    return !known || !cur.some((l) => known.includes(l));
  }
  private readonly peerGens = new Map<string, number[]>();
  /** What a removed or behind device may still be told: only the entries that prove the removals (each removal and everything before it), so it learns
   *  it is out (or catches up) and learns nothing about what happened afterwards. */
  private removalProof(entries: SignedEntry[]): SignedEntry[] {
    const allowed = new Set<string>();
    const stack: string[] = [];
    for (const t of this.o.roster.excludedIds()) {
      stack.push(...this.o.roster.removalIdsOf(t));
      // WHY also the entry that introduced each excluded device: a secret's statement lists every device excluded when it was made (ghosts whose admission is
      // void included), and a receiver waits until it knows each of them, so it must be able to get those `add` entries (and what they rest on).
      const intro = this.o.roster.introductionOf(Buffer.from(t, 'hex'));
      if (intro) stack.push(toHex(intro.id));
    }
    while (stack.length) {
      const k = stack.pop() as string;
      if (allowed.has(k)) continue;
      allowed.add(k);
      const e = this.o.roster.entryById(Buffer.from(k, 'hex'));
      if (e) for (const x of e.seen) stack.push(toHex(x));
    }
    return entries.filter((e) => allowed.has(toHex(e.id)));
  }
  /** Run after any change and now and then: say hello once, make or re-seal secrets when it is our turn, ask for missing entries, and (when
   *  `announce`) say which roster entries we hold. `nextAt` is when to look again for a turn that has not come yet. */
  async tick(now: number, announce: boolean): Promise<{ out: Out[]; nextAt: number | null }> {
    this.clock = now;
    const out: Out[] = [];
    // A device that sees itself removed makes no secrets and says no hello, but still asks for the entries it is missing and announces what it
    // holds: the removal it sees may turn out to have no effect, and it must be able to find that out.
    const quiet = this.o.roster.isRemoved(this.o.identity.deviceId);
    const hello = quiet ? null : await this.ensureHello(now);
    if (hello) out.push({ kind: KIND_ROSTER, body: rosterBody([hello]) });
    const plan = quiet ? { bundles: [], nextAt: null } : this.plan(now);
    for (const b of plan.bundles) if (b.sealed.size > 0) out.push({ kind: KIND_REMOVAL, body: removalBody(b), wide: true });
    // WHY also when the set of current secrets changed (third review, finding 7): peers answer a member that lacks the current secret with the removal proof
    // only (they remember which secrets each peer last said it holds), so a device that has just taken the new secret says so at once.
    const gensNow = this.currentLabels().join(',');
    if (announce || gensNow !== this.gensSent) out.push({ kind: KIND_HEADS, body: headsBody(this.heads(), this.currentLabels()) });
    this.gensSent = gensNow;
    const wanted = this.wanted();
    if (wanted.length && (announce || wanted.length !== this.wantedSent)) out.push({ kind: KIND_NEED, body: needBody(wanted) });
    this.wantedSent = wanted.length;
    return { out, nextAt: plan.nextAt };
  }
  wantedSent = 0;
  private gensSent = '';

  /** Genesis: the secret made with the set. */
  genesis(): void {
    const secret = newSetSecret();
    const stmt = signStatement(this.o.identity, { set: this.o.setId, removed: [], members: [this.o.identity.deviceId], secret });
    this.o.book.set(stmt.label, { stmt, secret });
  }
}
