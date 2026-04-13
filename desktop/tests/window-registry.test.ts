import { describe, it, expect, beforeEach } from 'vitest';
import { WindowRegistry } from '../src/main/window-registry';
import type { SessionInfo } from '../src/shared/types';

const mkInfo = (id: string): SessionInfo => ({
  id,
  name: `s-${id}`,
  cwd: '/',
  permissionMode: 'normal',
  skipPermissions: false,
  status: 'active',
  createdAt: 1,
  provider: 'claude',
});

describe('WindowRegistry', () => {
  let reg: WindowRegistry;
  beforeEach(() => {
    reg = new WindowRegistry();
  });

  it('registers windows in creation order with ascending labels', () => {
    reg.registerWindow(100, Date.now());
    reg.registerWindow(101, Date.now() + 1);
    const dir = reg.getDirectory(() => undefined);
    expect(dir.windows.map((w) => w.window.label)).toEqual(['window 1', 'window 2']);
  });

  it('first registered window is the leader', () => {
    reg.registerWindow(100, 10);
    reg.registerWindow(101, 20);
    expect(reg.getLeaderId()).toBe(100);
  });

  it('promotes next-oldest to leader when leader unregisters', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.registerWindow(102, 3);
    reg.unregisterWindow(100);
    expect(reg.getLeaderId()).toBe(101);
  });

  it('assignSession sets ownership and moves on reassign', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.assignSession('s1', 100);
    expect(reg.getOwner('s1')).toBe(100);
    reg.assignSession('s1', 101);
    expect(reg.getOwner('s1')).toBe(101);
  });

  it('assignSession throws if window unknown', () => {
    expect(() => reg.assignSession('s1', 999)).toThrow();
  });

  it('releaseSession clears ownership', () => {
    reg.registerWindow(100, 1);
    reg.assignSession('s1', 100);
    reg.releaseSession('s1');
    expect(reg.getOwner('s1')).toBeUndefined();
  });

  it('unregisterWindow releases its sessions', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.assignSession('s1', 100);
    reg.assignSession('s2', 100);
    reg.unregisterWindow(100);
    expect(reg.getOwner('s1')).toBeUndefined();
    expect(reg.getOwner('s2')).toBeUndefined();
  });

  it('sessionsForWindow returns owned session IDs', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.assignSession('s1', 100);
    reg.assignSession('s2', 100);
    reg.assignSession('s3', 101);
    expect(reg.sessionsForWindow(100).sort()).toEqual(['s1', 's2']);
    expect(reg.sessionsForWindow(101)).toEqual(['s3']);
  });

  it('getDirectory resolves SessionInfo via injected resolver', () => {
    reg.registerWindow(100, 1);
    reg.assignSession('s1', 100);
    const info = mkInfo('s1');
    const dir = reg.getDirectory((id) => (id === 's1' ? info : undefined));
    expect(dir.windows[0].sessions).toEqual([info]);
  });

  it('getDirectory omits sessions the resolver cannot resolve', () => {
    reg.registerWindow(100, 1);
    reg.assignSession('s1', 100);
    reg.assignSession('s2', 100);
    const info = mkInfo('s1');
    const dir = reg.getDirectory((id) => (id === 's1' ? info : undefined));
    expect(dir.windows[0].sessions).toEqual([info]); // s2 dropped
  });

  it('getDirectory orders windows by createdAt (oldest first)', () => {
    reg.registerWindow(200, 200);
    reg.registerWindow(100, 100);
    reg.registerWindow(300, 300);
    const dir = reg.getDirectory(() => undefined);
    expect(dir.windows.map((w) => w.window.id)).toEqual([100, 200, 300]);
  });

  it('emits "changed" event on every mutation', () => {
    let count = 0;
    reg.on('changed', () => count++);
    reg.registerWindow(100, 1);
    reg.assignSession('s1', 100);
    reg.releaseSession('s1');
    reg.unregisterWindow(100);
    expect(count).toBe(4);
  });

  it('leaderWindowId in directory reflects current leader', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    expect(reg.getDirectory(() => undefined).leaderWindowId).toBe(100);
    reg.unregisterWindow(100);
    expect(reg.getDirectory(() => undefined).leaderWindowId).toBe(101);
  });

  it('leaderWindowId is -1 when no windows registered', () => {
    expect(reg.getDirectory(() => undefined).leaderWindowId).toBe(-1);
  });
});
