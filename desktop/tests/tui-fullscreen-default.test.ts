import { describe, it, expect } from 'vitest';
import { seedTuiFullscreenInto } from '../src/main/tui-fullscreen-default';

// The phone's Claude Code starts in its "fullscreen" display mode unless the user chose a mode
// (Destin, 2026-11-08: "okay" to fullscreen plus the swipe fix). In the default mode a phone
// rotation reprints the screen and doubles lines in terminal view; fullscreen cannot.
describe('seedTuiFullscreenInto', () => {
  it('sets fullscreen when the user never chose a display mode', () => {
    const s: Record<string, unknown> = { hooks: {} };
    expect(seedTuiFullscreenInto(s)).toEqual({ changed: true, effective: 'fullscreen' });
    expect(s).toEqual({ hooks: {}, tui: 'fullscreen' });
  });

  it('leaves a user\'s own choice alone, including going back to the default mode', () => {
    // `/tui default` inside Claude Code writes exactly this (investigation 2026-11-08).
    const s: Record<string, unknown> = { tui: 'default' };
    expect(seedTuiFullscreenInto(s)).toEqual({ changed: false, effective: 'default' });
    expect(s).toEqual({ tui: 'default' });
  });

  it('leaves an unexpected value alone rather than guessing', () => {
    const s: Record<string, unknown> = { tui: 42 };
    expect(seedTuiFullscreenInto(s).changed).toBe(false);
    expect(s.tui).toBe(42);
  });
});
