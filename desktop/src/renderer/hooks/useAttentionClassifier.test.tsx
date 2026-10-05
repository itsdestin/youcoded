// @vitest-environment jsdom
//
// Ownership test for the PTY attention classifier (F1, 2026-08-16).
//
// The classifier decides "is Claude Code stuck?" by reading the xterm PTY
// buffer every second. A NATIVE (harness) session has no PTY buffer at all —
// its attention state is owned by the harness stall heartbeat, which is what
// raises the red "Provider may have stalled" card. The bug this file pins:
// the classifier's cleanup branch dispatched ATTENTION_STATE_CHANGED → 'ok'
// for EVERY session with a non-'ok' state, including native ones, so it wiped
// a parked card it never created.
//
// Because `active` is constant-false for a native session, that cleanup ran
// exactly once — at ChatView mount — which is why ordinary desktop use never
// saw it (ChatView mounts long before a turn parks). It bit the remote path:
// a phone reconnecting to an already-parked desktop session gets the parked
// state from `chat:hydrate` BEFORE ChatView mounts, and the classifier threw
// it away, leaving the phone with a spinner and no Retry or Stop button.
//
// The dispatch is mocked rather than driven through a real ChatProvider on
// purpose: the assertion is literally "this hook dispatches nothing", and a
// no-op reducer action is invisible in reducer state (ok → ok changes
// nothing), so observing the store could not tell the two behaviours apart.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AttentionState } from '../state/chat-types';
import { ANDROID_LOCAL_CAPABILITIES, DESKTOP_WINDOW_CAPABILITIES } from '../../shared/capabilities';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../state/chat-context', () => ({ useChatDispatch: () => dispatch }));

import { useAttentionClassifier } from './useAttentionClassifier';

function mount(opts: {
  provider?: 'claude' | 'native';
  currentAttentionState: AttentionState;
  isThinking?: boolean;
}) {
  return renderHook(() =>
    useAttentionClassifier('s1', {
      // isThinking:false keeps the classifier inactive, which is the state a
      // native session is permanently in — it is the cleanup branch, not the
      // polling loop, that this file is about. No window.claude stub is needed
      // because the 1s tick never runs on this path.
      isThinking: opts.isThinking ?? false,
      hasRunningTools: false,
      hasAwaitingApproval: false,
      visible: true,
      currentAttentionState: opts.currentAttentionState,
      provider: opts.provider,
    }),
  );
}

const CLEAR_OK = { type: 'ATTENTION_STATE_CHANGED', sessionId: 's1', state: 'ok' };

describe('useAttentionClassifier — only clears attention for sessions it owns', () => {
  // This hook now runs only on a host with a terminal buffer and NO record of its own (the Android app's own runtime): everywhere else the
  // computer's main process owns the "may be stuck" reading (one-core R5-4b), and the last test below pins that the hook stays out of its way.
  beforeEach(() => { dispatch.mockClear(); (window as any).claude = { capabilities: ANDROID_LOCAL_CAPABILITIES }; });
  afterEach(() => { delete (window as any).claude; });

  it('dispatches NOTHING for a parked native session (no PTY buffer to read)', () => {
    mount({ provider: 'native', currentAttentionState: 'stalled' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches NOTHING for a native session on the amber stall warning either', () => {
    mount({ provider: 'native', currentAttentionState: 'stuck' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  // A native session that IS mid-turn still has no buffer, so the hook stays
  // inert. (`active` also requires hasBuffer, so this is the same branch —
  // pinned separately so a future edit can't make isThinking the deciding
  // factor for a session that has nothing to classify.)
  it('dispatches NOTHING for a parked native session that is still thinking', () => {
    mount({ provider: 'native', currentAttentionState: 'stalled', isThinking: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves the parked state alone when the native session unmounts', () => {
    const { unmount } = mount({ provider: 'native', currentAttentionState: 'stalled' });
    unmount();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // The control: Claude Code behaviour must be byte-identical to before the
  // fix. A PTY session sitting in a non-'ok' state while the classifier is
  // inactive still gets cleared, exactly once.
  it('STILL clears a stale banner for an inactive Claude Code session', () => {
    mount({ provider: 'claude', currentAttentionState: 'stuck' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(CLEAR_OK);
  });

  // An unset provider means "Claude Code" everywhere else in the renderer
  // (ChatView threads `session.provider` straight through and PTY sessions
  // predate the field), so it must keep the PTY behaviour.
  it('STILL clears a stale banner when provider is unset', () => {
    mount({ provider: undefined, currentAttentionState: 'stuck' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(CLEAR_OK);
  });

  it('dispatches nothing for a Claude Code session that is already ok', () => {
    mount({ provider: 'claude', currentAttentionState: 'ok' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('on a host whose main process reads the terminal (the computer\'s windows, every phone), neither sets nor clears anything', () => {
    (window as any).claude = { capabilities: DESKTOP_WINDOW_CAPABILITIES };
    mount({ provider: 'claude', currentAttentionState: 'stuck' });
    mount({ provider: 'claude', currentAttentionState: 'stuck', isThinking: true });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
