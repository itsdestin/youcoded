import { describe, it, expect } from 'vitest';
import { buildOutgoingMessage } from '../src/renderer/components/outgoing-message';

// Why: the optimistic USER_PROMPT bubble is confirmed by an EXACT content
// match against the transcript's user message (chat-reducer
// TRANSCRIPT_USER_MESSAGE). The PTY send replaces newlines with spaces (so
// Shift+Enter text doesn't submit early), so the optimistic content MUST be
// built from the same sanitized string — otherwise a multiline message can
// never be confirmed, `pending` stays set forever, and useSubmitConfirmation
// fires a stray recovery `\r` into the PTY 8s later (which can auto-answer a
// live permission/AskUserQuestion menu).

describe('buildOutgoingMessage', () => {
  it('display content and PTY text are identical for a plain message', () => {
    const out = buildOutgoingMessage('hello world', []);
    expect(out).not.toBeNull();
    expect(out!.content).toBe('hello world');
    expect(out!.ptyText).toBe('hello world');
  });

  it('replaces newlines with spaces in BOTH content and ptyText', () => {
    const out = buildOutgoingMessage('line one\nline two\r\nline three', []);
    expect(out!.ptyText).toBe('line one line two line three');
    // The invariant that prevents forever-pending bubbles:
    expect(out!.content).toBe(out!.ptyText);
  });

  // Destin, 2026-09-23: text copied from a table carries TABs between cells. Written to
  // the PTY, Claude Code takes each one as the Tab KEY (it recorded "Purpose\tPath" as
  // "PurposePath"), so the bubble could never be confirmed and stayed pinned at the bottom.
  it('replaces tabs with spaces in BOTH content and ptyText', () => {
    const out = buildOutgoingMessage('Purpose\tPath\nnotes.md\t\tdone', []);
    expect(out!.ptyText).toBe('Purpose Path notes.md  done');
    expect(out!.ptyText).not.toContain('\t');
    expect(out!.content).toBe(out!.ptyText);
  });

  it('trims surrounding whitespace', () => {
    const out = buildOutgoingMessage('  hi  ', []);
    expect(out!.content).toBe('hi');
    expect(out!.ptyText).toBe('hi');
  });

  it('collapses a newline-only message to null (nothing to send)', () => {
    expect(buildOutgoingMessage('\n\n', [])).toBeNull();
    expect(buildOutgoingMessage('   ', [])).toBeNull();
  });

  it('prefixes attachment paths in content, space-joined', () => {
    const out = buildOutgoingMessage('see this', ['C:/tmp/a.png', 'C:/tmp/b.png']);
    expect(out!.content).toBe('C:/tmp/a.png C:/tmp/b.png see this');
    expect(out!.ptyText).toBe('see this');
  });

  it('attachments-only send has path-only content and empty ptyText', () => {
    const out = buildOutgoingMessage('', ['C:/tmp/a.png']);
    expect(out!.content).toBe('C:/tmp/a.png');
    expect(out!.ptyText).toBe('');
  });
});
