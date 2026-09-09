// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch, useChatStore } from '../state/chat-context';
import { SkillProvider } from '../state/skill-context';
import InputBar, { InputBarHandle } from './InputBar';
import type { VoiceEvent, VoiceReadiness } from '../../shared/voice-types';

// jsdom (per this repo's vitest.config.ts) has no global setupFiles/polyfills —
// useScrollFade (mounted unconditionally by InputBar's textarea) reaches for
// ResizeObserver, which jsdom doesn't implement. A no-op stub is enough since
// this test never asserts on the fade behavior itself.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Task 10: dispatch-capture idiom mirrored from selector-rerender.test.tsx —
// InputBar now reads chat state via useChatState(sessionId) for the stop
// button, so these tests need to drive the REAL store through the reducer
// (USER_PROMPT sets isThinking:true + attentionState:'ok'; ATTENTION_STATE_
// CHANGED flips attentionState alone) rather than mocking state directly —
// per the react-renderer rule, useChatState is the only approved render-path
// read, so exercising it through real dispatches is the honest way to cover
// the visibility predicate.
let capturedDispatch: ((a: any) => void) | null = null;
function DispatchCapture() {
  capturedDispatch = useChatDispatch();
  return null;
}

describe('InputBar native send — failure keeps the draft (reviewer Critical fix)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    // Minimal window.claude surface: only native.send is exercised by this
    // test's path (provider='native', plain non-slash text, no attachments).
    // session.sendInput is stubbed defensively — the CC/PTY branch is never
    // reached here, but other InputBar effects/handlers reference it.
    (window as any).claude = {
      native: {
        supported: true,
        send: vi.fn(),
      },
      session: {
        sendInput: vi.fn(),
      },
      // QuickChips (rendered unconditionally by InputBar) reads skills via
      // SkillProvider — stub every call it makes on mount so the tree doesn't
      // throw. Empty lists are fine; this test never interacts with chips.
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('restores the typed draft and shows a toast when the ack is failed', async () => {
    // Deferred so we control exactly when the ack resolves, mirroring the
    // real ~ms local-IPC round-trip send() races against.
    let resolveAck: (v: any) => void;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    expect(textarea.value).toBe('hello world');

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(sendButton);

    // send() runs synchronously: sendMessage returns true immediately (before
    // the ack settles) so the textarea clears right away, same as every other
    // provider path — this is the observable BEFORE the fix.
    expect(textarea.value).toBe('');

    // Now the ack resolves 'failed' — the bug: without the fix the draft
    // stays lost. With the fix, the failure branch refills it.
    resolveAck!({ status: 'failed', reason: 'not-live' });

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        'This session is no longer running. Start or resume it to send messages.',
      );
    });
    await waitFor(() => {
      expect(textarea.value).toBe('hello world');
    });
  });

  it('does NOT clobber newer text the user typed during the ack round-trip', async () => {
    let resolveAck: (v: any) => void;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(textarea.value).toBe('');

    // User starts typing a NEW message while the first send's ack is still in flight.
    fireEvent.change(textarea, { target: { value: 'second draft' } });

    resolveAck!({ status: 'failed', reason: 'queue-full' });

    await waitFor(() => {
      expect(onToast).toHaveBeenCalled();
    });
    // The guard (`cur.trim() ? cur : ...`) must have refused to overwrite —
    // the newer draft survives, the lost first message does not reappear.
    expect(textarea.value).toBe('second draft');
  });

  it('restores the draft and shows a toast when the invoke REJECTS (final-review fix)', async () => {
    // Unlike the two tests above (a resolved 'failed'/undefined ack), this
    // covers the IPC hop itself throwing — version skew or a dropped remote
    // WebSocket. Before the fix this was an unhandled rejection: no toast,
    // draft silently gone.
    let rejectAck: (err: unknown) => void;
    const ack = new Promise((_resolve, reject) => { rejectAck = reject; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(textarea.value).toBe('');

    rejectAck!(new Error('invoke rejected'));

    // Falls back to the same undefined-result copy as the other failure branch.
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        'The message could not be sent — no response from the session host.',
      );
    });
    await waitFor(() => {
      expect(textarea.value).toBe('hello world');
    });
  });
});

// Task 10 (Destin placement ruling): the stop control moved from beside the
// ThinkingIndicator in ChatView into the composer row, immediately left of
// the send button. Same visibility gate (isThinking && attentionState ===
// 'ok'), same click behavior as StopButton.test.tsx — those cases aren't
// re-tested here (StopButton itself is unchanged), only that InputBar wires
// the real predicate off useChatState(sessionId) and renders it in this row.
describe('InputBar — stop button (Task 10 placement)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    capturedDispatch = null;
    (window as any).claude = {
      native: {
        supported: true,
        send: vi.fn(),
        interrupt: vi.fn(),
      },
      session: {
        sendInput: vi.fn(),
      },
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderInputBar(provider: 'claude' | 'native' = 'claude') {
    render(
      <ChatProvider>
        <SkillProvider>
          <DispatchCapture />
          <InputBar sessionId="sess-1" provider={provider} />
        </SkillProvider>
      </ChatProvider>,
    );
  }

  it('hides the stop button while the session is idle', () => {
    renderInputBar();
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  it('shows the stop button once the session starts thinking with ok attention', () => {
    renderInputBar();
    // SESSION_INIT first — USER_PROMPT is a no-op against a session absent
    // from the map (mirrors useSessionAttention.test.tsx's seeding idiom).
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
  });

  // Fix (I2, whole-branch review 2026-08-16): this used to assert that ANY
  // non-'ok' attention state hid the button, using 'stuck' as the example.
  // 'stuck' is now the stall WARNING — a turn that is still generating — so
  // that assertion described the regression rather than the rule. Split into
  // the two halves that actually matter: a warned/parked turn keeps the
  // button, an ENDED turn loses it.
  it('keeps the stop button through the stall warning and the parked card', () => {
    renderInputBar();
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      capturedDispatch!({
        type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 'sess-1',
        stallWarning: { retryInMs: 15_000, willRetry: false },
      });
    });
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
    act(() => {
      capturedDispatch!({ type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 'sess-1', stalled: true });
    });
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
  });

  // The CLAUDE CODE input path (F2, 2026-08-16). The case above drives 'stuck'
  // through the native harness heartbeat; a Claude Code session only ever
  // reaches 'stuck' via a bare ATTENTION_STATE_CHANGED from the PTY buffer
  // classifier, and that input was pinned by neither test after the I2 rewrite
  // swapped it out. This pins the NEW intended behaviour — a stuck CC turn
  // KEEPS the button — and proves it is harmless by clicking it: the CC path
  // writes one ESC byte, byte-identical to the physical key.
  it('keeps the stop button when the PTY classifier flags a Claude Code session stuck', () => {
    renderInputBar('claude');
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      capturedDispatch!({ type: 'ATTENTION_STATE_CHANGED', sessionId: 'sess-1', state: 'stuck' });
    });
    const stop = screen.getByRole('button', { name: 'Stop generating' });
    // Send is still there beside it — the stop control never replaces it, so
    // nothing the user could otherwise do is blocked by this change.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
    fireEvent.click(stop);
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('sess-1', '\x1b');
  });

  it('hides the stop button once the turn has ENDED (provider error)', () => {
    renderInputBar();
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      capturedDispatch!({ type: 'NATIVE_SESSION_ERROR', sessionId: 'sess-1', message: 'boom' });
    });
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  it('provider="native": click calls native.interrupt, never session.sendInput', () => {
    renderInputBar('native');
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.native.interrupt).toHaveBeenCalledWith('sess-1');
    expect((window as any).claude.session.sendInput).not.toHaveBeenCalled();
  });

  it('provider="claude": click sends a single ESC byte via session.sendInput', () => {
    renderInputBar('claude');
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('sess-1', '\x1b');
    expect((window as any).claude.native.interrupt).not.toHaveBeenCalled();
  });
});

// Task 11 (cancel/edit queued messages): the InputBarHandle ref idiom App uses
// for the Edit-refill flow — checked BEFORE removeQueued runs (hasDraft) and
// applied AFTER it succeeds (fillDraft). See InputBarHandle's WHY comment for
// why this extends the existing ref rather than introducing new App state.
describe('InputBar — InputBarHandle hasDraft/fillDraft (Task 11)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    (window as any).claude = {
      native: { supported: true, send: vi.fn() },
      session: { sendInput: vi.fn() },
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderWithRef() {
    const ref = React.createRef<InputBarHandle>();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar ref={ref} sessionId="sess-1" provider="native" />
        </SkillProvider>
      </ChatProvider>,
    );
    return ref;
  }

  it('hasDraft() is false on an empty composer', () => {
    const ref = renderWithRef();
    expect(ref.current!.hasDraft()).toBe(false);
  });

  it('hasDraft() is false for a whitespace-only draft (trimmed)', () => {
    const ref = renderWithRef();
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(ref.current!.hasDraft()).toBe(false);
  });

  it('hasDraft() is true once the user has typed something', () => {
    const ref = renderWithRef();
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a draft in progress' } });
    expect(ref.current!.hasDraft()).toBe(true);
  });

  it('fillDraft() replaces the composer content and focuses it', () => {
    const ref = renderWithRef();
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    act(() => { ref.current!.fillDraft('the edited queued message'); });
    expect(textarea.value).toBe('the edited queued message');
    expect(ref.current!.hasDraft()).toBe(true);
  });
});

// Task 12: a 'queued' native ack dispatches QUEUED_MESSAGE_ADDED (list entry,
// no timeline write) instead of a queued-flavored USER_PROMPT — see
// chat-reducer.ts and the Task 12 brief for why the old timeline bubble froze
// above content from the still-streaming prior turn.
describe('InputBar native send — queued ack dispatches QUEUED_MESSAGE_ADDED, not a timeline entry (Task 12)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    capturedDispatch = null;
    (window as any).claude = {
      native: { supported: true, send: vi.fn() },
      session: { sendInput: vi.fn() },
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('dispatches QUEUED_MESSAGE_ADDED with the ack queueId, and writes NO timeline entry', async () => {
    (window as any).claude.native.send.mockResolvedValue({ status: 'queued', queueId: 'q-99' });

    let capturedStore: ReturnType<typeof useChatStore> | null = null;
    function StoreCapture() {
      capturedStore = useChatStore();
      return null;
    }

    render(
      <ChatProvider>
        <SkillProvider>
          <DispatchCapture />
          <StoreCapture />
          <InputBar sessionId="sess-1" provider="native" />
        </SkillProvider>
      </ChatProvider>,
    );
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'queue me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => {
      const queued = capturedStore!.getState().get('sess-1')?.queuedMessages ?? [];
      expect(queued.length).toBe(1);
    });
    const session = capturedStore!.getState().get('sess-1')!;
    expect(session.timeline).toHaveLength(0);
    expect(session.queuedMessages).toEqual([
      { queueId: 'q-99', content: 'queue me', timestamp: expect.any(Number) },
    ]);
  });
});

// Voice prompting — the composer's last mile (T9).
//
// What these pin, in plain terms:
//  - Dictated words land in the box beside anything already typed, and the
//    newest, still-changing words are shown separately from the settled ones.
//  - Typing while the mic is open ends dictation and what you typed wins.
//  - Enter with the mic open STOPS the mic and sends nothing — but the Send
//    button, and the "Send anyway" button after a blocked send, still send.
//    That difference is the whole reason the guard sits on the two keyboard
//    handlers rather than inside send() itself.
//  - Holding the space bar in the box is walkie-talkie: 350 ms starts it,
//    letting go stops it, and a quick tap inserts one space. Existing text is
//    preserved. Losing the box — at ANY point in the hold, including the
//    countdown before it arms — closes the mic,
//    because that is where a microphone gets left open with nobody watching.
describe('InputBar — voice prompting (T9)', () => {
  let emit: (e: VoiceEvent) => void;
  let voiceBridge: Record<string, any>;

  function installVoice(status: VoiceReadiness = { state: 'ready', engine: 'Parakeet' }) {
    const handlers = new Set<(e: VoiceEvent) => void>();
    // No `sendAudio` / `micAccess`: this composer test is about what the box
    // does with the words, so the hook takes its phone-shaped path and never
    // reaches for a real microphone. The capture half is useVoiceInput's own test.
    voiceBridge = {
      status: vi.fn(async () => status),
      download: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      onEvent: (cb: (e: VoiceEvent) => void) => { handlers.add(cb); return () => { handlers.delete(cb); }; },
    };
    emit = (e: VoiceEvent) => { act(() => { handlers.forEach((h) => h(e)); }); };
    (window as any).claude.voice = voiceBridge;
  }

  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    (window as any).claude = {
      native: { supported: true, send: vi.fn().mockResolvedValue({ status: 'sent' }) },
      session: { sendInput: vi.fn() },
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
    };
    installVoice();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderComposer(props: Record<string, any> = {}) {
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" {...props} />
        </SkillProvider>
      </ChatProvider>,
    );
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    // The mic's label only becomes "Speak your message" once status() has
    // answered, so this is also the wait for readiness to arrive.
    await waitFor(() => screen.getByRole('button', { name: 'Speak your message' }));
    return textarea;
  }

  /** Tap the mic and wait for the composer to say it is listening. */
  async function startListening() {
    fireEvent.click(screen.getByRole('button', { name: 'Speak your message' }));
    await waitFor(() => screen.getByRole('button', { name: 'Stop listening' }));
  }

  it('merges dictation into the draft: settled words in the box, the newest ones beside them', async () => {
    const textarea = await renderComposer();
    await startListening();

    emit({ type: 'partial', committed: 'Send him the notes.', tail: 'and ask about' });
    // One value, two halves: the settled sentence plus the words still being
    // reconsidered, which the mirror layer draws grey.
    expect(textarea.value).toBe('Send him the notes. and ask about');

    emit({ type: 'final', text: 'Send him the notes. And ask about Friday.' });
    expect(textarea.value).toBe('Send him the notes. And ask about Friday. ');
  });

  it('dictation continues a half-typed draft instead of replacing it', async () => {
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'Reply to Sam:' } });
    await startListening();

    emit({ type: 'partial', committed: 'tell him yes.', tail: '' });
    expect(textarea.value).toBe('Reply to Sam: tell him yes.');
  });

  it('typing while the mic is open ends dictation and keeps every word already in the box', async () => {
    // Fix (whole-branch review F4): this fired a whole-value REPLACEMENT — a
    // change event no keystroke can produce — so it passed whether the grey
    // words were kept or dropped, and it certified a comment that said the
    // opposite of the code. A real keystroke appends to what is already
    // rendered, which is the solid text AND the grey tail.
    const textarea = await renderComposer();
    await startListening();
    emit({ type: 'partial', committed: 'book the room.', tail: 'for Tuesday' });
    expect(textarea.value).toBe('book the room. for Tuesday');

    // One character typed at the end of everything on screen.
    fireEvent.change(textarea, { target: { value: 'book the room. for Tuesday!' } });

    expect(voiceBridge.cancel).toHaveBeenCalledTimes(1);
    // Nothing the user watched appear is taken away when they reach for the keyboard.
    expect(textarea.value).toBe('book the room. for Tuesday!');

    // And the words are solid now — a late partial cannot rewrite them.
    emit({ type: 'partial', committed: 'book the rum.', tail: '' });
    expect(textarea.value).toBe('book the room. for Tuesday!');
  });

  it('Enter stops the mic and sends NOTHING; a second Enter sends', async () => {
    const textarea = await renderComposer();
    await startListening();
    emit({ type: 'partial', committed: 'book the room.', tail: '' });

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(voiceBridge.stop).toHaveBeenCalledTimes(1);
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('book the room.');

    // The engine's last word arrives, the mic is closed, and Enter is Enter again.
    emit({ type: 'final', text: 'Book the room.' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect((window as any).claude.native.send).toHaveBeenCalledTimes(1);
  });

  it('Enter pressed with the box unfocused also stops the mic (the window-level handler)', async () => {
    await renderComposer();
    await startListening();

    // Same key, the other handler: this one fires when focus is anywhere else
    // in the app, and it must make the same decision.
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(voiceBridge.stop).toHaveBeenCalledTimes(1);
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
  });

  it('the Send BUTTON still sends while the mic is open — it never becomes a stop', async () => {
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'send this now' } });
    await startListening();

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect((window as any).claude.native.send).toHaveBeenCalledTimes(1);
    // It sends — but it does NOT leave the microphone open behind it. This used
    // to assert `stop` was never called, which pinned exactly that bug: the
    // message went, the mic stayed hot, and the next thing the engine said
    // re-typed the whole utterance into the empty box.
    expect(voiceBridge.cancel).toHaveBeenCalled();
  });

  // WHY: sending mid-sentence used to send the unsettled GREY words along with
  // the message AND leave them in the box, so the user had to delete a copy of
  // what they had just sent. Found reviewing T9, 2026-09-05.
  it('sending takes the dictation with it — no leftovers, no second copy', async () => {
    const textarea = await renderComposer();
    await startListening();
    emit({ type: 'partial', committed: 'Book the room.', tail: 'and tell' });
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain('Book the room.'));

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect((window as any).claude.native.send).toHaveBeenCalledTimes(1);
    // The box is empty afterwards — not holding the grey remainder.
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''));
    // And a late word from the engine cannot re-fill it, because the dictation
    // was cancelled rather than left running.
    emit({ type: 'partial', committed: 'Book the room.', tail: 'and tell Sam' });
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''));
  });

  // WHY: both Enter guards read "am I listening", so during the `finishing` beat —
  // the last engine pass, seconds long — a second Enter fell through and sent,
  // and the late words then re-filled the box. A stop-then-send double tap is the
  // natural gesture, so this is the likely route into the bug above.
  it('a second Enter during the finishing beat does not leave a duplicate draft', async () => {
    const textarea = await renderComposer();
    await startListening();
    emit({ type: 'partial', committed: 'Book the room.', tail: '' });
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain('Book the room.'));

    fireEvent.keyDown(textarea, { key: 'Enter' });          // stops the mic
    fireEvent.keyDown(textarea, { key: 'Enter' });          // sends
    await waitFor(() => expect((window as any).claude.native.send).toHaveBeenCalled());
    emit({ type: 'final', text: 'Book the room.' });
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''));
  });

  it('the "Send anyway" retry still sends while the mic is open', async () => {
    // The retry re-enters send() past the pending-prompt gate. If the Enter
    // guard had been put inside send(), this button would silently stop the
    // mic instead of sending — which is the failure this case exists to catch.
    let retry: (() => void) | null = null;
    const pendingSession = {
      activeTurnToolIds: [],
      toolCalls: new Map(),
      timeline: [{ kind: 'prompt', prompt: { promptId: 'p-1', completed: false } }],
    };
    const textarea = await renderComposer({
      provider: 'claude',
      getSessionState: () => pendingSession as any,
      onSendBlocked: (r: () => void) => { retry = r; },
    });

    fireEvent.change(textarea, { target: { value: 'push it through' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(retry).toBeTypeOf('function');
    // Refused: the draft is still there.
    expect(textarea.value).toBe('push it through');

    await startListening();
    const sendInput = (window as any).claude.session.sendInput;
    sendInput.mockClear();
    act(() => { retry!(); });

    // One ESC (closing any live menu), then the message itself — a real send.
    // (The Claude Code path writes the text on a timer, so wait for it.)
    expect(sendInput).toHaveBeenCalledWith('sess-1', '\x1b');
    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledWith('sess-1', expect.stringContaining('push it through'));
    });
    expect(voiceBridge.stop).not.toHaveBeenCalled();
  });
});

describe('InputBar — hold the space bar to talk (T9)', () => {
  let voiceBridge: Record<string, any>;

  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    voiceBridge = {
      status: vi.fn(async () => ({ state: 'ready', engine: 'Parakeet' })),
      download: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      onEvent: (cb: (e: VoiceEvent) => void) => { holdHandlers.add(cb); return () => { holdHandlers.delete(cb); }; },
    };
    holdHandlers.clear();
    (window as any).claude = {
      native: { supported: true, send: vi.fn().mockResolvedValue({ status: 'sent' }) },
      session: { sendInput: vi.fn() },
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
      voice: voiceBridge,
    };
  });

  /** Deliver an engine event to the composer under test. */
  const holdHandlers = new Set<(e: VoiceEvent) => void>();
  const emitHold = (e: VoiceEvent) => { act(() => { holdHandlers.forEach((h) => h(e)); }); };

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  let rerenderComposer: () => void;
  async function renderComposer() {
    const { rerender } = render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" />
        </SkillProvider>
      </ChatProvider>,
    );
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    await waitFor(() => screen.getByRole('button', { name: 'Speak your message' }));
    rerenderComposer = () => rerender(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" compact />
        </SkillProvider>
      </ChatProvider>,
    );
    vi.useFakeTimers();
    return textarea;
  }

  /** Let `ms` of held-down time pass, and let the mic's start settle. */
  async function hold(ms: number) {
    await act(async () => { vi.advanceTimersByTime(ms); });
  }

  it('holding the space bar starts the mic; letting go stops it', async () => {
    const textarea = await renderComposer();
    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(350);
    expect(voiceBridge.start).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(textarea, { key: ' ' });
    expect(voiceBridge.stop).toHaveBeenCalledTimes(1);
  });

  // The one release path with no test: deleting the visibilitychange listener
  // left the whole suite green, so a hold that survived the page being hidden
  // would have gone unnoticed.
  it('the page being hidden mid-hold closes the microphone', async () => {
    const textarea = await renderComposer();
    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(350);
    expect(voiceBridge.start).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(voiceBridge.stop).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('a quick tap does not start or stop the mic', async () => {
    const textarea = await renderComposer();
    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(100);
    fireEvent.keyUp(textarea, { key: ' ' });
    await hold(500);

    expect(voiceBridge.start).not.toHaveBeenCalled();
    expect(voiceBridge.stop).not.toHaveBeenCalled();
  });

  // Destin, 2026-09-05, twice. First: "it should work basically any time I press
  // and hold in the input area, not just when it's empty. Should append to the
  // end of existing text." Then, on the first attempt at that: "still seems like
  // a bit of a gamble as to whether the spacebar does voice mode or just enters
  // a bunch of spaces lmao."
  //
  // The gamble was real and these pin it shut. The gesture is now: nothing is
  // typed while the bar is down; the space appears only if the hold is
  // abandoned; and the decision NEVER consults the browser's `repeat` flag,
  // which Electron on Linux does not reliably set. Together those mean at most
  // ONE space can ever come out of a hold, whatever the keyboard does.
  it('holding the space bar with text in the box starts dictation and keeps the text', async () => {
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'Tell Sam' } });

    const cancelled = fireEvent.keyDown(textarea, { key: ' ' });
    expect(cancelled).toBe(false);          // nothing typed while the bar is down
    await hold(350);

    expect(voiceBridge.start).toHaveBeenCalledTimes(1);
    // One space between the typed half and the spoken half, added by startVoice.
    expect(textarea.value).toBe('Tell Sam ');

    emitHold({ type: 'final', text: 'the meeting moved.' });
    expect(textarea.value).toBe('Tell Sam the meeting moved. ');
  });

  it('a keyboard that repeats produces ONE space, not a run of them', async () => {
    // THE bug Destin hit. These repeats carry no `repeat: true`, exactly as they
    // arrive from Electron on Linux — the old code asked the event and believed
    // it, so every one of them was typed.
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'hello' } });

    fireEvent.keyDown(textarea, { key: ' ' });
    for (let i = 0; i < 8; i += 1) {
      expect(fireEvent.keyDown(textarea, { key: ' ' })).toBe(false);   // swallowed
      await hold(30);
    }
    fireEvent.keyUp(textarea, { key: ' ' });

    // 8 repeats over 240 ms — short of the hold, so this is a space, and exactly one.
    expect(voiceBridge.start).not.toHaveBeenCalled();
    expect(textarea.value).toBe('hello ');
  });

  it('a quick tap with text in the box types exactly one space', async () => {
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'already typing' } });
    textarea.setSelectionRange(14, 14);

    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(100);                        // let go well before the hold matures
    fireEvent.keyUp(textarea, { key: ' ' });
    await hold(500);

    expect(voiceBridge.start).not.toHaveBeenCalled();
    expect(textarea.value).toBe('already typing ');
  });

  // WHY: jsdom keydown has no browser-default text insertion. Model it from
  // the LIVE value/selection, then run the queued frame only after typing.
  function typeLetter(textarea: HTMLTextAreaElement, key: string) {
    expect(fireEvent.keyDown(textarea, { key })).toBe(true);
    const { value, selectionStart: at, selectionEnd: to } = textarea;
    fireEvent.change(textarea, {
      target: { value: value.slice(0, at) + key + value.slice(to), selectionStart: at + 1, selectionEnd: at + 1 },
    });
    fireEvent.keyUp(textarea, { key });
  }

  describe.each(['release first', 'letter first'] as const)('pending space caret — %s', (order) => {
    it.each([
      { draft: 'hello', at: 5, to: 5, expected: 'hello world' },
      { draft: 'hello!', at: 5, to: 5, expected: 'hello world!' },
      { draft: 'helloOLD!', at: 5, to: 8, expected: 'hello world!' },
    ])('types at the selection in "$draft" and survives a rerender', async ({ draft, at, to, expected }) => {
      const textarea = await renderComposer();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
      fireEvent.change(textarea, { target: { value: draft } });
      textarea.setSelectionRange(at, to);
      expect(fireEvent.keyDown(textarea, { key: ' ' })).toBe(false);
      if (order === 'release first') fireEvent.keyUp(textarea, { key: ' ' });
      typeLetter(textarea, 'w');
      if (order === 'letter first') fireEvent.keyUp(textarea, { key: ' ' });
      act(() => { frames.splice(0).forEach((cb) => cb(0)); });
      for (const letter of 'orld') typeLetter(textarea, letter);
      expect(textarea.value).toBe(expected);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([11, 11]);
      rerenderComposer();
      expect(textarea.value).toBe(expected);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([11, 11]);
      expect(voiceBridge.start).not.toHaveBeenCalled();
    });

    it('does not overwrite a later cursor move, and keeps the space through a rerender', async () => {
      const textarea = await renderComposer();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
      fireEvent.change(textarea, { target: { value: 'hello!' } });
      textarea.setSelectionRange(5, 5);
      fireEvent.keyDown(textarea, { key: ' ' });
      if (order === 'release first') fireEvent.keyUp(textarea, { key: ' ' });
      else fireEvent.keyDown(textarea, { key: 'ArrowLeft' });
      expect(textarea.value).toBe('hello !');
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 6]);
      // Model a subsequent mouse selection before any frame is painted.
      textarea.setSelectionRange(1, 3);
      if (order === 'letter first') fireEvent.keyUp(textarea, { key: ' ' });
      rerenderComposer();
      act(() => { frames.splice(0).forEach((cb) => cb(0)); });
      expect(textarea.value).toBe('hello !');
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 3]);
      expect(voiceBridge.start).not.toHaveBeenCalled();
    });
  });

  it('typing straight through a space puts it in ahead of the next letter', async () => {
    // "hello world" at speed: the w goes down before the space comes up. The
    // space must land BEFORE the w, or the box reads "hellow orld".
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'hello' } });
    textarea.setSelectionRange(5, 5);

    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(80);
    fireEvent.keyDown(textarea, { key: 'w' });

    expect(textarea.value).toBe('hello ');   // the space, already in, before the w types
    expect(voiceBridge.start).not.toHaveBeenCalled();
  });

  it('puts the space where the caret is, not at the end', async () => {
    const textarea = await renderComposer();
    fireEvent.change(textarea, { target: { value: 'TellSam about it' } });
    textarea.setSelectionRange(4, 4);        // between "Tell" and "Sam"

    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(100);
    fireEvent.keyUp(textarea, { key: ' ' });

    expect(textarea.value).toBe('Tell Sam about it');
  });

  it('an empty box types no space when the hold matures', async () => {
    const textarea = await renderComposer();
    const cancelled = fireEvent.keyDown(textarea, { key: ' ' });
    expect(cancelled).toBe(false);
    await hold(350);
    expect(voiceBridge.start).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('');
  });

  it('focus leaving the box mid-hold closes the mic', async () => {
    const textarea = await renderComposer();
    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(350);
    expect(voiceBridge.start).toHaveBeenCalledTimes(1);

    // Clicking away, alt-tabbing — no key-up will ever arrive.
    fireEvent.blur(textarea);
    expect(voiceBridge.stop).toHaveBeenCalledTimes(1);
  });

  it('the whole window losing focus mid-hold closes the mic', async () => {
    const textarea = await renderComposer();
    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(350);

    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(voiceBridge.stop).toHaveBeenCalledTimes(1);
  });

  it('focus leaving BEFORE the 350 ms hold is up leaves the mic closed', async () => {
    // The leak this exists to stop: for the first 350 ms nothing is listening
    // yet, only a countdown is running. Without cancelling that countdown the
    // mic opens in a window the user has already left, no key-up ever comes,
    // and it stays open until the silence stop drops the room into the box.
    const textarea = await renderComposer();
    fireEvent.keyDown(textarea, { key: ' ' });
    await hold(100);
    fireEvent.blur(textarea);
    await hold(1000);

    expect(voiceBridge.start).not.toHaveBeenCalled();
    expect(voiceBridge.stop).not.toHaveBeenCalled();
  });
});
