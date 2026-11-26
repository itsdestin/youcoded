// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
// The notice strip above a chat's message box (waiting-notice T1): it leaves by itself when its reason is
// gone, orders its buttons as Destin asked, and lays them under the words on a phone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { ChatNoticeStrip } from '../src/renderer/components/ChatNoticeStrip';
import { ChatProvider, useChatStore } from '../src/renderer/state/chat-context';
import {
  showChatNotice, clearChatNotice, getChatNotice, stillBusy, stillNotLive, stillTransferring, type ChatNotice,
  setNoticeViewer, markFailureSeen, getUnseenFailureIds, subscribeUnseenFailures,
} from '../src/renderer/state/chat-notice-store';
import { raiseFailed, raiseCant, raiseBusy, raiseNotRunning } from '../src/renderer/state/raise-notice';
import { runNativeSlashAction } from '../src/renderer/state/native-slash-actions';
import { busyWith, MESSAGE_UNSURE, STOP_UNSURE } from '../src/renderer/utils/notice-words';
import { setScreenInputBlock, getScreenInputBlock, clearScreenInputBlocks, subscribeScreenInputBlocks } from '../src/renderer/state/screen-input-store';
import { isTurnBusy } from '../src/renderer/hooks/useStreamingGate';
import { REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';

const SID = 'sess-notice';
const base: ChatNotice = { key: 'k', tone: 'warn', leave: 'resolved', text: 'Held back.' };

let narrow = false;
function stubViewport() {
  // narrow-viewport.md: declare the viewport; jsdom has no matchMedia of its own.
  window.matchMedia = ((q: string) => ({
    matches: narrow && q.includes('639.98'), media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null,
  })) as unknown as typeof window.matchMedia;
}

let storeRef: ReturnType<typeof useChatStore>;
function Grab() { storeRef = useChatStore(); return null; }
const mount = (props: Partial<React.ComponentProps<typeof ChatNoticeStrip>> = {}) =>
  render(<ChatProvider><Grab /><ChatNoticeStrip sessionId={SID} {...props} /></ChatProvider>);

beforeEach(() => { narrow = false; stubViewport(); clearScreenInputBlocks(); });
afterEach(() => { clearChatNotice(SID); cleanup(); clearScreenInputBlocks(); delete (window as any).claude; vi.useRealTimers(); });

describe('the strip leaves when its reason is gone', () => {
  it('held back clears when the pop-up closes, with no send and no Dismiss', () => {
    (window as any).claude = { capabilities: { ...REMOTE_SCREEN_CAPABILITIES, sessionRecord: true } };
    setScreenInputBlock(SID, { kind: 'popup', heading: 'Switch model?' });
    const { container } = mount();
    // The same test the real held-back notice uses: still blocked?
    act(() => showChatNotice(SID, { ...base, stillTrue: () => !!getScreenInputBlock(SID) }));
    expect(screen.getByText('Held back.')).toBeInTheDocument();
    act(() => setScreenInputBlock(SID, null));
    expect(getChatNotice(SID)).toBeUndefined();
    expect(container.textContent).toBe('');
  });

  it('stays while the reason still holds, even as the chat changes', () => {
    mount();
    act(() => showChatNotice(SID, { ...base, stillTrue: () => true }));
    act(() => storeRef.dispatch({ type: 'SESSION_INIT', sessionId: SID } as any));
    expect(getChatNotice(SID)).toBeDefined();
  });

  it('a notice with no test is left alone by chat and pop-up changes', () => {
    mount();
    act(() => showChatNotice(SID, base));
    act(() => setScreenInputBlock(SID, { kind: 'popup', heading: 'x' }));
    act(() => setScreenInputBlock(SID, null));
    expect(getChatNotice(SID)).toBeDefined();
  });

  it('asks once on showing, so a chat opened after the reason went away shows nothing', () => {
    showChatNotice(SID, { ...base, stillTrue: () => false });
    mount();
    expect(getChatNotice(SID)).toBeUndefined();
  });

  it('stops listening once the notice is gone (a streamed reply then costs the strip nothing)', () => {
    const test = vi.fn(() => true);
    mount();
    act(() => showChatNotice(SID, { ...base, stillTrue: test }));
    act(() => storeRef.dispatch({ type: 'SESSION_INIT', sessionId: SID } as any));
    expect(test).toHaveBeenCalled();                 // control: it does listen while a notice is up
    act(() => clearChatNotice(SID));
    test.mockClear();
    act(() => storeRef.dispatch({ type: 'SESSION_INIT', sessionId: SID } as any));
    act(() => setScreenInputBlock(SID, { kind: 'popup', heading: 'z' }));
    expect(test).not.toHaveBeenCalled();
  });

  describe('the 1 s re-check', () => {
    it('runs only where the host reads terminal text itself, and only in the visible chat view', () => {
      vi.useFakeTimers();
      let blocked = true;
      const notice = { ...base, recheckEverySecond: true, stillTrue: () => blocked };
      // Android's own runtime: no session record.
      (window as any).claude = { capabilities: { ...REMOTE_SCREEN_CAPABILITIES, sessionRecord: false } };
      const view = mount({ chatVisible: false });
      act(() => showChatNotice(SID, notice));
      blocked = false;
      act(() => { vi.advanceTimersByTime(3000); });
      expect(getChatNotice(SID)).toBeDefined();           // terminal view: no timer
      view.rerender(<ChatProvider><Grab /><ChatNoticeStrip sessionId={SID} chatVisible /></ChatProvider>);
      act(() => { vi.advanceTimersByTime(1100); });
      expect(getChatNotice(SID)).toBeUndefined();          // chat view: the timer caught it
    });

    it('does not run on a host that publishes the reading (a window, a phone)', () => {
      vi.useFakeTimers();
      let blocked = true;
      (window as any).claude = { capabilities: { ...REMOTE_SCREEN_CAPABILITIES, sessionRecord: true } };
      mount();
      act(() => showChatNotice(SID, { ...base, recheckEverySecond: true, stillTrue: () => blocked }));
      blocked = false;
      act(() => { vi.advanceTimersByTime(5000); });
      expect(getChatNotice(SID)).toBeDefined();
    });
  });
});


describe('screen-input-store tells listeners only when a reading changes', () => {
  it('notifies on a change and on clear, never for an identical reading', () => {
    const seen = vi.fn();
    const off = subscribeScreenInputBlocks(seen);
    setScreenInputBlock('a', { kind: 'popup', heading: 'h' });
    setScreenInputBlock('a', { kind: 'popup', heading: 'h' });
    expect(seen).toHaveBeenCalledTimes(1);
    setScreenInputBlock('a', null);
    setScreenInputBlock('a', null);
    expect(seen).toHaveBeenCalledTimes(2);
    setScreenInputBlock('a', { kind: 'popup', heading: 'h' });
    clearScreenInputBlocks();
    expect(seen).toHaveBeenCalledTimes(4);
    off();
  });
});

describe('busy / not-live / transfer tests', () => {
  const session = (over: object) => ({ isThinking: false, attentionState: 'ok', ...over }) as any;
  it('busy follows the Stop button, including the lost-message state', () => {
    expect(isTurnBusy(session({ isThinking: true }))).toBe(true);
    // The turn is over (died / error) even though isThinking never cleared: the notice must be allowed to leave.
    expect(isTurnBusy(session({ isThinking: true, attentionState: 'session-died' }))).toBe(false);
    expect(isTurnBusy(session({ isThinking: true, attentionState: 'error' }))).toBe(false);
    expect(isTurnBusy(session({ isThinking: false }))).toBe(false);
    let s: any = session({ isThinking: true });
    const test = stillBusy(() => s);
    expect(test()).toBe(true);
    s = session({ isThinking: true, attentionState: 'error' });
    expect(test()).toBe(false);
    expect(stillBusy(() => undefined)()).toBe(false);
  });
  it('not-live and transferring are the caller\'s own tests, flipped as asked', () => {
    let live = false; let moving = true;
    expect(stillNotLive(() => live)()).toBe(true);
    live = true; expect(stillNotLive(() => live)()).toBe(false);
    expect(stillTransferring(() => moving)()).toBe(true);
    moving = false; expect(stillTransferring(() => moving)()).toBe(false);
  });
});

describe('buttons', () => {
  const ordered = () => screen.getAllByRole('button').map((b) => b.textContent);
  it('Dismiss is leftmost; outlined ones next; the filled one is rightmost, whatever order they were listed', () => {
    mount();
    act(() => showChatNotice(SID, { ...base, actions: [
      { label: 'Send anyway', primary: true, onClick: () => {} },
      { label: 'Show card', onClick: () => {} },
    ] }));
    expect(ordered()).toEqual(['Dismiss', 'Show card', 'Send anyway']);
  });
  it('Dismiss takes the notice away', () => {
    mount();
    act(() => showChatNotice(SID, base));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(getChatNotice(SID)).toBeUndefined();
  });
  it('an action runs its own click', () => {
    const onClick = vi.fn();
    mount();
    act(() => showChatNotice(SID, { ...base, actions: [{ label: 'Stop', onClick }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('tone and layout', () => {
  it('an error is announced at once (role alert); a warning waits its turn (role status)', () => {
    mount();
    act(() => showChatNotice(SID, { ...base, tone: 'error', text: 'Failed.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed.');
    act(() => showChatNotice(SID, base));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Held back.');
  });
  it('on a phone the buttons sit on their own full-width line under the words', () => {
    narrow = true; stubViewport();
    mount();
    act(() => showChatNotice(SID, { ...base, actions: [{ label: 'Go', primary: true, onClick: () => {} }] }));
    const strip = document.querySelector('.status-strip')!;
    expect(strip.className).toContain('flex-col');                   // words above, buttons below
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.className).toContain('flex-1');                   // buttons share the full line
    expect(dismiss.parentElement!.className).toContain('w-full');
  });
  it('on a wide screen the buttons sit beside the words', () => {
    mount();
    act(() => showChatNotice(SID, base));
    expect(document.querySelector('.status-strip')!.className).not.toContain('flex-col');
  });
});


describe('a notice is raised for the chat the action was for', () => {
  afterEach(() => { clearChatNotice('bg'); clearChatNotice('fg'); setNoticeViewer('main', null); markFailureSeen('bg'); markFailureSeen('fg'); });

  it('a failure raised for a background chat lands in that chat\'s strip and marks its dot; the chat on screen gets neither', () => {
    setNoticeViewer('main', 'fg');
    raiseFailed('bg', 'skill-failed', "Couldn't run /review.");
    expect(getChatNotice('bg')?.text).toBe("Couldn't run /review.");
    expect(getChatNotice('fg')).toBeUndefined();
    expect([...getUnseenFailureIds()]).toEqual(['bg']);
  });

  it('opening the chat clears its dot, and a failure for the chat you are looking at never marks one', () => {
    setNoticeViewer('main', 'fg');
    raiseFailed('bg', 'skill-failed', 'x');
    setNoticeViewer('main', 'bg');                       // switched to it
    expect(getUnseenFailureIds().has('bg')).toBe(false);
    raiseFailed('bg', 'skill-failed', 'again');           // raised while looking at it
    expect(getUnseenFailureIds().has('bg')).toBe(false);
  });

  it('a notice the person dismisses takes its dot with it, and a can\'t-do-now notice never makes one', () => {
    setNoticeViewer('main', 'fg');
    raiseFailed('bg', 'k', 'x');
    clearChatNotice('bg');
    expect(getUnseenFailureIds().has('bg')).toBe(false);
    raiseCant('bg', 'c', 'Not here.');
    expect(getUnseenFailureIds().size).toBe(0);
  });

  it('tells its one subscriber only when the set really changes', () => {
    const seen = vi.fn();
    const off = subscribeUnseenFailures(seen);
    setNoticeViewer('main', 'fg');
    raiseFailed('bg', 'k', 'x'); raiseFailed('bg', 'k', 'y');   // the second changes nothing
    expect(seen).toHaveBeenCalledTimes(1);
    markFailureSeen('bg'); markFailureSeen('bg');
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('"still working" notices leave when the reply ends', () => {
  afterEach(() => { clearChatNotice(SID); delete (window as any).claude; });

  it('compacting while a reply is being written shows a Stop button, and the notice goes when the turn ends', async () => {
    let session: any = { isThinking: true, attentionState: 'ok' };
    (window as any).claude = { native: { compact: vi.fn().mockResolvedValue({ ok: false, reason: 'turn-in-flight' }), interrupt: vi.fn() } };
    mount();
    await act(async () => { await runNativeSlashAction({ kind: 'compact' } as any, { sessionId: SID, dispatch: vi.fn(), getSession: () => session }); });
    expect(screen.getByText(busyWith('compact'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect((window as any).claude.native.interrupt).toHaveBeenCalledWith(SID);
    session = { isThinking: false, attentionState: 'ok' };            // the reply ended
    act(() => storeRef.dispatch({ type: 'SESSION_INIT', sessionId: SID } as any));
    expect(getChatNotice(SID)).toBeUndefined();
  });

  it('when this screen never saw the reply running, the notice does not vanish unread: it waits for the next action', () => {
    raiseBusy(SID, 'clear-busy', 'busy', { getSession: () => ({ isThinking: false, attentionState: 'ok' }) as any, stop: () => {} });
    expect(getChatNotice(SID)?.stillTrue).toBeUndefined();
    expect(getChatNotice(SID)?.leave).toBe('next-action');
  });

  it('"not running" leaves once the chat is running again, and only if it was seen ending', () => {
    let session: any = { isThinking: false, attentionState: 'session-died' };
    raiseNotRunning(SID, 'compact-not-live', 'off', () => session);
    expect(getChatNotice(SID)?.stillTrue?.()).toBe(true);
    session = { isThinking: true, attentionState: 'ok' };
    expect(getChatNotice(SID)?.stillTrue?.()).toBe(false);
    raiseNotRunning(SID, 'compact-not-live', 'off', () => ({ isThinking: false, attentionState: 'ok' }) as any);
    expect(getChatNotice(SID)?.stillTrue).toBeUndefined();            // no signal to wait for
  });

  it('a skill that fails with the computer\'s own technical text shows only a plain sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as any).claude = { native: { invokeSkill: vi.fn().mockResolvedValue({ ok: false, reason: 'error', detail: 'ENOENT: /home/x/.claude/skills/review/SKILL.md' }) } };
    await runNativeSlashAction({ kind: 'invoke-skill', skill: 'review' } as any, { sessionId: SID, dispatch: vi.fn() });
    expect(getChatNotice(SID)?.text).toBe("Couldn't run /review.");
    expect(getChatNotice(SID)?.tone).toBe('error');
    expect(getChatNotice(SID)?.actions?.map((a) => a.label)).toEqual(['Try again']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/review'), 'error', 'ENOENT: /home/x/.claude/skills/review/SKILL.md');
    warn.mockRestore();
  });

  it('two skills with one name ask which one, and pressing one runs that skill', async () => {
    const invokeSkill = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'ambiguous', detail: "Several plugins provide a skill called 'review': a:review, b:review." })
      .mockResolvedValueOnce({ ok: true });
    const skills = { list: vi.fn().mockResolvedValue([{ id: 'a:review' }, { id: 'b:review' }, { id: 'a:other' }]) };
    (window as any).claude = { native: { invokeSkill }, skills };
    await runNativeSlashAction({ kind: 'invoke-skill', skill: 'review', args: 'now' } as any, { sessionId: SID, dispatch: vi.fn() });
    const notice = getChatNotice(SID)!;
    expect(notice.text).toBe('Two skills are called /review. Which one did you mean?');
    expect(notice.tone).toBe('warn');
    expect(notice.actions?.map((a) => a.label)).toEqual(['a:review', 'b:review']);
    await act(async () => { notice.actions![1].onClick(); });
    // The second call names the full id and keeps what was typed after the command; the question is gone.
    expect(invokeSkill).toHaveBeenLastCalledWith(SID, 'b:review', 'now');
    expect(getChatNotice(SID)).toBeUndefined();
  });

  it('two same-named skills the list cannot name fall back to the sentence that names them', async () => {
    (window as any).claude = {
      native: { invokeSkill: vi.fn().mockResolvedValue({ ok: false, reason: 'ambiguous', detail: "two skills match (a:review, b:review)" }) },
      skills: { list: vi.fn().mockResolvedValue([]) },
    };
    await runNativeSlashAction({ kind: 'invoke-skill', skill: 'review' } as any, { sessionId: SID, dispatch: vi.fn() });
    expect(getChatNotice(SID)?.text).toBe("Couldn't run /review: two skills match (a:review, b:review)");
  });

  it('the unconfirmed Stop and the unsent message each have one approved sentence', () => {
    expect(STOP_UNSURE).toBe("Can't tell if Stop went through. If Claude is still working, press Stop again.");
    expect(MESSAGE_UNSURE).toBe("Can't tell if your message was sent. Check the chat before sending it again.");
  });
});
