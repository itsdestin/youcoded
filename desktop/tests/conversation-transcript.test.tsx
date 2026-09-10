// @vitest-environment jsdom
// This repo defaults vitest to the 'node' environment per-file — jsdom is
// opt-in via this docblock (must be line 1), or `document`/`window` don't exist.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConversationTranscript from '../src/renderer/components/project-view/ConversationTranscript';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import { COPY } from '../src/shared/chatsearch-refs';

// jsdom does not implement scrollIntoView; ConversationTranscript calls it to
// jump to the newest message. Every real browser has it — this is a
// test-environment gap (see tests/ui-primitives.test.tsx for precedent).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ConversationTranscript', () => {
  it('renders markdown', () => {
    render(<ConversationTranscript messages={[{ role: 'assistant', content: '```ts\nconst a = 1;\n```', timestamp: 1 }]} />);
    expect(document.querySelector('code')).toBeTruthy();
  });
  it('renders NO filepath chips — positive control: the same text WITH a sessionId does render one', () => {
    // The chip has no dedicated class/tag in the rendered DOM (react-markdown's
    // `filepath-token` hast element is fully replaced by the FilepathToken
    // component, which renders a plain <button>) — its one stable, always-present
    // marker is the data-file-path attribute FilepathToken stamps on that button.
    const text = 'see src/renderer/App.tsx for details';
    const { unmount } = render(<MarkdownContent content={text} sessionId="s1" />);
    expect(document.querySelector('button[data-file-path]')).toBeTruthy(); // control
    unmount();
    render(<ConversationTranscript messages={[{ role: 'assistant', content: text, timestamp: 1 }]} />);
    expect(document.querySelector('button[data-file-path]')).toBeNull();
  });
  // A3 (2026-08-26 preview-header spec): these two attributes are what lets
  // build-menu.ts's right-click guard fire inside a preview (it widens
  // `.chat-scroll` to also accept `[data-conversation-id]`) AND what lets
  // the "Ask about this" scaffold name the conversation. ConversationPreview
  // (Project View) never passes these — the second case here pins that it
  // gets neither attribute, so its right-click behaviour stays untouched.
  it('stamps data-conversation-id/-title on its container when a caller names a conversation', () => {
    const { container } = render(
      <ConversationTranscript
        messages={[{ role: 'assistant', content: 'hi', timestamp: 1 }]}
        conversationId="conv-1"
        conversationTitle="Debugging sync"
      />,
    );
    const el = container.querySelector('[data-conversation-id]');
    expect(el).toBeTruthy();
    expect(el?.getAttribute('data-conversation-id')).toBe('conv-1');
    expect(el?.getAttribute('data-conversation-title')).toBe('Debugging sync');
  });

  it('renders NEITHER attribute when no conversation is named (ConversationPreview\'s case)', () => {
    const { container } = render(
      <ConversationTranscript messages={[{ role: 'assistant', content: 'hi', timestamp: 1 }]} />,
    );
    expect(container.querySelector('[data-conversation-id]')).toBeNull();
  });

  it('shows a gap marker with the dropped count, singular and plural', () => {
    render(<ConversationTranscript messages={[
      { role: 'user', content: 'q', timestamp: 1, seq: 0, droppedToolCalls: 0 },
      { role: 'assistant', content: 'a', timestamp: 2, seq: 1, droppedToolCalls: 3 },
      { role: 'assistant', content: 'b', timestamp: 3, seq: 2, droppedToolCalls: 1 },
    ]} />);
    expect(screen.getByText(new RegExp(COPY.toolsNotShown(3)))).toBeTruthy();
    expect(screen.getByText(new RegExp(COPY.toolsNotShown(1)))).toBeTruthy();
  });

  // Destin, 2026-09-10: "put the '3 tools not shown' warning in the bottom of
  // the assistant message it attaches to, like our real tool/message grouping
  // logic does". `droppedToolCalls` counts the tools that ran BEFORE the message
  // carrying it (transcript-reader.ts), and the real chat attaches a tool group
  // BELOW the sentence it followed (AssistantTurnBubble.tsx, splitIntoBubbles) —
  // so the card belongs after the PREVIOUS message, not above its own. Drawn the
  // old way it sat between the tools and the sentence that preceded them.
  it('hangs a tool gap under the message it followed, not above the next one', () => {
    const { container } = render(<ConversationTranscript messages={[
      { role: 'user', content: 'question', timestamp: 1, seq: 0 },
      { role: 'assistant', content: 'answer', timestamp: 2, seq: 1 },
      { role: 'user', content: 'follow up', timestamp: 3, seq: 2, droppedToolCalls: 3 },
    ]} />);
    const rows = [...container.querySelectorAll('.timeline-entry')];
    expect(rows).toHaveLength(3);
    // The gap recorded on "follow up" renders inside the ANSWER's row.
    expect(rows[1].textContent).toContain('answer');
    expect(rows[1].textContent).toContain(COPY.toolsNotShown(3));
    expect(rows[2].textContent).not.toContain(COPY.toolsNotShown(3));
  });

  // The exception, and the reason the map cannot simply look one row back: a gap
  // on the FIRST message shown has no earlier bubble in the DOM — whatever it
  // followed is off the top of what was read — so it stays above as a lead-in.
  it('keeps a gap on the first message above it, where there is nothing to hang under', () => {
    const { container } = render(<ConversationTranscript messages={[
      { role: 'assistant', content: 'first', timestamp: 1, seq: 5, droppedToolCalls: 2 },
    ]} />);
    const gap = screen.getByText(new RegExp(COPY.toolsNotShown(2)));
    const row = container.querySelector('.timeline-entry');
    expect(row).toBeTruthy();
    expect(row!.contains(gap)).toBe(false);
    expect(row!.compareDocumentPosition(gap) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
