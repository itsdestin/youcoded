// Restart to update: the order of steps (design §4 "Restart to update", rev 4 F1/F6/F7).
import { describe, expect, it, vi } from 'vitest';
import { createRestartToUpdate, type RestartDeps } from '../src/main/update-restart';

type Plan = Awaited<ReturnType<ReturnType<RestartDeps['service']>['planRestart']>>;

function setup(o: { plan?: Plan; sessions?: string[]; answer?: { close: boolean; reopen?: boolean }; macPassword?: 'started' | 'cancelled' | 'failed'; launch?: unknown } = {}) {
  const state = { shutdown: false };
  const svc = {
    planRestart: vi.fn(async () => o.plan ?? ({ kind: 'exit-install', macPassword: false } as Plan)),
    launchInteractive: vi.fn(async () => (o.launch ?? { success: true, quitPending: true }) as never),
    startMacRootHelper: vi.fn(async () => o.macPassword ?? 'started'),
    openDiskImage: vi.fn(async () => {}),
    confirmInstallReady: vi.fn(async () => {}),
    releaseLaunch: vi.fn(),
  };
  const deps = {
    service: () => svc,
    allSessionIds: vi.fn(() => o.sessions ?? []),
    ask: vi.fn(async (_n: number) => o.answer ?? { close: true, reopen: true }),
    shuttingDown: () => state.shutdown,
    quitForUpdate: vi.fn(),
  };
  return { svc, deps, state, restart: createRestartToUpdate(deps as RestartDeps) };
}

describe('Restart to update', () => {
  it('with no chats open it goes ahead without a question and installs at exit', async () => {
    const t = setup();
    expect(await t.restart()).toEqual({ restarting: true });
    expect(t.deps.ask).not.toHaveBeenCalled();
    expect(t.deps.quitForUpdate).toHaveBeenCalledWith([], true);
  });

  it('counts the chats of every window and asks once', async () => {
    const t = setup({ sessions: ['a', 'b', 'c'] });
    await t.restart();
    expect(t.deps.ask).toHaveBeenCalledWith(3);
  });

  it('Cancel on the prompt: nothing quits and the popup is told {restarting:false}', async () => {
    const t = setup({ sessions: ['a'], answer: { close: false } });
    expect(await t.restart()).toEqual({ restarting: false });
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('a shutdown that began while the prompt was open (settled as Cancel, or answered Yes just after) installs nothing', async () => {
    const t = setup({ sessions: ['a'] });
    t.deps.ask.mockImplementation(async () => { t.state.shutdown = true; return { close: true, reopen: true }; });
    expect(await t.restart()).toEqual({ restarting: false });
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('"don\'t bring them back" hands the chats over to be untracked AFTER the quit gate, never now', async () => {
    const t = setup({ sessions: ['a', 'b'], answer: { close: true, reopen: false } });
    await t.restart();
    expect(t.deps.quitForUpdate).toHaveBeenCalledWith(['a', 'b'], true); // app-restart untracks only once the gate passes
  });

  it('"bring them back" untracks nothing', async () => {
    const t = setup({ sessions: ['a'], answer: { close: true, reopen: true } });
    await t.restart();
    expect(t.deps.quitForUpdate).toHaveBeenCalledWith([], true);
  });

  it('a pulled or superseded release: no question, no quit', async () => {
    const t = setup({ plan: { kind: 'none' }, sessions: ['a'] });
    expect(await t.restart()).toEqual({ restarting: false });
    expect(t.deps.ask).not.toHaveBeenCalled();
  });

  it('Mac password cancelled: the disk image opens, the app keeps running', async () => {
    const t = setup({ plan: { kind: 'exit-install', macPassword: true }, macPassword: 'cancelled' });
    expect(await t.restart()).toEqual({ restarting: false });
    expect(t.svc.openDiskImage).toHaveBeenCalled();
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('Mac password given: the root helper is started before the quit, which then installs at exit', async () => {
    const t = setup({ plan: { kind: 'exit-install', macPassword: true } });
    expect(await t.restart()).toEqual({ restarting: true });
    expect(t.svc.startMacRootHelper.mock.invocationCallOrder[0]).toBeLessThan(t.deps.quitForUpdate.mock.invocationCallOrder[0]);
  });

  it('Linux package: the existing installer runs first; success quits with nothing left to install at exit', async () => {
    const t = setup({ plan: { kind: 'linux-package' } });
    expect(await t.restart()).toEqual({ restarting: true });
    expect(t.svc.launchInteractive).toHaveBeenCalled();
    expect(t.deps.quitForUpdate).toHaveBeenCalledWith([], false);
  });

  it('a cancelled administrator prompt keeps the app running with the installer\'s own error', async () => {
    const t = setup({ plan: { kind: 'linux-package' }, launch: { success: false, error: 'install-cancelled' } });
    await expect(t.restart()).rejects.toMatchObject({ code: 'install-cancelled' });
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('hands a command to run by hand back to the popup instead of quitting', async () => {
    const t = setup({ plan: { kind: 'interactive' }, launch: { success: true, quitPending: false, fallback: 'manual', command: 'sudo x', filePath: '/f' } });
    expect(await t.restart()).toEqual({ restarting: false, fallback: { kind: 'manual', command: 'sudo x', filePath: '/f' } });
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('tells the person now when the install cannot be prepared, instead of quitting and reopening the old version (review F6)', async () => {
    const t = setup();
    t.svc.confirmInstallReady.mockRejectedValue(Object.assign(new Error('network-failed: could not confirm this release is still current'), { code: 'network-failed' }));
    await expect(t.restart()).rejects.toMatchObject({ code: 'network-failed' });
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('frees the launch lock when a shutdown takes over after the installer ran (review F11)', async () => {
    const t = setup({ plan: { kind: 'interactive' } });
    t.svc.launchInteractive.mockImplementation(async () => { t.state.shutdown = true; return { success: true, quitPending: true } as never; });
    expect(await t.restart()).toEqual({ restarting: false });
    expect(t.svc.releaseLaunch).toHaveBeenCalledTimes(1);
    expect(t.deps.quitForUpdate).not.toHaveBeenCalled();
  });

  it('a second press while one is running joins it instead of asking and quitting twice', async () => {
    const t = setup({ sessions: ['a'] });
    const [a, b] = await Promise.all([t.restart(), t.restart()]);
    expect(a).toEqual(b);
    expect(t.deps.ask).toHaveBeenCalledTimes(1);
    expect(t.deps.quitForUpdate).toHaveBeenCalledTimes(1);
  });

  it('does nothing once a shutdown has begun', async () => {
    const t = setup(); t.state.shutdown = true;
    expect(await t.restart()).toEqual({ restarting: false });
    expect(t.svc.planRestart).not.toHaveBeenCalled();
  });
});
