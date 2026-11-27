// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { dispatchSlashCommand } from '../src/renderer/state/slash-command-dispatcher';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { resetFailureDedupeForTests } from '../src/renderer/utils/report-failure';
import { ANDROID_LOCAL_CAPABILITIES } from '../src/shared/capabilities';

// R-1 batch 1: /fast and /effort saved nothing visible when the save failed, and /fast read "only" as "on".
const toasts: string[] = [];
const on = (e: Event) => toasts.push((e as CustomEvent).detail.message);
const run = (raw: string) => dispatchSlashCommand({ raw, sessionId: 's', view: 'chat', files: [], dispatch: () => {}, timeline: [], callbacks: {}, deferUiEffectsToRuntime: false });
let set: ReturnType<typeof vi.fn>;
beforeEach(() => {
  toasts.length = 0; resetFailureDedupeForTests(); window.addEventListener(APP_NOTICE_EVENT, on);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  set = vi.fn().mockResolvedValue(undefined);
  (window as any).claude = { capabilities: { ...ANDROID_LOCAL_CAPABILITIES, sessionRecord: false, terminalTransport: 'raw-bytes' }, modes: { set } };
});
afterEach(() => { window.removeEventListener(APP_NOTICE_EVENT, on); delete (window as any).claude; vi.restoreAllMocks(); });

describe('/fast and /effort', () => {
  it('only an exact on / true / 1 turns Fast mode on', () => {
    for (const [arg, want] of [['on', true], ['TRUE', true], ['1', true], ['off', false], ['only', false], ['version-1', false]] as const) {
      set.mockClear(); run(`/fast ${arg}`);
      expect(set).toHaveBeenCalledWith({ fast: want });
    }
  });
  it('says so when the save fails, and says nothing when it works', async () => {
    run('/fast on'); await new Promise((r) => setTimeout(r, 10));
    expect(toasts).toEqual([]);
    set.mockRejectedValue(new Error('disk full'));
    run('/fast on'); run('/effort high');
    await vi.waitFor(() => expect(toasts).toEqual(["Couldn't save Fast mode.", "Couldn't save the effort level."]));
  });
});
