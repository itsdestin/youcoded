// CodeCommentsRail — Comments mode for code files. Same panel as text
// documents (CommentsPaneFrame: title row, Show Resolved switch, Ask Your
// Assistant floating at the bottom) — polish pass, Destin: code comments
// should get "the same close look as markdown".
//
// What differs, and why: CodeMirror 6 virtualises its DOM (only lines near
// the viewport exist), so there are no in-text <mark> highlights to link a
// card to. Instead a card links to its LINES through CodeMirror's own line
// decorations (ref-line-highlight.ts): hovering a card washes its lines,
// clicking one scrolls there and flashes them.
import { useMemo, useState } from 'react';
import { CommentCard } from './CommentCard';
import { CommentsPaneFrame } from './CommentsPaneFrame';
import { EmptyState } from '../ui/states';
import { useDocComments, type DocComment } from '../../state/doc-comments-store';
import { dispatchRefHover, jumpToRef, type ComposeRef } from '../context-menu/compose-ref';
// T14 (§2.2/§2.3): a card's lines come from the LIVE anchoring pass, not the
// comment's own stale creation-time startLine/endLine — see the hook's WHY.
import { useCodeCommentAnchors, type ResolvedLines } from './use-code-comment-anchors';

interface Props {
  path: string;
  /** T5: forwarded to `useDocComments` for the real docComments:* IPC. */
  projectRoot?: string;
}

/** A card's CURRENTLY-resolved lines as a ref, so the chip highlighter lights
 *  the right lines even after an edit moved them. `null` (no jump/hover
 *  wiring at all) when `resolveSelector` couldn't anchor this comment right
 *  now — §2.3: a detached comment gets no highlight, never a stale one. */
function linesRef(c: DocComment, path: string, resolved: Map<string, ResolvedLines>): ComposeRef | null {
  const lines = resolved.get(c.id);
  if (!lines) return null;
  return { id: c.id, kind: 'doc', label: '', path, lineRange: [lines.startLine, lines.endLine] };
}

export function CodeCommentsRail({ path, projectRoot }: Props) {
  const { comments, focusId, showResolved, setCommentText, commitDraft, addReply, resolveComment, reopenComment, removeComment } = useDocComments(path, projectRoot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // T14 fix: this MUST be memoized, not recomputed on every render — it now
  // feeds `useCodeCommentAnchors`'s effect deps below, and an unmemoized
  // `.filter().sort()` hands that effect a BRAND NEW array reference on
  // every render (including one that hook's OWN `setResolved` just caused),
  // retriggering it forever (`Error: Maximum update depth exceeded`, found
  // running this in the workbench). CommentsMargin.tsx/ReadingHighlights.tsx
  // already memoize their own equivalent `visible` for the same reason.
  const visible = useMemo(
    () => comments.filter((c) => showResolved || !c.resolved).sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0) || a.createdAt - b.createdAt),
    [comments, showResolved],
  );
  const resolvedLines = useCodeCommentAnchors(path, visible);
  // T6 (design §2.3): `visible` above is sorted by each comment's STALE
  // creation-time `startLine` — fine as `useCodeCommentAnchors`'s input (order
  // doesn't affect what it resolves), but wrong for what the user actually
  // sees: a comment `resolveSelector` can no longer anchor has no live line to
  // sort by at all, so it needs to drop out of "document order" rather than
  // sit wherever its old line number happens to land it. Anchored comments
  // are re-sorted by their CURRENT line (an edit above them may have shifted
  // it since `visible` was sorted); detached ones are grouped after, in the
  // order they were already in.
  const ordered = useMemo(() => {
    const anchored = visible.filter((c) => resolvedLines.has(c.id));
    anchored.sort((a, b) => resolvedLines.get(a.id)!.startLine - resolvedLines.get(b.id)!.startLine);
    const detached = visible.filter((c) => !resolvedLines.has(c.id));
    return [...anchored, ...detached];
  }, [visible, resolvedLines]);

  return (
    <CommentsPaneFrame path={path} projectRoot={projectRoot}>
      {/* pb-28: room to scroll the last card up past the floating Ask Your
          Assistant button. */}
      <div data-comments-list className="flex flex-col gap-2 p-2 pb-28">
        {ordered.length === 0 && (
          <EmptyState message="No comments on this file yet." variant="inline" />
        )}
        {ordered.map((c) => {
          const ref = linesRef(c, path, resolvedLines);
          return (
            <div
              key={c.id}
              // Clicking a card's background jumps the editor to its lines and
              // keeps the card lit; clicks on the card's own controls are left alone.
              onClick={(e) => {
                if (!ref || (e.target as HTMLElement).closest('button, input, textarea')) return;
                setSelectedId(c.id);
                jumpToRef(ref);
              }}
              onMouseEnter={ref ? () => dispatchRefHover(ref) : undefined}
              onMouseLeave={ref ? () => dispatchRefHover(null) : undefined}
              className={`rounded-lg transition-shadow ${ref ? 'cursor-pointer' : ''} ${c.id === selectedId ? 'ring-2 ring-accent/60' : ''}`}
            >
              <CommentCard
                comment={c}
                autoFocus={c.id === focusId}
                onTextChange={(t) => setCommentText(c.id, t)}
                onCommit={() => commitDraft(c.id)}
                onReply={(t) => addReply(c.id, 'user', t)}
                onResolve={() => resolveComment(c.id, 'user')}
                onReopen={() => reopenComment(c.id)}
                onDelete={() => removeComment(c.id)}
              />
            </div>
          );
        })}
      </div>
    </CommentsPaneFrame>
  );
}
