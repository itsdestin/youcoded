// In-memory carrier for tests: a hub that keeps frames per group (like the relay) and hands each device a Carrier.
// Can be taken offline per device, and can record every stored byte (to assert nothing readable is ever stored).
import type { Carrier } from './link';

export class MemoryHub {
  readonly groups = new Map<string, Array<{ seq: number; bytes: Buffer; from: string }>>();
  readonly lastN = new Map<string, number>(); // `${dev}/${session}` -> highest n, like the relay's per-sender numbering
  readonly members = new Map<string, MemoryCarrier>();
  /** Every byte string ever stored, for "the relay cannot read it" assertions. */
  readonly stored: Buffer[] = [];
  carrier(dev: string): MemoryCarrier {
    const c = new MemoryCarrier(this, dev);
    this.members.set(dev, c);
    return c;
  }
}

export class MemoryCarrier implements Carrier {
  online = true;
  #ring: Array<(g: string) => void> = [];
  #conn: Array<() => void> = [];
  readonly receivedThrough = new Map<string, number>();
  constructor(private readonly hub: MemoryHub, readonly dev: string) {}
  get connected(): boolean {
    return this.online;
  }
  setOnline(on: boolean): void {
    this.online = on;
    if (on) this.#conn.forEach((cb) => cb());
  }
  async hold(group: string, session: string, n: number, frame: Uint8Array): Promise<'stored' | 'duplicate'> {
    if (!this.online) throw new Error('offline');
    const key = `${this.dev}/${session}`;
    if (n <= (this.hub.lastN.get(key) ?? 0)) return 'duplicate';
    this.hub.lastN.set(key, n);
    const list = this.hub.groups.get(group) ?? [];
    list.push({ seq: list.length + 1, bytes: Buffer.from(frame), from: this.dev });
    this.hub.groups.set(group, list);
    this.hub.stored.push(Buffer.from(frame));
    return 'stored';
  }
  async fetchAfter(group: string, seq: number): Promise<{ frames: Array<{ seq: number; bytes: Buffer }>; more: boolean }> {
    if (!this.online) throw new Error('offline');
    return { frames: (this.hub.groups.get(group) ?? []).filter((f) => f.seq > seq).map((f) => ({ seq: f.seq, bytes: Buffer.from(f.bytes) })), more: false };
  }
  async received(group: string, seq: number): Promise<void> {
    this.receivedThrough.set(group, seq);
  }
  ring(group: string): void {
    for (const [dev, c] of this.hub.members) if (dev !== this.dev && c.online) c.#ring.forEach((cb) => cb(group));
  }
  onRing(cb: (g: string) => void): void {
    this.#ring.push(cb);
  }
  onConnected(cb: () => void): void {
    this.#conn.push(cb);
  }
}
