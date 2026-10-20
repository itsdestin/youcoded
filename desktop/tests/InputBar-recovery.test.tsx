// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import InputBar, { type InputBarHandle } from '../src/renderer/components/InputBar';
import { resetNativeStartups, setNativeStartup } from '../src/renderer/state/native-startup-store';
import { flushRecoveryDrafts, readRecoveryDraft, writeRecoveryDraft } from '../src/renderer/state/draft-recovery';
import { makeDraftToken, expandDraftTokens } from '../src/renderer/components/context-menu/compose-ref';
import { queueBrowserStorage } from './helpers/queue-browser-storage';

// WHY separate: recovery owns its storage/readiness fixtures and must not grow the
// general composer suite beyond its existing budget when upstream adds queue tests.
beforeEach(() => {
  flushRecoveryDrafts(); sessionStorage.clear();
  Object.defineProperty(window, 'localStorage', { value: queueBrowserStorage(), configurable: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  (window as any).claude = {
    native: { supported: true, send: vi.fn().mockResolvedValue({ status: 'sent' }) },
    session: { sendInput: vi.fn() },
    skills: {
      list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([]), getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
  };
});
afterEach(() => { cleanup(); resetNativeStartups(); vi.unstubAllGlobals(); });

describe('InputBar recovery — draft without submission', () => {
  it('keeps typed text and files unsent until the host publishes startup readiness', () => {
    setNativeStartup('startup-test', { phase: 'connecting', attemptId: 'a', hostId: 'h', generation: 1, revision: 1 });
    render(<ChatProvider><SkillProvider><InputBar sessionId="startup-test" provider="native" initialInput="keep my draft" initialAttachments={['/project/attachment.txt']} /></SkillProvider></ChatProvider>);
    const input = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(input).not.toBeDisabled();
    expect(send).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.submit(send.closest('form')!);
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
    expect(input.value).toBe('keep my draft');
    expect(screen.getByText('attachment.txt')).toBeInTheDocument();
    act(() => { setNativeStartup('startup-test', { phase: 'ready', hostId: 'h', generation: 1, revision: 2 }); });
    expect(input.value).toBe('keep my draft');
    expect(screen.getByText('attachment.txt')).toBeInTheDocument();
    expect(send).not.toBeDisabled();
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
  });

  it('restores typed text and attachments after remount without submitting', () => {
    const wrap = () => <ChatProvider><SkillProvider><InputBar sessionId="recovery" provider="native"
      initialInput="initial" initialAttachments={['/project/image.png']} /></SkillProvider></ChatProvider>;
    const first = render(wrap());
    fireEvent.change(screen.getByPlaceholderText('Message your assistant...'), { target: { value: 'my newer unsent words' } });
    flushRecoveryDrafts();
    first.unmount();
    render(wrap());
    expect((screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement).value).toBe('my newer unsent words');
    expect(screen.getByText('image.png')).toBeTruthy();
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
  });

  it('recovers quoted reference chips without depending on the previous renderer registry', () => {
    const marker = expandDraftTokens(makeDraftToken({ id: 'saved-ref', kind: 'doc', path: '/project/notes.md', fileName: 'notes.md', quote: 'quoted words', label: 'notes.md' }));
    writeRecoveryDraft('composer:ref-recovery', { text: `Review ${marker}` });
    flushRecoveryDrafts();
    render(<ChatProvider><SkillProvider><InputBar sessionId="ref-recovery" provider="native" /></SkillProvider></ChatProvider>);
    const value = (screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement).value;
    expect(value).not.toContain('quoted words');
    expect(expandDraftTokens(value)).toBe(`Review ${marker}`);
  });

  it('does not restore a submitted message from a pending draft write', async () => {
    const wrap = () => <ChatProvider><SkillProvider><InputBar sessionId="sent-recovery" provider="native" /></SkillProvider></ChatProvider>;
    const first = render(wrap());
    const input = screen.getByPlaceholderText('Message your assistant...');
    fireEvent.change(input, { target: { value: 'send once' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect((window as any).claude.native.send).toHaveBeenCalledOnce());
    flushRecoveryDrafts();
    expect(readRecoveryDraft('composer:sent-recovery')).toBeNull();
    first.unmount();
    render(wrap());
    expect((screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement).value).toBe('');
  });

  it('exports a pending draft for the newly admitted detached window', () => {
    const ref = React.createRef<InputBarHandle>();
    render(<ChatProvider><SkillProvider><InputBar ref={ref} sessionId="pending-handoff:one" provider="native" sendBlocked /></SkillProvider></ChatProvider>);
    const input = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'unsent note' } });
    expect(ref.current!.readDraftPayload('pending-handoff:one')).toEqual({ text: 'unsent note', attachments: [] });
  });

  it('restores a detached draft without automatically sending it', () => {
    const ref = React.createRef<InputBarHandle>();
    render(<ChatProvider><SkillProvider><InputBar ref={ref} sessionId="admitted" provider="native"
      initialInput="unsent note" initialAttachments={['/project/screenshot.png']} /></SkillProvider></ChatProvider>);
    expect((screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement).value).toBe('unsent note');
    expect(screen.getByText('screenshot.png')).toBeTruthy();
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
  });

  it('rebinds a pending draft to the admitted id without sending it', () => {
    const ref = React.createRef<InputBarHandle>();
    const wrap = (id: string, blocked: boolean) => <ChatProvider><SkillProvider>
      <InputBar ref={ref} sessionId={id} provider="native" sendBlocked={blocked} />
    </SkillProvider></ChatProvider>;
    const { rerender } = render(wrap('pending-handoff:one', true));
    const input = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'unfinished thought' } });
    act(() => ref.current!.transferDraft('pending-handoff:one', 'admitted'));
    rerender(wrap('admitted', false));
    expect(input.value).toBe('unfinished thought');
    expect(ref.current!.readDraft()).toBe('unfinished thought');
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
  });

  it('allows typing but blocks button, Enter and form submit until the wait ends', () => {
    const { rerender } = render(<ChatProvider><SkillProvider><InputBar sessionId="freshness-test" provider="native" sendBlocked /></SkillProvider></ChatProvider>);
    const input = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'a saved draft' } });
    expect(input.disabled).toBe(false);
    const button = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.submit(button.closest('form')!);
    expect((window as any).claude.native.send).not.toHaveBeenCalled();
    expect(input.value).toBe('a saved draft');
    rerender(<ChatProvider><SkillProvider><InputBar sessionId="freshness-test" provider="native" sendBlocked={false} /></SkillProvider></ChatProvider>);
    expect(input.value).toBe('a saved draft');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect((window as any).claude.native.send).toHaveBeenCalledOnce();
  });
});
