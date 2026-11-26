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
} from '../src/renderer/state/chat-notice-store';
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
