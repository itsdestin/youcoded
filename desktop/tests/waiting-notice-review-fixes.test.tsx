// @vitest-environment jsdom
// One test per bug found by the waiting-notice code review (docs/active/reviews/2026-11-26-waiting-notice-code-review.md).
// Each was written to fail against the code as reviewed. F5 (close detail) lives in instant-buttons.test.tsx, F8 in ipc-handlers.test.ts.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  clearChatNotice, getChatNotice, getUnseenFailureIds, markChatClosed, markChatsOpen, noticeViewerFor, setNoticeViewer, showChatNotice,
} from '../src/renderer/state/chat-notice-store';
import { runNativeSlashAction } from '../src/renderer/state/native-slash-actions';
import { createConversationQueueActions } from '../src/renderer/state/conversation-queue-actions';
import { QUEUE_ACTION_UNSURE, SKILL_UNREADABLE } from '../src/renderer/utils/notice-words';

const notice = (tone: 'warn' | 'error', key = 'k') => ({ key, text: 'x', tone, leave: 'next-action' as const });

describe('F1 — Try again on a skill notice clears the notice once the skill runs', () => {
  afterEach(() => { clearChatNotice('s1'); delete (window as any).claude; });
  it('removes "That skill is installed, but…" after a successful retry', async () => {
    const invokeSkill = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
      .mockResolvedValueOnce({ ok: true });
    (window as any).claude = { native: { invokeSkill } };
    await runNativeSlashAction({ kind: 'invoke-skill', skill: 'review' } as never, { sessionId: 's1', dispatch: vi.fn() });
    expect(getChatNotice('s1')?.text).toBe(SKILL_UNREADABLE);
    getChatNotice('s1')!.actions![0].onClick();
    await waitFor(() => expect(invokeSkill).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getChatNotice('s1')).toBeUndefined());
  });
  it('keeps the notice when the retry fails again', async () => {
    const invokeSkill = vi.fn().mockResolvedValue({ ok: false, reason: 'unreadable' });
    (window as any).claude = { native: { invokeSkill } };
    await runNativeSlashAction({ kind: 'invoke-skill', skill: 'review' } as never, { sessionId: 's1', dispatch: vi.fn() });
    getChatNotice('s1')!.actions![0].onClick();
    await waitFor(() => expect(invokeSkill).toHaveBeenCalledTimes(2));
    expect(getChatNotice('s1')?.text).toBe(SKILL_UNREADABLE);
  });
});

describe('F4 — a native chat\'s queue actions that are not confirmed use the shared sentence and the strip', () => {
  afterEach(() => { clearChatNotice('s2'); delete (window as any).claude; vi.restoreAllMocks(); });
  const make = (toast = vi.fn()) => ({ toast, actions: createConversationQueueActions({ provider: () => 'native', composer: () => null, session: () => ({ queuedMessages: [] } as never), dispatch: vi.fn(), toast }) });
  it('Cancel after the message already started sending', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as any).claude = { native: { queueRemove: vi.fn(async () => false) } };
    const { toast, actions } = make();
    await actions.cancel('s2', 'q1');
    expect(toast).not.toHaveBeenCalled();
    expect(getChatNotice('s2')?.text).toBe(QUEUE_ACTION_UNSURE);
  });
  it('Send now that is not confirmed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as any).claude = { native: { queueSendNow: vi.fn(async () => false) } };
    const { toast, actions } = make();
    await actions.sendNow('s2', 'q1');
    expect(toast).not.toHaveBeenCalled();
    expect(getChatNotice('s2')?.text).toBe(QUEUE_ACTION_UNSURE);
  });
});

describe('F6 — a late failure for a chat that has closed is ignored', () => {
  afterEach(() => { markChatsOpen(['gone']); clearChatNotice('gone'); setNoticeViewer('main', null); });
  it('creates no notice and no red dot, and a resumed chat with the same id works again', () => {
    markChatClosed('gone');
    showChatNotice('gone', notice('error'));
    expect(getChatNotice('gone')).toBeUndefined();
    expect(getUnseenFailureIds().has('gone')).toBe(false);
    markChatsOpen(['gone']);
    showChatNotice('gone', notice('warn'));
    expect(getChatNotice('gone')).toBeDefined();
  });
  it('closing takes away the notice and dot it already had', () => {
    showChatNotice('gone', notice('error'));
    expect(getUnseenFailureIds().has('gone')).toBe(true);
    markChatClosed('gone');
    expect(getChatNotice('gone')).toBeUndefined();
    expect(getUnseenFailureIds().has('gone')).toBe(false);
  });
});

describe('F7 — replacing a red notice with an amber one drops the red dot', () => {
  afterEach(() => { clearChatNotice('bg7'); setNoticeViewer('main', null); });
  it('no dot is left with nothing red behind it', () => {
    setNoticeViewer('main', 'other');
    showChatNotice('bg7', notice('error'));
    expect(getUnseenFailureIds().has('bg7')).toBe(true);
    showChatNotice('bg7', notice('warn', 'k2'));
    expect(getUnseenFailureIds().has('bg7')).toBe(false);
  });
});

describe('a chat covered by a full-screen panel is not "seen"', () => {
  afterEach(() => { clearChatNotice('c1'); setNoticeViewer('main', null); });
  it('noticeViewerFor says nobody is looking at a chat while Settings (or another panel) covers it', () => {
    expect(noticeViewerFor({ viewMode: 'chat', sessionId: 'c1', covered: false })).toBe('c1');
    expect(noticeViewerFor({ viewMode: 'chat', sessionId: 'c1', covered: true })).toBeNull();
    expect(noticeViewerFor({ viewMode: 'terminal', sessionId: 'c1', covered: false })).toBeNull();
  });
  it('so a failure raised under the panel gets its red dot, and opening the chat takes it away', () => {
    setNoticeViewer('main', noticeViewerFor({ viewMode: 'chat', sessionId: 'c1', covered: true }));
    showChatNotice('c1', notice('error'));
    expect(getUnseenFailureIds().has('c1')).toBe(true);
    setNoticeViewer('main', noticeViewerFor({ viewMode: 'chat', sessionId: 'c1', covered: false }));
    expect(getUnseenFailureIds().has('c1')).toBe(false);
  });
});

describe('F9 — the compact/clear card\'s Try again can read the chat\'s state', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { cleanup(); vi.doUnmock('../src/renderer/state/control-failure-retry'); });
  it('passes getSession through to the retry', async () => {
    const retry = vi.fn(async () => true);
    vi.doMock('../src/renderer/state/control-failure-retry', () => ({ retryControlFailure: retry }));
    const { default: Row } = await import('../src/renderer/components/ChatTimelineRow');
    const getSession = vi.fn();
    const dispatch = vi.fn();
    render(React.createElement(Row as any, {
      entry: { kind: 'control-failure', id: 'cf1', op: 'compact' },
      entryKey: 'cf1', sessionId: 's9', showTimestamps: false, archived: false, archiveKind: null, foldHeight: undefined,
      attachEntry: () => {}, getEntryEl: () => undefined,
      actionsRef: { current: { promptSelect: vi.fn(), dispatch, getSession } },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledWith('s9', 'compact', dispatch, getSession);
  });
});
