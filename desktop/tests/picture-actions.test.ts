// Card #143 a: Copy image / Save image as — the computer fetches the picture itself (see picture-actions.ts WHY).
// Security review 2026-11-13: the address is chat content, so the guarded network path, the streamed cap, picture-only Save and
// the refusal of file: addresses are each pinned here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ written: [] as any[], save: vi.fn(), empty: false }));
vi.mock('electron', () => ({
  clipboard: { write: async (items: any[]) => { h.written.push(items); } },
  ClipboardItem: class { constructor(public items: any) {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => h.empty, toPNG: () => Buffer.from('png') }) },
  dialog: { showSaveDialog: (...a: any[]) => h.save(...a) },
}));
// The REAL guard runs; only the network underneath it and DNS are replaced (guardedFetch's own test hooks cannot reach through
// runPictureAction, so the global fetch and the resolver are stubbed).
const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/main/harness/tools/net-guard', async (orig) => {
  const real: any = await orig();
  const lookup = async (host: string) => ({ lan: [{ address: '192.168.1.5' }], 'to-private.example': [{ address: '10.0.0.7' }] } as any)[host] ?? [{ address: '93.184.216.34' }];
  return { ...real, guardedFetch: (u: string, o: any) => real.guardedFetch(u, { ...o, lookup, fetchImpl: net.fetch }) };
});
import { runPictureAction, sniffPictureType } from '../src/main/picture-actions';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const reply = (bytes: Buffer, type = 'image/png', extra: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type, ...extra } });
beforeEach(() => { h.written.length = 0; h.save.mockReset(); net.fetch.mockReset(); h.empty = false; });

describe('the address is attacker-controlled: only the guarded public path is used', () => {
  it.each([
    'http://localhost/a.png', 'http://127.0.0.1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://192.168.1.5/a.png', 'http://lan/a.png',
  ])('refuses %s without making a request', async (u) => {
    expect((await runPictureAction('copy', u, null)).ok).toBe(false);
    expect(net.fetch).not.toHaveBeenCalled();
  });
  it('refuses a public address that redirects to a private one (every hop is checked)', async () => {
    net.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x.png' } }));
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).ok).toBe(false);
    expect(net.fetch).toHaveBeenCalledTimes(1);
    net.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://to-private.example/x.png' } }));
    expect((await runPictureAction('copy', 'https://example.com/b.png', null)).ok).toBe(false);
  });
  it('refuses file:, ftp: and script addresses, including network-share forms', async () => {
    for (const u of ['file:///etc/passwd', 'file://server/share/a.png', 'file:////server/share/a.png', 'ftp://x/a.png', 'javascript:alert(1)']) {
      expect((await runPictureAction('save', u, null)).ok, u).toBe(false);
    }
    expect(net.fetch).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it('refuses a malformed request from the window', async () => {
    for (const [a, s] of [['delete', 'https://example.com/a.png'], ['copy', 42], ['copy', ''], ['copy', 'x'.repeat(5000)], [undefined, undefined]] as const) {
      expect((await runPictureAction(a, s, null)).reason).toBe('bad-request');
    }
  });
});

describe('the size cap and timeout hold while the body streams', () => {
  it('an oversize body with no Content-Length is cut off and refused', async () => {
    // 51 MB in 1 MB pieces, no length announced.
    let sent = 0;
    const body = new ReadableStream({ pull(c) { if (sent >= 51) { c.close(); return; } sent += 1; c.enqueue(new Uint8Array(1024 * 1024).fill(0x41)); } });
    net.fetch.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }));
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('too-large');
    expect(sent).toBeLessThanOrEqual(52); // stopped reading once past the cap
  });
  it('a Content-Length over the cap is refused before reading', async () => {
    net.fetch.mockResolvedValue(reply(PNG, 'image/png', { 'content-length': String(60 * 1024 * 1024) }));
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('too-large');
  });
  it('a lying small Content-Length does not let more through', async () => {
    let sent = 0;
    const body = new ReadableStream({ pull(c) { if (sent >= 51) { c.close(); return; } sent += 1; c.enqueue(new Uint8Array(1024 * 1024)); } });
    net.fetch.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '10' } }));
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('too-large');
  });
  it('a body that never ends is cut off by the timeout', async () => {
    net.fetch.mockImplementation((_u: string, init: any) => Promise.resolve(new Response(new ReadableStream({
      start(c) { c.enqueue(PNG); init.signal.addEventListener('abort', () => c.error(init.signal.reason)); },
    }), { status: 200, headers: { 'content-type': 'image/png' } })));
    const started = Date.now();
    expect((await runPictureAction('copy', 'https://example.com/a.png', null, 300)).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('Copy and Save', () => {
  it('copies a website picture as PNG', async () => {
    net.fetch.mockResolvedValue(reply(PNG));
    expect(await runPictureAction('copy', 'https://example.com/a.png', null)).toEqual({ ok: true });
    expect(h.written).toHaveLength(1);
  });
  it('saves the picture bytes, naming the file from the DETECTED type, never the address ending', async () => {
    net.fetch.mockResolvedValue(reply(JPG, 'image/jpeg'));
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pic-')), 'out.jpg');
    h.save.mockResolvedValue({ canceled: false, filePath: dest });
    expect(await runPictureAction('save', 'https://example.com/setup.exe', null)).toEqual({ ok: true });
    expect(h.save.mock.calls[0][0].defaultPath).toBe('setup.jpg');
    expect(Buffer.compare(fs.readFileSync(dest), JPG)).toBe(0);
  });
  it('Save refuses what is not a picture: a program that claims to be an image, an HTML page, a wrong declared type', async () => {
    h.save.mockResolvedValue({ canceled: false, filePath: path.join(os.tmpdir(), 'never.exe') });
    net.fetch.mockResolvedValueOnce(reply(Buffer.from('MZ\x90\x00 program bytes'), 'image/png'));
    expect((await runPictureAction('save', 'https://example.com/a.png', null)).reason).toBe('not-a-picture');
    net.fetch.mockResolvedValueOnce(reply(Buffer.from('<html>'), 'text/html'));
    expect((await runPictureAction('save', 'https://example.com/a.html', null)).reason).toBe('not-a-picture');
    net.fetch.mockResolvedValueOnce(reply(PNG, 'application/octet-stream'));
    expect((await runPictureAction('save', 'https://example.com/a.png', null)).reason).toBe('not-a-picture');
    expect(h.save).not.toHaveBeenCalled();
  });
  it('a cancelled save writes nothing and is not a failure', async () => {
    net.fetch.mockResolvedValue(reply(PNG));
    h.save.mockResolvedValue({ canceled: true });
    expect(await runPictureAction('save', 'https://example.com/a.png', null)).toEqual({ ok: true, canceled: true });
  });
  it('a picture the system cannot decode is not copied', async () => {
    net.fetch.mockResolvedValue(reply(PNG)); h.empty = true;
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('not-a-picture');
  });
});

describe('early refusals release the connection; unsafe suggested names are fixed', () => {
  const tracked = (bytes: Buffer, status: number, type: string) => {
    const cancel = vi.fn(async () => {});
    const res: any = new Response(new Uint8Array(bytes), { status, headers: { 'content-type': type } });
    Object.defineProperty(res, 'body', { value: { cancel, getReader: () => { throw new Error('must not be read'); } } });
    return { res, cancel };
  };
  it('cancels the body on a not-ok reply and on a not-a-picture reply', async () => {
    const a = tracked(PNG, 404, 'image/png'); net.fetch.mockResolvedValueOnce(a.res);
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('fetch-failed');
    expect(a.cancel).toHaveBeenCalledTimes(1);
    const b = tracked(Buffer.from('<html>'), 200, 'text/html'); net.fetch.mockResolvedValueOnce(b.res);
    expect((await runPictureAction('copy', 'https://example.com/a', null)).reason).toBe('not-a-picture');
    expect(b.cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['CON', 'nul', 'Com1', 'LPT9', 'aux', 'PRN'])('never suggests the Windows reserved name %s', async (name) => {
    net.fetch.mockResolvedValue(reply(PNG));
    h.save.mockResolvedValue({ canceled: true });
    await runPictureAction('save', `https://example.com/${name}.png`, null);
    expect(h.save.mock.calls.at(-1)![0].defaultPath).toBe(`picture-${name}.png`);
  });
  it('an address with no usable name suggests "picture"', async () => {
    net.fetch.mockResolvedValue(reply(PNG));
    h.save.mockResolvedValue({ canceled: true });
    await runPictureAction('save', 'https://example.com/', null);
    expect(h.save.mock.calls.at(-1)![0].defaultPath).toBe('picture.png');
  });
});

describe('sniffPictureType', () => {
  it('knows the common formats by their first bytes and nothing else', () => {
    expect(sniffPictureType(PNG)?.ext).toBe('.png');
    expect(sniffPictureType(JPG)?.ext).toBe('.jpg');
    expect(sniffPictureType(Buffer.from('GIF89a....'))?.ext).toBe('.gif');
    expect(sniffPictureType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffPictureType(Buffer.from('MZ'))).toBeNull();
  });
});
