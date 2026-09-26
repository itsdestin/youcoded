// CommentsFloatingActions — Comments mode's two actions, "Show resolved" and
// the one primary action for the whole view (G-4) "Ask Your Assistant",
// which sends every OPEN comment as a batch.
//
// Destin, round 5: "the 'ask assistant' and 'show resolved' buttons in the
// comment pane shouldn't have a separate background/panel, they should float
// over the same [comment] panel". They render in SessionDrawer's floating
// bottom-right cluster, stacked above the Comments/Edit row, with no bar or
// surface of their own. The icon is the
// "ask" sparkle the "Ask about this" menu row uses, so both ways of asking the
// assistant about marked-up text share one glyph.
import { Button } from '../ui/Button';
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
      quote: c.quote,
      cell: c.cell,
      // 60, not the default 28: these chips render one per line in the sent
      // bubble (UserMessage groups a batch), so there is room to read the note.
      label: `“${truncateQuote(c.text.trim() || c.quote, 60)}”`,
    }));
    // Short and plain (Destin, polish pass: "a short plain lead sentence").
    const lead = `Please work through ${open.length === 1 ? 'my comment' : `my ${open.length} comments`} on ${basenameOf(path)}:`;
    // WHY a window event, not a prop: these buttons live in the file viewer,
    // the composer lives in InputBar — siblings several layers apart with no
    // shared ancestor built for this. build-menu.ts's "Ask about this" uses
    // the same pattern. This calls the composer's OWN normal send path — it
    // is not a second way to deliver a message.
    window.dispatchEvent(new CustomEvent('youcoded:compose-send-comments', { detail: { lead, refs } }));
  };
  return { openCount: open.length, send };
}

export function CommentsFloatingActions({ path, withShowResolved = true }: { path: string; withShowResolved?: boolean }) {
  const { comments, showResolved, setShowResolved } = useDocComments(path);
  const { openCount, send } = useSendOpenComments(path);
  const resolvedCount = comments.filter((c) => c.resolved).length;
  const askTitle = openCount === 0
    ? 'No open comments to ask about'
    : `Ask your assistant to work through ${openCount === 1 ? 'the open comment' : `the ${openCount} open comments`}`;

  // Round 7 (Destin: "the buttons in the panel should be the full width of
  // the panel … review this against existing app ui"): plain Button
  // primitives (G-1), full width of the comment column (G-28: an action is
  // full width or on the right), one primary (G-4). The host sizes this to
  // the margin's card width. Counts are "label + muted numeral" (G-19) —
  // never an accent badge (G-8).
  return (
    <div className="flex flex-col gap-2 w-full">
      {withShowResolved && resolvedCount > 0 && (
        // `raised` (solid panel fill + edge border) — the primitive's variant
        // for a control that sits ON other content. Round 8: `secondary` is
        // transparent/outlined, so floating over a card it read as a hole.
        <Button
          variant="raised"
          size="md"
          aria-pressed={showResolved}
          onClick={() => setShowResolved(!showResolved)}
          className="pointer-events-auto w-full"
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
          <span className="text-fg-muted">{resolvedCount}</span>
        </Button>
      )}
      <Button
        variant="primary"
        size="md"
        disabled={openCount === 0}
        title={askTitle}
        onClick={send}
        className="pointer-events-auto w-full"
      >
        <MenuIcon name="ask" />
        Ask Your Assistant
      </Button>
    </div>
  );
}
