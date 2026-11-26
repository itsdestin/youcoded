// Client for the relay's pairing meeting point (/mesh/meet/<id>): a short-lived pipe between exactly two devices, used only
// to carry the pairing exchange (design 5.1, T5 C10). It moves BYTES; pair-flow.ts and the crypto library decide what they mean.
//
// ROLES. The host (the existing device) first asks the relay, on its signed-in room socket, to open the meeting and gets a
// ticket; it joins with that ticket. The guest (the new device) is in no room yet and needs nothing but the id (SHA-256 of the
// typed code's meeting part: meetingIdFor). The relay hands each guest connection a number (`gen`) so the host never mixes two
// strangers' exchanges: every message to or from the host carries the gen it belongs to.
//
// THE RELAY IS HOSTILE HERE. It can drop, delay, replay or end the meeting; none of that can pair a device (the PAKE and its
// confirmation are end to end) and a dropped meeting simply fails the pairing. Messages carry a rising number so a replaying
// relay is dropped by the relay's own rule and, past that, by the crypto layer's single-use messages.
//
// LOGGING: event names and close codes only. Never the id, the ticket, a message or the code (pinned by no-secret-logging).
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MAX_MESSAGE_BYTES, MESH_PROTOCOL_VERSION, packMessage, unpackMessage } from '../../shared/mesh-protocol';
import { assertSafeRelayUrl } from './relay-client';

export interface MeetingOptions {
  /** `ws://127.0.0.1:1234` or `wss://host` (no path). */
  url: string;
  /** The meeting id, lowercase hex. */
  id: string;
  role: 'host' | 'guest';
  /** Host only: what `meet-open` returned. */
  ticket?: string;
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
}

const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Events: 'joined' ({gen, peer}), 'peer' ({state, gen}), 'message' ({gen, bytes}), 'ended' (why), 'closed'. */
export class MeetingClient extends EventEmitter {
  #ws: WebSocket | null = null;
  #n = 0;
  #open = false;
  #closed = false;
  readonly #o: MeetingOptions;
  constructor(o: MeetingOptions) {
    super();
    assertSafeRelayUrl(o.url);
    this.#o = o;
  }
  get isOpen(): boolean {
    return this.#open && !this.#closed;
  }
  /** Connect and say who we are. Resolves once the relay accepted the role; rejects if it refused or the socket failed. */
  connect(): Promise<{ gen: number; peer: boolean }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.#o.url.replace(/\/$/, '')}/mesh/meet/${this.#o.id}?v=${MESH_PROTOCOL_VERSION}`, { maxPayload: MAX_MESSAGE_BYTES });
      this.#ws = ws;
      let settled = false;
      const fail = (e: Error): void => { if (!settled) { settled = true; reject(e); } };
      ws.on('open', () => {
        this.#open = true;
        try { ws.send(packMessage({ op: 'meet-join', role: this.#o.role, ...(this.#o.ticket ? { ticket: this.#o.ticket } : {}) })); } catch { fail(new Error('meeting-send-failed')); }
      });
      ws.on('unexpected-response', () => fail(new Error('meeting-not-found'))); // a 404: nothing was opened under that id
      ws.on('error', () => fail(new Error('meeting-connect-failed')));
      ws.on('close', (code: number) => {
        this.#open = false;
        this.#closed = true;
        this.#o.log?.('meeting-closed', { role: this.#o.role, code });
        fail(new Error(`meeting-closed-${code}`));
        this.emit('closed', code);
      });
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return;
        const m = unpackMessage(toArrayBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
        if (!m.ok) return;
        const h = m.header as Record<string, unknown>;
        if (h.op === 'meet-joined') { if (!settled) { settled = true; resolve({ gen: Number(h.gen), peer: h.peer === true }); } this.emit('joined', { gen: Number(h.gen), peer: h.peer === true }); }
        else if (h.op === 'refused') fail(new Error(`meeting-refused-${String(h.reason)}`));
        else if (h.op === 'meet-peer') this.emit('peer', { state: h.state, gen: Number(h.gen) });
        else if (h.op === 'meet-relay') this.emit('message', { gen: Number(h.gen), bytes: Buffer.from(m.payload) });
        else if (h.op === 'meet-ended') this.emit('ended', String(h.why));
      });
    });
  }
  /** Send one pairing message to the other party. Throws if the meeting is not open. */
  send(bytes: Uint8Array): void {
    if (!this.#ws || !this.isOpen) throw new Error('meeting-not-open');
    this.#ws.send(packMessage({ op: 'meet-relay', n: ++this.#n }, bytes));
  }
  /** Ask the relay to end the meeting for both parties and erase it, then hang up. */
  close(): void {
    const ws = this.#ws;
    if (!ws || this.#closed) return;
    try { if (this.#open) ws.send(packMessage({ op: 'meet-close' })); } catch { /* benign: closing a meeting whose socket is already gone */ }
    // Give the close message a moment to leave, then drop the socket either way.
    setTimeout(() => { try { ws.close(1000, 'done'); } catch { /* benign: the socket was already closed */ } }, 200).unref?.();
    this.#closed = true;
  }
}
