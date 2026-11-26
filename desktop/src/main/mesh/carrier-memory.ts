// In-memory carrier for tests: a hub that keeps frames per group (like the relay) and hands each device a Carrier.
// Can be taken offline per device, and can record every stored byte (to assert nothing readable is ever stored).
import type { Carrier } from './link';

export class MemoryHub {
  readonly groups = new Map<string, Array<{ seq: number; bytes: Buffer; from: string }>>();
  readonly lastN = new Map<string, number>(); // `${dev}/${session}` -> highest n, like the relay's per-sender numbering
  readonly members = new Map<string, MemoryCarrier>();
  /** Every byte string ever stored, for "the relay cannot read it" assertions. */
  readonly stored: Buffer[] = [];
  /** Test hook (tests/mesh/replicator-world.ts): what the relay does with a held frame. 'drop' = it says stored and loses it; 'dup' = it stores it twice. Default: store. */
  holdFilter: ((dev: string, group: string, frame: Buffer) => 'store' | 'drop' | 'dup') | null = null;
  /** The relay released everything in a group through this sequence number (it was kept too long): a fetch from below answers `gap`. */
  readonly floor = new Map<string, number>();
  releaseThrough(group: string, seq: number): void {
    this.floor.set(group, Math.max(this.floor.get(group) ?? 0, seq));
    this.groups.set(group, (this.groups.get(group) ?? []).filter((f) => f.seq > seq));
  }
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
  #pass: Array<(g: string, from: string, frame: Buffer) => void> = [];
  /** Test hook for the live lane (the world in tests/mesh/replicator-world.ts): decide what happens to each passed frame. Default: deliver now. */
  passFilter: ((g: string, to: string, frame: Buffer) => 'deliver' | 'drop') | null = null;
  /** Live frames this carrier handed over, for tests that count traffic. */
  passed = 0;
  readonly receivedThrough = new Map<string, number>();
  constructor(private readonly hub: MemoryHub, readonly dev: string) {}
  get connected(): boolean {
    return this.online;
  }
  setOnline(on: boolean): void {
    this.online = on;
    if (on) this.#conn.forEach((cb) => cb());
  }
  async hold(group: string, session: string, n: number, frame: Uint8Array, _line?: boolean): Promise<'stored' | 'duplicate'> {
    if (!this.online) throw new Error('offline');
    const key = `${this.dev}/${session}`;
    if (n <= (this.hub.lastN.get(key) ?? 0)) return 'duplicate';
    this.hub.lastN.set(key, n);
    const verdict = this.hub.holdFilter ? this.hub.holdFilter(this.dev, group, Buffer.from(frame)) : 'store';
    if (verdict === 'drop') return 'stored';
    const list = this.hub.groups.get(group) ?? [];
    // WHY the next sequence number counts released frames too: the relay never reuses a number
    const nextSeq = (): number => Math.max(this.hub.floor.get(group) ?? 0, list.length ? list[list.length - 1].seq : 0) + 1;
    for (let i = 0; i < (verdict === 'dup' ? 2 : 1); i++) list.push({ seq: nextSeq(), bytes: Buffer.from(frame), from: this.dev });
    this.hub.groups.set(group, list);
    this.hub.stored.push(Buffer.from(frame));
    return 'stored';
  }
  async fetchAfter(group: string, seq: number): Promise<{ frames: Array<{ seq: number; bytes: Buffer; writer: string }>; more: boolean; gap?: { through: number } }> {
    if (!this.online) throw new Error('offline');
    const floor = this.hub.floor.get(group) ?? 0;
    if (seq < floor) return { frames: [], more: false, gap: { through: floor } };
    return { frames: (this.hub.groups.get(group) ?? []).filter((f) => f.seq > seq).map((f) => ({ seq: f.seq, bytes: Buffer.from(f.bytes), writer: f.from })), more: false };
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
  /** Like the relay's `pass`: to one connected device or to all of them; never stored; offline devices simply miss it. */
  pass(group: string, to: string, frame: Uint8Array): boolean {
    if (!this.online) return false;
    const copy = Buffer.from(frame);
    if (this.passFilter && this.passFilter(group, to, copy) === 'drop') return true; // WHY true: the relay does not tell the sender about a lost pass either
    this.passed++;
    for (const [dev, c] of this.hub.members) {
      if (dev === this.dev || !c.online) continue;
      if (to !== 'all' && c.deviceHex !== to) continue;
      // WHY a macrotask: a real pass arrives on another socket, never inside the sender's own call stack.
      setTimeout(() => c.#pass.forEach((cb) => cb(group, this.deviceHex ?? this.dev, Buffer.from(copy))), 0);
    }
    return true;
  }
  /** The 32-hex device id the relay would stamp; tests that address one device by id set it. Falls back to the hub name. */
  deviceHex: string | null = null;
  onPass(cb: (g: string, from: string, frame: Buffer) => void): void {
    this.#pass.push(cb);
  }
  onConnected(cb: () => void): void {
    this.#conn.push(cb);
  }
}
