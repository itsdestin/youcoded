// Who may type while a session is starting.
import { describe, it, expect } from 'vitest';
import { composerDisabled, promptShowMeansStarted } from '../src/renderer/state/startup-dialog-store';

describe('composerDisabled', () => {
  const base = { trustGate: false, moved: false, started: false, terminalTouch: false };

  it('chat view stays gated until the session has started (text would land in a startup dialog)', () => {
    expect(composerDisabled(base)).toBe(true);
    expect(composerDisabled({ ...base, started: true })).toBe(false);
  });

  it('terminal view on a touch device is the terminal\'s keyboard — usable before the start, to answer a startup dialog', () => {
    expect(composerDisabled({ ...base, terminalTouch: true })).toBe(false);
  });

  it('the trust gate and a moved session still switch it off everywhere', () => {
    expect(composerDisabled({ ...base, started: true, terminalTouch: true, trustGate: true })).toBe(true);
    expect(composerDisabled({ ...base, started: true, terminalTouch: true, moved: true })).toBe(true);
  });

  it('only Android\'s ready signal counts as "started"', () => {
    expect(promptShowMeansStarted('_session_ready')).toBe(true);
    expect(promptShowMeansStarted('menu_x')).toBe(false);
  });
});

import { startedIds } from '../src/renderer/state/startup-dialog-store';
describe('startedIds (a window or phone connecting mid-startup)', () => {
  it('leaves out sessions the host says are still on their startup dialogs', () => {
    expect(startedIds([
      { id: 'running' },
      { id: 'on-trust-dialog', awaitingStart: true },
      { id: 'explicitly-started', awaitingStart: false },
    ])).toEqual(['running', 'explicitly-started']);
  });
});
