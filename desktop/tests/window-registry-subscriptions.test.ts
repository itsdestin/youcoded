import { describe, it, expect, beforeEach } from 'vitest';
import { WindowRegistry } from '../src/main/window-registry';

describe('WindowRegistry subscriptions', () => {
  let reg: WindowRegistry;
  beforeEach(() => {
    reg = new WindowRegistry();
    reg.registerWindow(100, Date.now());
    reg.registerWindow(200, Date.now());
  });

  it('subscribe adds windowId to the session subscriber set', () => {
    reg.subscribe('sess-1', 100);
    expect(reg.getSubscribers('sess-1')).toEqual(new Set([100]));
  });

  it('subscribe tolerates duplicate calls', () => {
    reg.subscribe('sess-1', 100);
    reg.subscribe('sess-1', 100);
    expect(reg.getSubscribers('sess-1').size).toBe(1);
  });

  it('two windows can subscribe to the same session', () => {
    reg.subscribe('sess-1', 100);
    reg.subscribe('sess-1', 200);
    expect(reg.getSubscribers('sess-1')).toEqual(new Set([100, 200]));
  });

  it('unsubscribe removes only the given windowId', () => {
    reg.subscribe('sess-1', 100);
    reg.subscribe('sess-1', 200);
    reg.unsubscribe('sess-1', 100);
    expect(reg.getSubscribers('sess-1')).toEqual(new Set([200]));
  });

  it('getSubscribers returns empty set when no subscribers', () => {
    expect(reg.getSubscribers('sess-unknown')).toEqual(new Set());
  });

  it('releaseAllSubscriptionsForWindow removes that window from every session', () => {
    reg.subscribe('sess-1', 100);
    reg.subscribe('sess-2', 100);
    reg.subscribe('sess-2', 200);
    reg.releaseAllSubscriptionsForWindow(100);
    expect(reg.getSubscribers('sess-1')).toEqual(new Set());
    expect(reg.getSubscribers('sess-2')).toEqual(new Set([200]));
  });

  it('emits changed on subscribe/unsubscribe', () => {
    let count = 0;
    reg.on('changed', () => count++);
    reg.subscribe('sess-1', 100);
    reg.unsubscribe('sess-1', 100);
    expect(count).toBe(2);
  });
});
