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
import { useState } from 'react';
import { CommentCard } from './CommentCard';
import { CommentsPaneFrame } from './CommentsPaneFrame';
import { EmptyState } from '../ui/states';
import { useDocComments, type DocComment } from '../../state/doc-comments-store';
import { dispatchRefHover, jumpToRef, type ComposeRef } from '../context-menu/compose-ref';

interface Props {
  path: string;
}

/** A card's lines as a ref, so the chip highlighter lights them. */
function linesRef(c: DocComment, path: string): ComposeRef | null {
  if (!c.startLine) return null;
  return { id: c.id, kind: 'doc', label: '', path, lineRange: [c.startLine, c.endLine ?? c.startLine] };
}

export function CodeCommentsRail({ path }: Props) {
  const { comments, focusId, showResolved, setCommentText, addReply, resolveComment, reopenComment, removeComment } = useDocComments(path);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visible = comments
    .filter((c) => showResolved || !c.resolved)
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0) || a.createdAt - b.createdAt);

  return (
    <CommentsPaneFrame path={path}>
      {/* pb-28: room to scroll the last card up past the floating Ask Your
          Assistant button. */}
      <div data-comments-list className="flex flex-col gap-2 p-2 pb-28">
        {visible.length === 0 && (
          <EmptyState message="No comments on this file yet." variant="inline" />
        )}
        {visible.map((c) => {
          const ref = linesRef(c, path);
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
