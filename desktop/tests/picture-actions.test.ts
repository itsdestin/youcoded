// Card #143 a: Copy image / Save image as — the computer fetches the picture itself (see picture-actions.ts WHY).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  written: [] as any[], save: vi.fn(), fetch: vi.fn(), empty: false,
}));
vi.mock('electron', () => ({
  clipboard: { write: async (items: any[]) => { h.written.push(items); } },
  ClipboardItem: class { constructor(public items: any) {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => h.empty, toPNG: () => Buffer.from('png') }) },
  net: { fetch: (...a: any[]) => h.fetch(...a) },
  dialog: { showSaveDialog: (...a: any[]) => h.save(...a) },
}));
import { runPictureAction } from '../src/main/picture-actions';

const reply = (bytes: string, type = 'image/png') => ({ ok: true, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => Buffer.from(bytes) });
beforeEach(() => { h.written.length = 0; h.save.mockReset(); h.fetch.mockReset(); h.empty = false; });

describe('runPictureAction', () => {
  it('copies a website picture to the clipboard as PNG', async () => {
    h.fetch.mockResolvedValue(reply('abc'));
    expect(await runPictureAction('copy', 'https://example.com/a.png', null)).toEqual({ ok: true });
    expect(h.written).toHaveLength(1);
  });
  it('saves the picture\'s own bytes where the person chooses, adding the type\'s extension when the name has none', async () => {
    h.fetch.mockResolvedValue(reply('rawbytes', 'image/jpeg'));
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pic-')), 'out.jpg');
    h.save.mockResolvedValue({ canceled: false, filePath: dest });
    expect(await runPictureAction('save', 'https://example.com/photo', null)).toEqual({ ok: true });
    expect(h.save.mock.calls[0][0].defaultPath).toBe('photo.jpg');
    expect(fs.readFileSync(dest, 'utf8')).toBe('rawbytes');
  });
  it('a cancelled save writes nothing and is not a failure', async () => {
    h.fetch.mockResolvedValue(reply('x'));
    h.save.mockResolvedValue({ canceled: true });
    expect(await runPictureAction('save', 'https://example.com/a.png', null)).toEqual({ ok: true, canceled: true });
  });
  it('refuses other address kinds, a failed fetch, a non-picture and a network error', async () => {
    expect((await runPictureAction('copy', 'javascript:alert(1)', null)).ok).toBe(false);
    expect((await runPictureAction('copy', 'ftp://x/a.png', null)).reason).toBe('unsupported-address');
    h.fetch.mockResolvedValue({ ok: false, headers: new Headers() });
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('fetch-failed');
    h.fetch.mockResolvedValue(reply('x')); h.empty = true;
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).reason).toBe('not-a-picture');
    h.fetch.mockRejectedValue(new Error('offline'));
    expect((await runPictureAction('copy', 'https://example.com/a.png', null)).ok).toBe(false);
  });
  it('reads a file: picture from disk', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pic-')), 'a.png'); fs.writeFileSync(f, 'disk');
    expect(await runPictureAction('copy', `file://${f}`, null)).toEqual({ ok: true });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
