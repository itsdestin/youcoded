// Card #134 round 4: a failed save of the Remote access settings must leave the running process on the PREVIOUS values, so the
// screen ("last saved") and reality agree; and a password that failed to save is not the running password.
import { describe, it, expect, vi } from 'vitest';
import { bindRemoteAdmin, remoteAdminChannels } from '../src/main/ipc/remote-admin';
import { IPC } from '../src/shared/backend-contract';

const channel = (name: string) => remoteAdminChannels.find((c) => c.name === name)!;
const ctx: any = { door: 'desktop', runtime: null, broadcast: () => {} };
function fakeConfig(saveFails: boolean) {
  return {
    enabled: false, keepAwakeHours: 0, port: 9900, passwordHash: 'old', weakPassword: false,
    save: vi.fn(() => { if (saveFails) throw new Error('EACCES: config file not writable'); }),
    setPassword: vi.fn(async () => {}),
    toSafeObject() { return { enabled: this.enabled, keepAwakeHours: this.keepAwakeHours, port: 9900, hasPassword: true }; },
  } as any;
}

describe('remote:set-config when the save throws', () => {
  it('puts enabled and keep-awake back (re-applying the old keep-awake) and rejects so the screen can say so', async () => {
    const cfg = fakeConfig(true); const applyKeepAwake = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bindRemoteAdmin({ config: cfg, server: undefined, applyKeepAwake });
    await expect(channel(IPC.REMOTE_SET_CONFIG).handler({ enabled: true, keepAwakeHours: 4 }, ctx)).rejects.toThrow('EACCES');
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepAwakeHours).toBe(0);
    expect(applyKeepAwake.mock.calls).toEqual([[4], [0]]);
  });
  it('a save that works keeps the new values and answers them', async () => {
    const cfg = fakeConfig(false); const applyKeepAwake = vi.fn();
    bindRemoteAdmin({ config: cfg, server: undefined, applyKeepAwake });
    const out: any = await channel(IPC.REMOTE_SET_CONFIG).handler({ keepAwakeHours: 4 }, ctx);
    expect(out.keepAwakeHours).toBe(4);
    expect(applyKeepAwake.mock.calls).toEqual([[4]]);
  });
});

describe('RemoteConfig.setPassword when the save throws', () => {
  it('restores the previous hash and weak flag, and never logs the password', async () => {
    vi.resetModules();
    vi.doMock('fs', async (orig) => ({ ...(await orig<typeof import('fs')>()), default: { ...(await orig<any>()).default, mkdirSync: () => { throw new Error('EROFS'); } }, mkdirSync: () => { throw new Error('EROFS'); } }));
    const { RemoteConfig } = await import('../src/main/remote-config');
    const logs: unknown[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a); });
    const cfg = new RemoteConfig();
    cfg.passwordHash = 'old-hash'; cfg.weakPassword = true;
    await expect(cfg.setPassword('correct horse battery')).rejects.toThrow('EROFS');
    expect(cfg.passwordHash).toBe('old-hash');
    expect(cfg.weakPassword).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('correct horse battery');
    vi.doUnmock('fs');
  });
});
