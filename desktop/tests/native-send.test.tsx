// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { sendChatMessage } from '../src/renderer/components/native-send';
import { buildOutgoingMessage } from '../src/renderer/components/outgoing-message';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import InputBar from '../src/renderer/components/InputBar';
import type { NativeSendResult } from '../src/shared/types';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

function stub(send: ReturnType<typeof vi.fn>) {
  (window as any).claude = {
    native: { supported: true, send },
    session: { sendInput: vi.fn() },
    skills: {
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

describe('sendChatMessage', () => {
  beforeEach(() => stub(vi.fn(async () => ({ status: 'sent' }) as NativeSendResult)));

  it('routes native to native:send with NO trailing \\r, filepaths prefixed and passed as attachments', () => {
    sendChatMessage('native', 's1', 'hello world', ['C:/a b.txt']);
    // WHY both halves: the text is the dedup key for the optimistic bubble; the third argument lets
    // main turn image paths into image parts. Dropping either is a real regression.
    expect((window as any).claude.native.send).toHaveBeenCalledWith('s1', 'C:/a b.txt hello world', ['C:/a b.txt']);
    expect((window as any).claude.session.sendInput).not.toHaveBeenCalled();
  });

  it('routes claude/undefined to the PTY with \\r', () => {
    sendChatMessage('claude', 's1', 'hi');
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('s1', 'hi\r');
    sendChatMessage(undefined, 's2', 'yo');
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('s2', 'yo\r');
  });

  // WHY: the string sent to the harness must EXACTLY equal the optimistic bubble content, or the
  // bubble stays pending forever; attachments ride beside it and are never folded into the string.
  it.each<[string, string[]]>([
    ['hello world', []],
    ['see this', ['C:/tmp/a.png', 'C:/tmp/b.png']],
    ['line one\nline two', ['C:/a b.txt']],
    ['', ['C:/only-a-file.txt']],
  ])('native send text equals buildOutgoingMessage(...).content for %j', (raw, paths) => {
    const out = buildOutgoingMessage(raw, paths)!;
    expect(out).not.toBeNull();
    sendChatMessage('native', 's1', out.ptyText, paths);
    expect((window as any).claude.native.send).toHaveBeenCalledWith('s1', out.content, paths);
  });

  // WHY: ROADMAP L732 was a TYPE error (a non-literal provider matched no overload); the typed
  // calls below must keep compiling under tsconfig.tests.json.
  it('accepts a non-literal provider and routes by value', async () => {
    const providers: Array<'claude' | 'native' | undefined> = ['native', 'claude', undefined];
    for (const provider of providers) {
      const r: Promise<NativeSendResult> | void = sendChatMessage(provider, 's1', 'hi');
      if (provider === 'native') {
        expect(r).toBeInstanceOf(Promise);
        await expect(r).resolves.toEqual({ status: 'sent' });
      } else {
        expect(r).toBeUndefined();
      }
    }
    expect((window as any).claude.native.send).toHaveBeenCalledTimes(1);
    expect((window as any).claude.session.sendInput).toHaveBeenCalledTimes(2);
  });

  it('still gives a literal native caller a plain Promise (no `| void`)', async () => {
    const r: Promise<NativeSendResult> = sendChatMessage('native', 's1', 'hi');
    await expect(r).resolves.toEqual({ status: 'sent' });
  });
});

// WHY: an unanswered send (remote 30s timeout "MAY have run") must not claim "could not be sent" and
// invite a duplicate; the draft is kept either way. A host that ANSWERED failed is a confirmed failure.
describe('InputBar native send — an unanswered send is not reported as unsent', () => {
  beforeEach(() => { (global as any).ResizeObserver = NoopResizeObserver; });

  function sendHello(onToast: (msg: string) => void) {
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );
    const box = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    return box;
  }

  it('a send that got no answer says it could not confirm, and keeps the draft', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stub(vi.fn().mockRejectedValue(new Error('Request native:send timed out')));
    const onToast = vi.fn();
    const box = sendHello(onToast);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/couldn.t confirm/i)));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringMatching(/could not be sent/i));
    await waitFor(() => expect(box.value).toBe('hello world'));
  });

  it('an ack that came back empty is treated the same way', async () => {
    stub(vi.fn().mockResolvedValue(undefined));
    const onToast = vi.fn();
    sendHello(onToast);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/couldn.t confirm/i)));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringMatching(/no response from the session host/i));
  });

  it('a failure the host confirmed, for a reason without its own sentence, says only that', async () => {
    stub(vi.fn().mockResolvedValue({ status: 'failed', reason: 'some-reason-added-later' }));
    const onToast = vi.fn();
    sendHello(onToast);

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The message could not be sent.'));
  });
});
