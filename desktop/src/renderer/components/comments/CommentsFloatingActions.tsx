// CommentsFloatingActions — Comments mode's two actions, "Show resolved" and
// the one primary action for the whole view (G-4) "Ask Your Assistant",
// which sends every OPEN comment as a batch.
//
// Destin, round 5: "the 'ask assistant' and 'show resolved' buttons in the
// comment pane shouldn't have a separate background/panel, they should float
// over the same [comment] panel". So these are floating pills in the same
// family as the viewer's floating Edit/Save buttons (SessionDrawer's
// bottom-right cluster, which is where they render — stacked above the
// Comments/Edit row), not a footer bar with its own surface. The icon is the
// "ask" sparkle the "Ask about this" menu row uses, so both ways of asking the
// assistant about marked-up text share one glyph.
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
    // WHY a window event, not a prop: these buttons live in the file viewer,
    // the composer lives in InputBar — siblings several layers apart with no
    // shared ancestor built for this. build-menu.ts's "Ask about this" uses
    // the same pattern. This calls the composer's OWN normal send path — it
    // is not a second way to deliver a message.
    window.dispatchEvent(new CustomEvent('youcoded:compose-send-comments', { detail: { lead, refs } }));
  };
  return { openCount: open.length, send };
}

// Same shape/type/shadow as the floating Edit (primary) and Cancel
// (secondary) buttons beside them, so the whole cluster reads as one set.
const FLOAT_BASE = 'pointer-events-auto flex items-center gap-2 rounded-full text-sm font-semibold shadow-lg transition-colors';
const FLOAT_SECONDARY = `${FLOAT_BASE} px-3.5 py-2 bg-panel text-fg-2 border border-edge hover:text-fg hover:bg-well`;
const FLOAT_PRIMARY = `${FLOAT_BASE} px-4 py-2.5 bg-accent text-on-accent hover:opacity-90 disabled:opacity-50 disabled:hover:opacity-50`;

export function CommentsFloatingActions({ path }: { path: string }) {
  const { comments, showResolved, setShowResolved } = useDocComments(path);
  const { openCount, send } = useSendOpenComments(path);
  const resolvedCount = comments.filter((c) => c.resolved).length;
  const askTitle = openCount === 0
    ? 'No open comments to ask about'
    : `Ask your assistant to work through ${openCount === 1 ? 'the open comment' : `the ${openCount} open comments`}`;

  return (
    <>
      {resolvedCount > 0 && (
        <button type="button" aria-pressed={showResolved} onClick={() => setShowResolved(!showResolved)} className={FLOAT_SECONDARY}>
          {showResolved ? 'Hide resolved' : 'Show resolved'}
          <Badge>{resolvedCount}</Badge>
        </button>
      )}
      <button type="button" disabled={openCount === 0} title={askTitle} onClick={send} className={FLOAT_PRIMARY}>
        <MenuIcon name="ask" />
        Ask Your Assistant
      </button>
    </>
  );
}
