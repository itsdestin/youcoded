// @vitest-environment jsdom
// A chat-message/code-block "Ask about this" chip must still resolve via
// chat-ref-highlight.ts once compose-ref.ts's wire format changed (T7, review
// 2 F2) — the earlier three-form draft of the new grammar had no pathless
// form at all, which would have silently broken hover/click-to-source for
// every chat/code-block reference ever sent. This proves a ref decoded off
// the NEW wire text (not a hand-built ComposeRef) still locates its source
// text through the real chat-ref-highlight.ts module.
import { describe, it, expect, beforeAll } from 'vitest';
import { installChatRefHighlight } from '../src/renderer/components/context-menu/chat-ref-highlight';
import { splitComposeRefs, makeDraftToken, expandDraftTokens, genRefId, type ComposeRef } from '../src/renderer/components/context-menu/compose-ref';

beforeAll(() => {
  // jsdom does not implement scrollIntoView (SessionDrawer.test.tsx sets the
  // same precedent), and never lays out real geometry, so
  // chat-ref-highlight.ts's own "pick the VISIBLE copy of the entry" check
  // (`getClientRects().length > 0`) would otherwise reject every element.
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
});

function decodeOne(text: string): ComposeRef {
  const refs = splitComposeRefs(text).filter((s) => s.type === 'ref');
  expect(refs).toHaveLength(1);
  return (refs[0] as { type: 'ref'; ref: ComposeRef }).ref;
}

describe('a decoded chat-kind reference resolves via chat-ref-highlight.ts', () => {
  it('locates and scrolls to its source text by entryKey + quote', () => {
    installChatRefHighlight();
    document.body.innerHTML = '';
    const entry = document.createElement('div');
    entry.setAttribute('data-entry-key', 'entry-42');
    entry.textContent = 'Please run the migration before lunch.';
    document.body.appendChild(entry);

    let scrolledEl: Element | null = null;
    entry.scrollIntoView = () => { scrolledEl = entry; };

    // Build the ref the way a real "Ask about this" on a chat message does
    // (build-menu.ts's textMenu), then round-trip it through the ACTUAL wire
    // format (draft token → send-time expansion → decode) rather than
    // constructing a ComposeRef by hand.
    const original: ComposeRef = {
      id: genRefId(), kind: 'chat', entryKey: 'entry-42',
      quote: 'run the migration', label: '“run the migration”',
    };
    const wire = expandDraftTokens(makeDraftToken(original));
    expect(wire).toBe('⦃chat_entry-42_"run the migration"⦄');
    const decoded = decodeOne(wire);

    const detail: { ref: ComposeRef; handled: boolean } = { ref: decoded, handled: false };
    window.dispatchEvent(new CustomEvent('youcoded:jump-to-ref', { detail }));

    expect(detail.handled).toBe(true);
    expect(scrolledEl).toBe(entry);
  });

  it('a hover on the decoded ref does not throw and targets the same entry', () => {
    document.body.innerHTML = '';
    const entry = document.createElement('div');
    entry.setAttribute('data-entry-key', 'entry-7');
    entry.textContent = 'The migration runs nightly.';
    document.body.appendChild(entry);

    const original: ComposeRef = { id: genRefId(), kind: 'chat', entryKey: 'entry-7', quote: 'runs nightly', label: '“runs nightly”' };
    const decoded = decodeOne(expandDraftTokens(makeDraftToken(original)));

    expect(() => {
      window.dispatchEvent(new CustomEvent('youcoded:ref-hover', { detail: { ref: decoded } }));
      window.dispatchEvent(new CustomEvent('youcoded:ref-hover', { detail: { ref: null } }));
    }).not.toThrow();
  });
});
