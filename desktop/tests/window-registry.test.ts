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

  // Buddy windows (the floating mascot + compact chat) are registered so
  // subscriptions work, but must be invisible to the switcher's "Sessions in
  // other windows" group and ineligible for leadership.
  describe('buddy windows', () => {
    it('getDirectory omits buddy windows', () => {
      reg.registerWindow(100, 1, 'main');
      reg.registerWindow(200, 2, 'buddy');
      reg.registerWindow(201, 3, 'buddy');
      const dir = reg.getDirectory(() => undefined);
      expect(dir.windows.map((w) => w.window.id)).toEqual([100]);
    });

    it('getLeaderId ignores buddy windows even when they are older', () => {
      reg.registerWindow(200, 1, 'buddy');
      reg.registerWindow(100, 2, 'main');
      expect(reg.getLeaderId()).toBe(100);
    });

    it('getLeaderId is undefined when only buddies are registered', () => {
      reg.registerWindow(200, 1, 'buddy');
      expect(reg.getLeaderId()).toBeUndefined();
    });

    it('getKind reports kind for registered windows', () => {
      reg.registerWindow(100, 1, 'main');
      reg.registerWindow(200, 2, 'buddy');
      expect(reg.getKind(100)).toBe('main');
      expect(reg.getKind(200)).toBe('buddy');
      expect(reg.getKind(999)).toBeUndefined();
    });

    it('buddy windows can still subscribe to sessions', () => {
      reg.registerWindow(100, 1, 'main');
      reg.registerWindow(200, 2, 'buddy');
      reg.assignSession('s1', 100);
      // subscribe() throws if the window id is unknown — must not throw for buddy.
      expect(() => reg.subscribe('s1', 200)).not.toThrow();
      expect(reg.getSubscribers('s1').has(200)).toBe(true);
    });

    it('main window labels are not consumed by buddy registrations', () => {
      reg.registerWindow(200, 1, 'buddy'); // no label bump
      reg.registerWindow(100, 2, 'main');  // → "window 1"
      reg.registerWindow(101, 3, 'main');  // → "window 2"
      const dir = reg.getDirectory(() => undefined);
      expect(dir.windows.map((w) => w.window.label)).toEqual(['window 1', 'window 2']);
    });
  });
});
