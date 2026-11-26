// Two id spaces (plan "Decisions for you" 1): the WIRE id is what every device uses to name a version; the LOCAL id is the store folder this
// device keeps it in. They are never equal (F3). The store retires a damaged version id for good and never refills it, so a recopy
// needs a new local id while the wire id stays: incarnation n is SHA-256(label || wire id || n), for every n including 0.
//
// WHY derived and probed, not stored: a map file would be one more thing to roll back or lose. The store already remembers which ids are
// retired (three witnesses, inventory limit 5), so the current incarnation is the lowest one whose id is not retired. A retired id is never
// reused (replicator invariant 6): `current` only ever moves up, and a probe that says "retired" for n always moves on to n + 1.
import { createHash } from 'node:crypto';

/** The store's answer to "what is this id": live (registered and usable), absent (never registered), retired. A probe that cannot tell throws, and so does `current`. */
export type Probe = (local: Buffer) => Promise<'live' | 'absent' | 'retired'>;
/** More than this many retirements of one version is not a recopy loop worth continuing: stop loudly. */
export const MAX_INCARNATIONS = 32;

export function incarnationId(wire: Buffer, n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_INCARNATIONS) throw new RangeError('incarnation out of range');
  // WHY EVERY incarnation, the first too, goes through the hash (review 1, F3): when incarnation 0 was the wire id itself, a paired device could announce a version whose
  // wire id equals the victim's incarnation-1 id and have its lines written into the folder that later became the victim's copy. With every local id a domain-separated
  // hash of (wire id, n), no wire id can name another version's folder, and 32 bytes out stay within the store's 64-byte id limit.
  return createHash('sha256').update('youcoded-mesh/v1/incarnation\0').update(wire).update(`\0${n}`).digest();
}

export class IdMap {
  readonly #cache = new Map<string, number>();
  constructor(private readonly probe: Probe) {}
  /** The local id to use now for `wire` (the lowest incarnation that is not retired; it may be absent, meaning "register it here"). */
  async current(wire: Buffer): Promise<{ local: Buffer; incarnation: number; registered: boolean }> {
    const key = wire.toString('hex');
    const start = this.#cache.get(key);
    // WHY the first look in a process scans past the first live incarnation (fuzz seed 605068): incarnations are made one after another, so the CURRENT one is the highest live one before the first
    // absent one. "Lowest not retired" went wrong when a lower incarnation was left live behind a higher one, and a restart then picked the older, shorter copy.
    const scanAll = start === undefined;
    let live: { n: number; local: Buffer } | null = null;
    for (let n = start ?? 0; n <= MAX_INCARNATIONS; n++) {
      const local = incarnationId(wire, n);
      const p = await this.probe(local);
      if (p === 'retired') continue;
      if (p === 'live') { live = { n, local }; if (!scanAll) break; continue; }
      if (live) break;
      this.#cache.set(key, n);
      return { local, incarnation: n, registered: false };
    }
    if (live) { this.#cache.set(key, live.n); return { local: live.local, incarnation: live.n, registered: true }; }
    throw new RangeError('too many retired incarnations');
  }
  /** Call after the store retired `local`: the next `current` starts above it. Only raises. */
  retired(wire: Buffer, incarnation: number): void {
    const key = wire.toString('hex');
    this.#cache.set(key, Math.max(this.#cache.get(key) ?? 0, incarnation + 1));
  }
  forget(): void { this.#cache.clear(); }
}
