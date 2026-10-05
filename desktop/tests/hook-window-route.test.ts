// Which windows a hook event reaches (one-core sync-fix3 review): the end of an ask also reaches the buddy chat that watches the session.
import { describe, it, expect } from 'vitest';
import { hookWindowTargets } from '../src/main/hook-window-route';

describe('hookWindowTargets', () => {
  it('a new ask goes to the owner only, as it always did', () => {
    expect(hookWindowTargets({ type: 'PermissionRequest' }, 1, [7])).toEqual([1]);
  });
  it.each(['PermissionResolved', 'PermissionExpired', 'PasswordResolved'])('%s also reaches the watching buddy, so a card drawn from its fill clears', (type) => {
    expect(hookWindowTargets({ type }, 1, [7, 1])).toEqual([1, 7]);
  });
  it('with no owner and no main window nothing is delivered, and a watcher alone still hears an ask end', () => {
    expect(hookWindowTargets({ type: 'PermissionRequest' }, null, [7])).toEqual([]);
    expect(hookWindowTargets({ type: 'PermissionResolved' }, null, [7])).toEqual([7]);
  });
  it('an unknown or missing event reaches only the owner', () => {
    expect(hookWindowTargets(null, 1, [7])).toEqual([1]);
    expect(hookWindowTargets({ type: 'SessionStart' }, 1, [7])).toEqual([1]);
  });
});
