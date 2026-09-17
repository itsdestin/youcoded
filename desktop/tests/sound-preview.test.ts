import { describe, it, expect } from 'vitest';
import { STOCK_PRESETS } from '../src/renderer/utils/sounds';

// Guard for the audition bug: you must be able to HEAR a preset.
//
// The original defect was that hearing a sound and assigning it were welded
// into one handler with no way to do the first alone, so shopping through 15
// presets overwrote the setting 15 times.
//
// The first fix split them: a radio assigned, a play button auditioned. That
// was reversed by an explicit design decision on 2026-07-26 -- with one shared
// list behind a category toggle, assigning IS how you listen, and a separate
// play button was just a second thing to aim at. So the invariant is no longer
// "these must be separate"; it is "selecting must make a sound." A future
// session that drops playPreview from the select path would silently restore a
// picker you cannot hear, which is the same bug wearing different clothes.
// WHY that check is not here (Plan B, 2026-09-16): it read SettingsPanel.tsx as
// text; it is now the ast-grep rule select-preset-calls-playpreview in
// youcoded-dev's scripts/ast-grep/rules/.

describe('sound presets', () => {
  it('every stock preset carries a description', () => {
    expect(STOCK_PRESETS.length).toBeGreaterThan(10);
    for (const preset of STOCK_PRESETS) {
      expect(preset.desc, `${preset.id} needs a desc`).toBeTruthy();
    }
  });
});
