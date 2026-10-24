import { describe, expect, it, vi } from 'vitest';
import { googleFilesChannels } from '../src/main/ipc/google-files';

function setup() {
  const service = { attach: vi.fn(async () => []), approve: vi.fn(async () => ({ id: 'file' })), beginAuth: vi.fn(async () => ({ flowId: 'auth-flow' })), authState: vi.fn(async () => ({ state: 'pending' })), cancelAuth: vi.fn(async () => {}) };
  const ctx: any = { sender: { id: 4 }, runtime: { googleFiles: service, sessionState: { sessionIdMap: new Map([['desktop-chat', 'native-chat']]) } }, desktop: { sessionManager: { getSession: (id: string) => id === 'desktop-chat' ? { cwd: '/workspace' } : undefined } } };
  const run = (name: string, payload: any, context = ctx) => googleFilesChannels.find((row) => row.name === name)!.handler(payload, context);
  return { service, ctx, run };
}

describe('Google file channels', () => {
  it('uses the actual chat identity and rejects an unknown chat', async () => {
    const { run, service } = setup();
    await run('googleFiles:attach', { sessionId: 'desktop-chat', accountId: 'account', fileIds: ['file'] });
    expect(service.attach).toHaveBeenCalledWith('native-chat', 'account', ['file']);
    await expect(run('googleFiles:attach', { sessionId: 'other-chat', accountId: 'account', fileIds: ['file'] })).rejects.toThrow();
    expect(service.attach).toHaveBeenCalledTimes(1);
  });
  it('approval is explicitly invoked for the current chat only', async () => {
    const { run, service } = setup();
    await run('googleFiles:approve', { sessionId: 'desktop-chat', proposalId: 'draft' });
    expect(service.approve).toHaveBeenCalledWith('native-chat', 'draft');
  });
  it('auth flow polling is restricted to the window that started it', async () => {
    const { run, service, ctx } = setup();
    await run('googleFiles:auth-start', {});
    await expect(run('googleFiles:auth-state', { flowId: 'auth-flow' }, { ...ctx, sender: { id: 8 } })).rejects.toThrow();
    expect(service.authState).not.toHaveBeenCalled();
    await run('googleFiles:auth-state', { flowId: 'auth-flow' });
    expect(service.authState).toHaveBeenCalledWith('auth-flow');
  });
  it('marks the initial desktop loopback authorization feature unavailable to visiting phones', () => {
    expect(googleFilesChannels.length).toBe(13);
    expect(googleFilesChannels.every((row) => row.desktopOnly)).toBe(true);
  });
});
