// CommentsPaneFooter — the bottom of Comments mode's margin: "Show resolved"
// and the one primary action for the whole view (G-4), "Ask Your Assistant",
// which sends every OPEN comment as a batch.
//
// Destin, round 4: "the comment pane button should be in the header alongside
// the other actions. the 'send to assistant' should become another 'Ask Your
// Assistant' button with the icon at the bottom of the comment pane." So the
// mode toggle moved to SessionDrawer's header icon row, and this strip moved
// from a toolbar row above the document to a sticky footer inside the margin
// — the action now sits with the comments it acts on. The icon is the same
// "ask" sparkle the "Ask about this" menu row uses, so both ways of asking
// the assistant about marked-up text share one glyph.
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { MenuIcon } from '../context-menu/menu-icons';
import { basenameOf, useDocComments } from '../../state/doc-comments-store';
import { genRefId, truncateQuote, type ComposeRef } from '../context-menu/compose-ref';

/** Puts every open comment on `path` into the composer as pills and sends. */
function useSendOpenComments(path: string) {
  const { comments } = useDocComments(path);
  const open = comments.filter((c) => !c.resolved);
  const send = () => {
    if (open.length === 0) return;
    // Each open comment becomes a pill carrying its OWN note as the label
    // (no wall of text) and its id, so a click on the sent pill jumps
    // straight back to that thread (compose-ref.ts's dispatchJumpToRef).
    const refs: ComposeRef[] = open.map((c): ComposeRef => ({
      id: genRefId(),
      kind: 'doc',
      path,
      fileName: basenameOf(path),
      commentId: c.id,
      label: `¶ "${truncateQuote(c.text.trim() || c.quote)}"`,
    }));
    const lead = `Please go through ${open.length === 1 ? 'this comment' : `these ${open.length} comments`} on ${basenameOf(path)}:`;
    // WHY a window event, not a prop: the margin lives in the file viewer,
    // the composer lives in InputBar — siblings several layers apart with no
    // shared ancestor built for this. build-menu.ts's "Ask about this" uses
    // the same pattern. This calls the composer's OWN normal send path — it
    // is not a second way to deliver a message.
    window.dispatchEvent(new CustomEvent('youcoded:compose-send-comments', { detail: { lead, refs } }));
  };
  return { openCount: open.length, send };
}

export function CommentsPaneFooter({ path, compact = false }: { path: string; compact?: boolean }) {
  const { comments, showResolved, setShowResolved } = useDocComments(path);
  const { openCount, send } = useSendOpenComments(path);
  const resolvedCount = comments.filter((c) => c.resolved).length;
  const askTitle = openCount === 0
    ? 'No open comments to ask about'
    : `Ask your assistant to work through ${openCount === 1 ? 'the open comment' : `the ${openCount} open comments`}`;

  // WHY a compact form: below the margin's collapse width (MarkdownView's
  // narrow branch) the column is a 36px marker rail — only the icon fits.
  // The label moves to the tooltip; Show resolved is dropped here because
  // the marker rail already shows resolved threads as check marks.
  if (compact) {
    return (
      <div className="sticky bottom-0 flex justify-center py-2 bg-canvas border-t border-edge">
        <Button variant="primary" size="sm" className="px-1.5" disabled={openCount === 0} title={askTitle} aria-label="Ask Your Assistant" onClick={send}>
          <MenuIcon name="ask" />
        </Button>
      </div>
    );
  }

  return (
    // WHY sticky: the margin scrolls with the document (both are children of
    // one scroller, so cards stay beside their text) — sticky keeps the
    // action reachable at any scroll position without a second scroll box.
    <div className="sticky bottom-0 flex flex-col gap-2 px-2 py-2 bg-canvas border-t border-edge">
      {resolvedCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showResolved}
          onClick={() => setShowResolved(!showResolved)}
          className="self-start"
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
          <Badge>{resolvedCount}</Badge>
        </Button>
      )}
      <Button variant="primary" size="md" className="w-full gap-1.5" disabled={openCount === 0} title={askTitle} onClick={send}>
        <MenuIcon name="ask" />
        Ask Your Assistant
      </Button>
    </div>
  );
}
