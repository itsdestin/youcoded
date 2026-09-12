// @vitest-environment jsdom
/**
 * `/copy` says "Copied to clipboard" only when something was copied.
 *
 * Error inventory 2026-09-10, false message 7. The dispatcher did
 *   void navigator.clipboard.writeText(payload.content).catch(() => {});
 *   input.callbacks.onToast?.('Copied to clipboard');
 * so the toast fired before, and regardless of, the write — a denied clipboard still
 * read as a success. And on a remote browser over plain http, where
 * `navigator.clipboard` does not exist, the call threw before any toast at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSlashCommand } from '../src/renderer/state/slash-command-dispatcher';

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

describe('/copy reports what actually happened', () => {
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
