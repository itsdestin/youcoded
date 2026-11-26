// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { announceSettingsRepaired, SETTINGS_REPAIR_MESSAGE } from './settings-repair-notice';
import { APP_NOTICE_EVENT, type AppNoticeDetail } from './announce';

// Card #11 a: the wording must never guess at a cause (docs/error-message-standards.md), and the button must reveal the saved file.
describe('settings repair notice', () => {
  it('says what happened, claims no cause, and its button shows the kept copy', () => {
    const show = vi.fn();
    (window as any).claude = { shell: { showItemInFolder: show } };
    let got: AppNoticeDetail | undefined;
    window.addEventListener(APP_NOTICE_EVENT, (e) => { got = (e as CustomEvent<AppNoticeDetail>).detail; }, { once: true });
    announceSettingsRepaired('/h/.claude/settings.json.corrupt-x');
    expect(got?.message).toBe(SETTINGS_REPAIR_MESSAGE);
    expect(SETTINGS_REPAIR_MESSAGE).not.toMatch(/corrupt|crash|because|caused|disk|virus/i);
    got?.action?.onClick();
    expect(show).toHaveBeenCalledWith('/h/.claude/settings.json.corrupt-x');
  });

  // Card #11 a, deck C-1: on a phone the words show but the dead "Show file" button does not.
  it('a phone gets the words without the button', async () => {
    vi.resetModules();
    vi.doMock('../platform', () => ({ isAndroid: () => false, isRemoteMode: () => true }));
    const mod = await import('./settings-repair-notice');
    const ann = await import('./announce');
    let got: any;
    window.addEventListener(ann.APP_NOTICE_EVENT, (e) => { got = (e as CustomEvent).detail; }, { once: true });
    mod.announceSettingsRepaired('/h/.claude/settings.json.corrupt-x');
    expect(got.message).toBe(mod.SETTINGS_REPAIR_MESSAGE);
    expect(got.action).toBeUndefined();
  });
  afterEach(() => { vi.doUnmock('../platform'); });
});
