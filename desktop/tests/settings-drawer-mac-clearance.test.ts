import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readSource, RENDERER } from './helpers/guard-scope';

// WHY a source-text guard (kept from primitive-adoption.test.ts when its style checks were dropped, 2026-11-02):
// it couples a .tsx class to a .css rule, which no ast-grep rule can express, and the failure shows only on macOS —
// the Settings drawer's first row slides under the window's traffic-light buttons, which no Linux or Windows
// session (or the Linux screenshot review) would ever notice.
describe('Settings drawer on macOS', () => {
  it('keeps its clearance below the traffic-light buttons', () => {
    // Either the header or the body may carry the clearance; having the element without its padding rule is the bug.
    const panel = readSource(join(RENDERER, 'components', 'SettingsPanel.tsx'));
    const css = readSource(join(RENDERER, 'styles', 'globals.css'));
    const anchor = panel.includes('settings-drawer-header') ? 'settings-drawer-header' : 'settings-drawer-body';
    expect(panel, 'The drawer must carry one of the two clearance anchors.').toContain(anchor);
    expect(
      css.match(new RegExp(`\\.mac-titlebar-inset \\.${anchor}\\s*\\{\\s*padding-top`)),
      `SettingsPanel uses .${anchor}, so globals.css must pad THAT selector — otherwise macOS renders the drawer under the traffic lights.`,
    ).not.toBeNull();
  });
});
