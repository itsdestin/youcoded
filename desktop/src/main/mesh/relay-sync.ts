// What this device still owes the relay, kept on disk so a kill or a restart cannot lose it (review finding 1).
//
// A roster change is a TWO-STEP: the device writes the signed entry to its own log, then tells the relay (a signed statement) so the relay
// will let the new device in / cut the removed device off. The relay can be unreachable or can refuse at any moment, so the second step is a
// durable queue: `pending` lists the ids of this device's own entries the relay has not yet accepted, in log order. The service drains it
// whenever the relay is reachable and shows "removal pending" for a pending removal (status().removalsPending).
//
// `acked` is the id of this device's most recent entry the relay accepted. WHY: the relay judges a statement by its stated ancestry, which
// must lead back to the signer's own introduction through entries THE RELAY HAS HEARD OF. The statement's `seen` is therefore built from the
// introduction and this id, not from the whole log, so an entry the relay never learned of (a rename put while offline) cannot block later ones.
//
// `joins` are pairings this device hosted whose new device has not yet been seen on the relay: if it never shows up, the add is rolled
// back by an ordinary removal (service.ts), so a failed pairing cannot leave a phantom member behind.
//
// File: `<userData>/mesh/relay-sync.json`. Public ids and public entry bytes only; no secrets.
import path from 'path';
import { readFileIfExists, writeFileDurable } from './fs-durable';
import { reportFailure } from '../report-failure';

export interface PendingJoin { dev: string; /** the signed `add` entry, base64 (public data) */ entry: string; at: number }
interface State { v: 1; pending: string[]; acked: string | null; joins: PendingJoin[] }

export class RelaySyncState {
  readonly file: string;
  #s: State = { v: 1, pending: [], acked: null, joins: [] };
  #queue: Promise<unknown> = Promise.resolve();
  constructor(meshDir: string) {
    this.file = path.join(meshDir, 'relay-sync.json');
  }
  async load(): Promise<void> {
    const raw = await readFileIfExists(this.file);
    if (!raw) return;
    try {
      const j = JSON.parse(raw.toString('utf8')) as Partial<State>;
      const hex = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
      this.#s = {
        v: 1,
        pending: Array.isArray(j.pending) ? j.pending.filter(hex).slice(0, 10_000) : [],
        acked: hex(j.acked) ? j.acked : null,
        joins: Array.isArray(j.joins) ? j.joins.filter((x): x is PendingJoin => !!x && typeof x.dev === 'string' && typeof x.entry === 'string' && Number.isSafeInteger(x.at)).slice(0, 64) : [],
      };
    } catch (cause) { reportFailure({ what: 'read the saved relay sync queue (starting with an empty one; the log is the truth and an add or remove the relay missed is refused loudly by it)', cause, where: 'mesh.relay-sync' }); }
  }
  get pending(): readonly string[] { return this.#s.pending; }
  get acked(): string | null { return this.#s.acked; }
  get joins(): readonly PendingJoin[] { return this.#s.joins; }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.#s);
    const run = (): Promise<void> => writeFileDurable(this.file, Buffer.from(snapshot), 0o600);
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined); /* benign: p itself is returned, so its caller gets the failure; this copy only keeps one failed write from blocking the queue */
    return p;
  }
  /** Resolves when every save asked for so far has finished (or failed; the failure went to its caller). */
  idle(): Promise<void> { return this.#queue.then(() => undefined); }
  /** Remember (durably) that this entry must be told to the relay. Call BEFORE the entry is written to the log. */
  enqueue(id: string): Promise<void> {
    if (!this.#s.pending.includes(id)) this.#s.pending = [...this.#s.pending, id];
    return this.save();
  }
  /** The relay accepted (`accepted` true) or finally refused this entry: it leaves the queue. */
  settle(id: string, accepted: boolean): Promise<void> {
    this.#s.pending = this.#s.pending.filter((x) => x !== id);
    if (accepted) this.#s.acked = id;
    return this.save();
  }
  /** The relay accepted an entry that was never queued (the pairing add is told directly, before it is written). */
  noteAccepted(id: string): Promise<void> {
    this.#s.acked = id;
    return this.save();
  }
  addJoin(j: PendingJoin): Promise<void> {
    this.#s.joins = [...this.#s.joins.filter((x) => x.dev !== j.dev), j];
    return this.save();
  }
  removeJoin(dev: string): Promise<void> {
    if (!this.#s.joins.some((x) => x.dev === dev)) return Promise.resolve();
    this.#s.joins = this.#s.joins.filter((x) => x.dev !== dev);
    return this.save();
  }
}
