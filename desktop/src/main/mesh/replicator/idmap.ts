// Two id spaces (plan "Decisions for you" 1): the WIRE id is what every device uses to name a version; the LOCAL id is the store folder this
// device keeps it in. They are equal for incarnation 0. The store retires a damaged version id for good and never refills it, so a recopy
// needs a new local id while the wire id stays: incarnation n >= 1 is SHA-256(label || wire id || n).
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
  if (n === 0) return Buffer.from(wire);
  // WHY the incarnation number as text: a fixed, unambiguous byte string; 32 bytes out, within the store's 64-byte id limit.
  return createHash('sha256').update('youcoded-mesh/v1/incarnation\0').update(wire).update(`\0${n}`).digest();
}

export class IdMap {
  readonly #cache = new Map<string, number>();
  constructor(private readonly probe: Probe) {}
  /** The local id to use now for `wire` (the lowest incarnation that is not retired; it may be absent, meaning "register it here"). */
  async current(wire: Buffer): Promise<{ local: Buffer; incarnation: number; registered: boolean }> {
    const key = wire.toString('hex');
    for (let n = this.#cache.get(key) ?? 0; n <= MAX_INCARNATIONS; n++) {
      const local = incarnationId(wire, n);
      const p = await this.probe(local);
      if (p === 'retired') continue;
      this.#cache.set(key, n);
      return { local, incarnation: n, registered: p === 'live' };
    }
    throw new RangeError('too many retired incarnations');
  }
  /** Call after the store retired `local`: the next `current` starts above it. Only raises. */
  retired(wire: Buffer, incarnation: number): void {
    const key = wire.toString('hex');
    this.#cache.set(key, Math.max(this.#cache.get(key) ?? 0, incarnation + 1));
  }
  forget(): void { this.#cache.clear(); }
}
