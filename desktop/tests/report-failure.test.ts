// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportFailure, resetFailureDedupeForTests } from '../src/renderer/utils/report-failure';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';

// R-1: the shared way to say "that did not work". Pins: toast words, log always carries the real cause,
// repeats merge, 'inline' and 'log-only' never pop up, and no cause is invented.
const toasts: string[] = [];
const on = (e: Event) => toasts.push((e as CustomEvent).detail.message);
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { toasts.length = 0; resetFailureDedupeForTests(); window.addEventListener(APP_NOTICE_EVENT, on); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { window.removeEventListener(APP_NOTICE_EVENT, on); vi.restoreAllMocks(); });

describe('reportFailure', () => {
  it('toast: says only the plain fact, keeps the real cause in the log', () => {
    reportFailure({ what: 'save Fast mode', cause: new Error('EACCES /x'), where: 't', show: 'toast' });
    expect(toasts).toEqual(["Couldn't save Fast mode."]);
    expect(warn.mock.calls.flat().join(' ')).toContain('EACCES /x');
  });
  it('merges the same failure within 30 seconds into one pop-up', () => {
    for (let i = 0; i < 3; i++) reportFailure({ what: 'save Fast mode', where: 't', show: 'toast' });
    expect(toasts).toHaveLength(1);
    reportFailure({ what: 'save the effort level', where: 't', show: 'toast' });
    expect(toasts).toHaveLength(2);
  });
  it('inline and log-only never pop up; inline hands back the plain cause and invents none', () => {
    expect(reportFailure({ what: 'x', cause: new Error('disk full'), where: 't', show: 'inline' })).toBe('disk full');
    expect(reportFailure({ what: 'x', where: 't', show: 'inline' })).toBe('');
    reportFailure({ what: 'y', cause: 'boom', where: 't', show: 'log-only' });
    expect(toasts).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('boom');
  });
});
