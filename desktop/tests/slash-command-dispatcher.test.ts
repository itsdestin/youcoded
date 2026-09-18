// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSlashCommand, type DispatcherCallbacks } from '../src/renderer/state/slash-command-dispatcher';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../src/renderer/state/chat-types';

// Regression guard for the "Contemplating…" spinner that never stops after
// typing `/model opus` (or `/fast on`, `/effort high`) into chat.
//
// Root cause: `/model`, `/fast` and `/effort` are answered by Claude Code
// LOCALLY — no API call, so the transcript never gets an `assistant` line and
// TRANSCRIPT_TURN_COMPLETE never fires. Before this fix, an arg'd command
// returned `{ handled: false }`, which InputBar treats exactly like plain
// text: it dispatches USER_PROMPT (isThinking: true) and nothing ever clears
// it. See slash-command-dispatcher.ts's `/model`/`/fast`/`/effort` case for
// the full story.
function dispatchModelCommand(raw: string, callbacks: DispatcherCallbacks = {}, dispatch: (a: ChatAction) => void = () => {}) {
  return dispatchSlashCommand({
    raw,
    sessionId: 'sess-1',
    view: 'chat',
    files: [],
    dispatch,
    timeline: [],
    callbacks,
    deferUiEffectsToRuntime: false,
  });
}

describe('dispatchSlashCommand — typed /model <alias> never falls through to a chat turn', () => {
  it('a recognized alias is fully intercepted: no alsoSendToPty, no passthrough', () => {
    const onModelSwitchCommand = vi.fn().mockReturnValue('sent');
    const dispatch = vi.fn();
    const r = dispatchModelCommand('/model opus', { onModelSwitchCommand }, dispatch);

    expect(onModelSwitchCommand).toHaveBeenCalledWith('opus[1m]');
    // The critical assertion: `handled: true` with NO alsoSendToPty means
    // InputBar's CC/PTY passthrough (the USER_PROMPT/isThinking path) never
    // runs for this command.
    expect(r).toEqual({ handled: true });
  });

  it('a sent switch appends a friendly marker in place of the raw command text', () => {
    const dispatch = vi.fn();
    dispatchModelCommand('/model opus', { onModelSwitchCommand: () => 'sent' }, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0];
    expect(action.type).toBe('MODEL_SWITCH_MARKER');
    expect(action.sessionId).toBe('sess-1');
    expect(action.label).toBe('Model switched to Opus');
  });

  it('sonnet/haiku/fable map to their own labels', () => {
    for (const [typed, alias, label] of [
      ['sonnet', 'sonnet', 'Sonnet'],
      ['haiku', 'haiku', 'Haiku'],
      ['fable', 'fable', 'Fable'],
    ] as const) {
      const dispatch = vi.fn();
      dispatchModelCommand(`/model ${typed}`, { onModelSwitchCommand: () => 'sent' }, dispatch);
      expect(dispatch.mock.calls[0][0].label).toBe(`Model switched to ${label}`);
      void alias;
    }
  });

  it('a refused send (turn in flight) is swallowed, not sent as a chat message', () => {
    const dispatch = vi.fn();
    const r = dispatchModelCommand('/model opus', { onModelSwitchCommand: () => 'blocked' }, dispatch);
    // Still handled:true (swallowed) — App.tsx already toasted the refusal.
    expect(r).toEqual({ handled: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an ineligible session (native/shell) falls back to the old passthrough, unchanged', () => {
    const dispatch = vi.fn();
    const r = dispatchModelCommand('/model opus', { onModelSwitchCommand: () => 'ineligible' }, dispatch);
    expect(r).toEqual({ handled: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an argument naming no known model family falls back to the old passthrough, unchanged', () => {
    // claudeAliasForModelId matches on family word (substring), so a raw dated
    // id like "claude-opus-4-1-..." DOES resolve (to 'opus[1m]') — that's
    // correct, not this case. This is for input with no family word at all.
    const onModelSwitchCommand = vi.fn();
    const r = dispatchModelCommand('/model gpt-4-turbo', { onModelSwitchCommand });
    expect(onModelSwitchCommand).not.toHaveBeenCalled();
    expect(r).toEqual({ handled: false });
  });

  it('no callback wired at all falls back to the old passthrough, unchanged', () => {
    const r = dispatchModelCommand('/model opus', {});
    expect(r).toEqual({ handled: false });
  });

  it('bare /model (no args) still opens the picker, unaffected by this change', () => {
    const onOpenModelPicker = vi.fn();
    const r = dispatchModelCommand('/model', { onOpenModelPicker });
    expect(onOpenModelPicker).toHaveBeenCalledOnce();
    expect(r).toEqual({ handled: true });
  });
});

describe('dispatchSlashCommand — typed /fast and /effort with an argument route straight to the PTY', () => {
  it('/fast on is fully handled via alsoSendToPty, not a chat turn', () => {
    const r = dispatchModelCommand('/fast on');
    expect(r).toEqual({ handled: true, alsoSendToPty: '/fast on\r' });
  });

  it('/effort high is fully handled via alsoSendToPty, not a chat turn', () => {
    const r = dispatchModelCommand('/effort high');
    expect(r).toEqual({ handled: true, alsoSendToPty: '/effort high\r' });
  });
});

describe('chatReducer — MODEL_SWITCH_MARKER', () => {
  it('appends a thin divider (never touches isThinking)', () => {
    let state: ChatState = new Map();
    state = chatReducer(state, { type: 'SESSION_INIT', sessionId: 'sess-1' });
    const before = state.get('sess-1')!.isThinking;

    state = chatReducer(state, {
      type: 'MODEL_SWITCH_MARKER',
      sessionId: 'sess-1',
      markerId: 'model-switch-1',
      timestamp: 1000,
      label: 'Model switched to Opus',
    });

    const session = state.get('sess-1')!;
    expect(session.isThinking).toBe(before); // untouched, unlike USER_PROMPT
    const entry = session.timeline.at(-1);
    expect(entry).toEqual({
      kind: 'system-marker',
      marker: { id: 'model-switch-1', timestamp: 1000, label: 'Model switched to Opus', variant: 'model' },
    });
  });
});

// `/copy` says "Copied to clipboard" only when something was copied.
//
// The dispatcher used to do
//   void navigator.clipboard.writeText(payload.content).catch(() => {});
//   input.callbacks.onToast?.('Copied to clipboard');
// so the toast fired before, and regardless of, the write — a denied clipboard still
// read as a success. And on a remote browser over plain http, where
// `navigator.clipboard` does not exist, the call threw before any toast at all.
describe('/copy reports what actually happened', () => {
  // The smallest session buildCopyPayload reads: one assistant turn, no code blocks,
  // so /copy takes its single-block branch (the one that toasted).
  const SESSION = {
    timeline: [{ kind: 'assistant-turn', turnId: 't1' }],
    assistantTurns: new Map([
      ['t1', { id: 't1', segments: [{ type: 'text', content: 'The answer is 42.' }], stopReason: null, model: null, usage: null, anthropicRequestId: null }],
    ]),
  };

  function copy(onToast: (msg: string) => void) {
    return dispatchSlashCommand({
      raw: '/copy',
      sessionId: 'sess-1',
      view: 'chat',
      files: [],
      dispatch: () => {},
      timeline: [],
      callbacks: { onToast, getSessionState: () => SESSION },
      deferUiEffectsToRuntime: false,
    } as any);
  }

  const original = { clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'), exec: (document as any).execCommand };

  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }
  function setExecCommand(result: boolean) {
    (document as any).execCommand = vi.fn(() => result);
  }

  beforeEach(() => { setExecCommand(false); });
  afterEach(() => {
    if (original.clipboard) Object.defineProperty(navigator, 'clipboard', original.clipboard);
    else delete (navigator as any).clipboard;
    (document as any).execCommand = original.exec;
  });

  it('a copy the clipboard refused does not say "Copied to clipboard"', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('Document is not focused.')) });
    const onToast = vi.fn();
    copy(onToast);

    // Wording from Destin's batch 1 deck answer (E-4): the old "select the text and copy it
    // yourself" was unclear, since that is what /copy was for.
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith("Couldn't copy — please try again."));
    expect(onToast).not.toHaveBeenCalledWith('Copied to clipboard');
  });

  it('a copy that worked still says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const onToast = vi.fn();
    copy(onToast);

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('Copied to clipboard'));
    expect(writeText).toHaveBeenCalledWith('The answer is 42.');
  });

  it('a remote browser with no clipboard API copies through the fallback instead of throwing', async () => {
    setClipboard(undefined);
    setExecCommand(true);
    const onToast = vi.fn();

    expect(() => copy(onToast)).not.toThrow();
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('Copied to clipboard'));
  });
});
