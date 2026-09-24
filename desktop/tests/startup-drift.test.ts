// The drift check (test-conpty/check-startup-drift.mjs) compares Claude Code's
// startup dialogs structurally. These pin that it names the changes that broke
// the app before — and that its reading of the saved captures is stable.
import { describe, it, expect } from 'vitest';
import { readDialogShape, shapeSummary, diffSummaries } from '../test-conpty/startup-dialog-shape.mjs';
import { FixtureTerminal, listPlanFixtures, loadPlanFixture, STARTUP_FIXTURE_DIR } from './helpers/plan-menu-fixtures';

const RULE = '─'.repeat(80);
const trust = (rows: string[]) => [RULE, ' Accessing workspace:', '', ' /tmp/x', '', ' Security guide', '', ...rows, '', ' Enter to confirm · Esc to cancel'];
const TODAY = shapeSummary(readDialogShape(trust([' ❯ No, exit', '   Yes, I trust this folder'])));

describe('startup-dialog drift diff', () => {
  it('names the 2.1.281 break: numbers gone, order swapped, cursor moved', () => {
    const before = shapeSummary(readDialogShape(trust([' ❯ 1. Yes, I trust this folder', '   2. No, exit'])));
    const { breaking } = diffSummaries('trust', before, TODAY);
    expect(breaking.join('\n')).toMatch(/how an option is picked changed: numbered-digits → cursor-arrows/);
    expect(breaking.join('\n')).toMatch(/options changed \[Yes, I trust this folder \| No, exit\] → \[No, exit \| Yes, I trust this folder\]/);
  });

  it('names a reworded heading (the 2.1.2xx trust rewrite)', () => {
    const before = shapeSummary(readDialogShape([RULE, ' Do you trust the files in this folder?', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel']));
    expect(diffSummaries('trust', before, TODAY).breaking.join('\n')).toMatch(/heading changed/);
  });

  it('names a dialog that appears where there was none, and one that disappears', () => {
    expect(diffSummaries('d', { present: false }, TODAY).breaking[0]).toMatch(/now appears/);
    expect(diffSummaries('d', TODAY, { present: false }).breaking[0]).toMatch(/no longer appears/);
  });

  it('treats a temp path in the heading or body as the same dialog', () => {
    const a = shapeSummary(readDialogShape(trust([' ❯ No, exit', '   Yes, I trust this folder']).map((l) => l.replace('/tmp/x', '/tmp/startup-abc/project'))));
    expect(diffSummaries('trust', TODAY, a)).toEqual({ breaking: [], notes: [] });
  });

  it('reads every saved capture exactly as it recorded it (the comparison is stable)', async () => {
    for (const f of listPlanFixtures(STARTUP_FIXTURE_DIR)) {
      const fx = loadPlanFixture(f, STARTUP_FIXTURE_DIR) as any;
      for (const [i, m] of fx.marks.filter((x: any) => /^dialog-\d+-visible$/.test(x.label)).entries()) {
        const t = new FixtureTerminal(fx);
        await t.advanceToMark(m.label);
        const shape = shapeSummary(readDialogShape(t.androidScreen().split('\n')));
        t.dispose();
        expect(diffSummaries(`${fx.key} dialog ${i + 1}`, fx.dialogs[i], shape)).toEqual({ breaking: [], notes: [] });
      }
    }
  });
});
