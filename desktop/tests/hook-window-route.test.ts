// Which windows a hook event reaches: the owner, and the buddy chat watching the session — the start of an ask too.
import { describe, it, expect } from 'vitest';
import { hookWindowTargets } from '../src/main/hook-window-route';

describe('hookWindowTargets', () => {
  it('a new ask reaches the owner AND the watching buddy, so an open buddy shows the question at once', () => {
    expect(hookWindowTargets({ type: 'PermissionRequest' }, 1, [7])).toEqual([1, 7]);
  });
  it.each(['PermissionResolved', 'PermissionExpired', 'PasswordResolved'])('%s also reaches the watching buddy, so its card clears', (type) => {
    expect(hookWindowTargets({ type }, 1, [7, 1])).toEqual([1, 7]);
  });
  it('with no owner and no main window, the watcher alone still hears the ask', () => {
    expect(hookWindowTargets({ type: 'PermissionRequest' }, null, [7])).toEqual([7]);
  });
  it('a missing event reaches only the owner', () => {
    expect(hookWindowTargets(null, 1, [7])).toEqual([1]);
  });
});
