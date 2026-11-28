// Pins how the app joins a two-player room since rooms require sign-in (2026-11-09 final review F-3):
// a fresh one-time pass for every connection, the room's name for this player translated back, and no
// retrying after the server ends a room on purpose.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sockets: any[] = [];
vi.mock('partysocket', () => ({
  default: class {
    listeners = new Map<string, ((e: any) => void)[]>();
    closed = 0;
    readyState = 0;
    constructor(public options: any) { sockets.push(this); }
    addEventListener(type: string, cb: (e: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
    emit(type: string, e: any) { for (const cb of this.listeners.get(type) ?? []) cb(e); }
    send() {}
    close() { this.closed++; }
  },
}));

import { PartyClient } from '../src/renderer/game/party-client';

describe('joining a room with a pass', () => {
  let roomTicket: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sockets.length = 0;
    roomTicket = vi.fn(async () => ({ ok: true, value: { ticket: 'abc', username: 'Room Name', expires_in: 60 } }));
    vi.stubGlobal('window', { claude: { arcade: { roomTicket } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the backend for a new pass on every connection and never sends a name itself', async () => {
    new PartyClient({ party: 'chess', room: 'ABCDEF', username: 'Me', onMessage: () => {} });
    const query = sockets[0].options.query;
    expect(typeof query).toBe('function');
    expect(await query()).toEqual({ ticket: 'abc' });
    expect(await query()).toEqual({ ticket: 'abc' });
    expect(roomTicket).toHaveBeenCalledTimes(2);
    expect(roomTicket).toHaveBeenCalledWith('chess', 'ABCDEF');
  });

  it('fails the connection attempt when no pass can be had (signed out)', async () => {
    roomTicket.mockResolvedValueOnce({ ok: false, status: 401, message: 'not signed in' });
    new PartyClient({ party: 'chess', room: 'ABCDEF', username: 'Me', onMessage: () => {} });
    await expect(sockets[0].options.query()).rejects.toThrow('not signed in');
  });

  it("translates the room's name for this player back to the name the game screens hold", async () => {
    const seen: any[] = [];
    new PartyClient({ party: 'chess', room: 'ABCDEF', username: 'Me', onMessage: (d) => seen.push(d) });
    await sockets[0].options.query();
    sockets[0].emit('message', { data: JSON.stringify({ type: 'chat', username: 'Room Name', text: 'hi' }) });
    sockets[0].emit('message', { data: JSON.stringify({ type: 'chat', username: 'Other', text: 'yo' }) });
    expect(seen.map((d) => d.username)).toEqual(['Me', 'Other']);
  });

  it('stops retrying when the server ends the room on purpose, and keeps retrying after an ordinary drop', () => {
    const closes: number[] = [];
    new PartyClient({ party: 'chess', room: 'ABCDEF', username: 'Me', onMessage: () => {}, onClose: (i) => closes.push(i.code) });
    sockets[0].emit('close', { code: 1006, reason: '' });
    expect(sockets[0].closed).toBe(0);
    sockets[0].emit('close', { code: 4011, reason: 'Room closed: no activity for 30 minutes' });
    expect(sockets[0].closed).toBe(1);
    expect(closes).toEqual([1006, 4011]);
  });
});
