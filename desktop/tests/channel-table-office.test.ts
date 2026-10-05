// Office's channels in the table (main/ipc/office.ts): one entry each, computer only, and the modules that serve them
// (registered through `officeIpc`) get the same positional arguments and window they got from ipcMain before the move.
import { describe, it, expect, vi } from 'vitest';
import { CHANNEL_TABLE, findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { officeIpc } from '../src/main/ipc/office';

const office = CHANNEL_TABLE.filter((d) => d.name.startsWith('office:'));
const ctx = (extra: any = {}): any => ({ door: 'desktop', runtime: null, broadcast: vi.fn(), sender: { id: 7 }, ...extra });

describe('the office:* channels', () => {
  it('are the fifteen Office channels, all computer-only; a phone is refused before any handler runs', async () => {
    expect(office.map((d) => d.name).sort()).toEqual([
      'office:close', 'office:comments-answer', 'office:comments-changed', 'office:create', 'office:dismiss', 'office:invoke',
      'office:journal-done', 'office:open', 'office:other-unsaved', 'office:pick', 'office:proceed', 'office:restore',
      'office:save-copy', 'office:status', 'office:versions',
    ]);
    expect(office.every((d) => d.desktopOnly)).toBe(true);
    const handler = vi.fn(); officeIpc.removeHandler('office:open'); officeIpc.handle('office:open', handler);
    expect(await serveRemoteChannel(findChannel('office:open')!, { path: '/x.docx' }, { door: 'remote', runtime: null, broadcast: vi.fn() } as any))
      .toEqual({ reply: true, payload: { ok: false, error: "This feature isn't available over remote access yet (office:open).", unsupported: true } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a request reaches the module that registered it with the calling window and the old positional arguments', async () => {
    const seen: unknown[][] = [];
    officeIpc.removeHandler('office:restore'); officeIpc.handle('office:restore', (e, ...args) => { seen.push([e.sender.id, ...args]); return { ok: true }; });
    expect(await findChannel('office:restore')!.handler({ path: '/a.docx', versionId: 'v1' }, ctx())).toEqual({ ok: true });
    officeIpc.removeHandler('office:save-copy'); officeIpc.handle('office:save-copy', (e, ...args) => { seen.push([e.sender.id, ...args]); return { ok: true, possible: true }; });
    await findChannel('office:save-copy')!.handler({ token: 't', mode: 'check', data: undefined }, ctx());
    expect(seen).toEqual([[7, '/a.docx', 'v1'], [7, 't', 'check', undefined]]);
  });

  it('a request before Office registered answers with an error, as an unregistered ipcMain.handle did', async () => {
    officeIpc.removeHandler('office:status');
    await expect(Promise.resolve(findChannel('office:status')!.handler({ projectRoot: null }, ctx()))).rejects.toThrow(/not ready/);
  });

  it('a window\'s message reaches every listener, and a listener that was removed hears nothing', () => {
    const a = vi.fn(); const b = vi.fn();
    officeIpc.on('office:comments-answer', a); officeIpc.on('office:comments-answer', b);
    findChannel('office:comments-answer')!.handler({ id: 'i', result: { ok: true }, token: 't' }, ctx());
    officeIpc.off('office:comments-answer', b);
    findChannel('office:comments-answer')!.handler({ id: 'j', result: 1, token: 't' }, ctx());
    expect(a.mock.calls.map((c) => [c[0].sender.id, ...c.slice(1)])).toEqual([[7, 'i', { ok: true }, 't'], [7, 'j', 1, 't']]);
    expect(b).toHaveBeenCalledTimes(1);
    officeIpc.off('office:comments-answer', a);
  });

  it('refuses a channel the table does not declare, one declared as the other kind, and a second handler for the same channel', () => {
    expect(() => officeIpc.handle('office:nope', vi.fn())).toThrow(/not an Office 'handle' channel/);
    expect(() => officeIpc.on('office:nope', vi.fn())).toThrow(/not an Office 'on' channel/);
    expect(() => officeIpc.on('office:open', vi.fn())).toThrow(/not an Office 'on' channel/);
    expect(() => officeIpc.handle('office:proceed', vi.fn())).toThrow(/not an Office 'handle' channel/);
    officeIpc.removeHandler('office:close'); officeIpc.handle('office:close', vi.fn());
    expect(() => officeIpc.handle('office:close', vi.fn())).toThrow(/second handler/);
    officeIpc.removeHandler('office:close');
  });
});
