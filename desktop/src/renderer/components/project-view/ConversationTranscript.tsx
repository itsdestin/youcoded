// The read-only bubble list, shared by Project View's ConversationPreview and
// the Session Drawer's SessionPreviewPane. Markdown ON (code blocks and lists
// in a past conversation are unreadable as raw text); sessionId OFF (file
// chips would resolve against the CURRENT session's folder, which is usually
// not where this conversation happened).
import { useEffect, useRef } from 'react';
import MarkdownContent from '../MarkdownContent';
import { TerminalIcon } from '../Icons';
import type { HistoryMessage } from '../../../shared/types';
import { COPY } from '../../../shared/chatsearch-refs';

export type TranscriptRow = HistoryMessage & { seq?: number; droppedToolCalls?: number };

// The reader dropped tool activity here. Say so — a seamless join would present
// an edited conversation as the whole one. Destin (2026-08-27 gate, M-toolgap):
// draw it as a tool card, not a centred dash line — same border/padding/`|`
// separator as the real group header in AssistantTurnBubble.tsx, so a gap in a
// past conversation looks like what it is. No chevron and no button: there is
// nothing behind it to open. It sizes to its own text rather than filling the
// row — a full-width card with an empty right end read as a stretched pill. The
// glyph is the terminal mark, NOT the check the real header shows on success:
// the reader dropped these tools without reading their results, so claiming they
// all completed would be asserting something nobody checked.
function toolGap(n: number) {
  return (
    <div className="mb-3 flex justify-start">
      <div className="w-fit max-w-[85%] border border-edge rounded-lg px-3 py-1.5 flex items-center gap-1.5">
        <TerminalIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs text-fg-dim">{COPY.toolsNotShown(n)}</span>
      </div>
    </div>
  );
}

export default function ConversationTranscript({ messages, olderHint, scrollToEndKey, conversationId, conversationTitle }: {
  messages: TranscriptRow[];
  /** Rendered above the first message, e.g. a Load older button. */
  olderHint?: React.ReactNode;
  /** Change this value to jump to the newest message (initial load). */
  scrollToEndKey?: unknown;
  /**
   * Set ONLY by a caller previewing a specific past conversation (today:
   * SessionPreviewPane) — never by ConversationPreview (Project View), which
   * has no chatsearch-indexed id to offer. Presence is what lets the
   * right-click menu fire here at all (build-menu.ts widens its `.chat-scroll`
   * gate to also accept this container), and what lets its "Ask about this"
   * scaffold name the conversation instead of a bare quote — see
   * docs/active/specs/2026-08-26-conversation-preview-header-design.md §A3.
   */
  conversationId?: string;
  conversationTitle?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [scrollToEndKey]);
  return (
    // w-full + min-w-0: this sits inside .drawer-pane, which collapses to 100%
    // on narrow screens WITHOUT resizing children (.claude/rules/narrow-viewport.md).
    // data-conversation-id/-title: React drops both when conversationId is
    // undefined, so ConversationPreview (which never passes it) renders
    // neither attribute and its right-click behaviour is untouched.
    <div className="w-full min-w-0 max-w-[680px] mx-auto" data-conversation-id={conversationId} data-conversation-title={conversationTitle}>
      {olderHint}
      {/* A gap recorded on the FIRST message shown has no earlier bubble to
          hang under — the message it followed is off the top of what was read.
          It stays above, as a lead-in. */}
      {!!messages[0]?.droppedToolCalls && toolGap(messages[0].droppedToolCalls!)}
      {messages.map((m, i) => {
        // WHY the NEXT message's count and not this one's: `droppedToolCalls`
        // records the tools that ran BEFORE the message carrying it
        // (transcript-reader.ts pushes a message's text first, then counts its
        // own tool calls toward the gap before the next one). Drawn above that
        // message, the card sits between the tools and the sentence that
        // PRECEDED them. The real chat groups the other way round — "a tool
        // never splits: it belongs to whatever the assistant was doing, the
        // silent step before it, or the sentence it just said"
        // (AssistantTurnBubble.tsx, splitIntoBubbles) — so the gap belongs
        // under the message it followed. Destin, 2026-09-10: "put the '3 tools
        // not shown' warning in the bottom of the assistant message it attaches
        // to, like our real tool/message grouping logic does".
        const gapAfter = messages[i + 1]?.droppedToolCalls ?? 0;
        return (
          // `timeline-entry` is the chat timeline's own containment (layout +
          // style, NOT content-visibility — its implicit contain:paint clips
          // community themes' bubble glows, see globals.css). A preview can
          // hold a couple of hundred markdown bubbles; this keeps an off-screen
          // one out of layout without changing how it paints.
          <div key={m.seq ?? i} className="timeline-entry">
            <div className={`${gapAfter ? 'mb-1.5' : 'mb-3'} flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {/* user-bubble / assistant-bubble: the SAME hook classes the real
                  chat's UserMessage.tsx / AssistantTurnBubble.tsx carry. Theme
                  packs' custom_css targets these names directly (they're on
                  theme-validator.ts's KNOWN_THEME_HOOKS allowlist) — without
                  them, a theme that restyles chat bubbles (border, glow, shadow)
                  silently skips this read-only preview, so the same conversation
                  looks like two different apps depending which surface it's
                  viewed from. This does not change layout/geometry, only which
                  selectors can reach these nodes. */}
              <div className={`min-w-0 break-words rounded-2xl px-5 py-3 text-sm ${m.role === 'user' ? 'user-bubble max-w-[80%] rounded-br-sm bg-accent text-on-accent' : 'assistant-bubble max-w-[85%] rounded-bl-sm bg-inset text-fg'}`}>
                <MarkdownContent content={m.content} />
              </div>
            </div>
            {!!gapAfter && toolGap(gapAfter)}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
