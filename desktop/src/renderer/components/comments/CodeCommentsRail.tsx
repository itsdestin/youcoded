// CodeCommentsRail — the "can be simpler" code-file version of the margin.
// CodeMirror 6 virtualizes its DOM (only viewport lines exist), so the
// text-node highlight-and-align trick CommentsMargin uses for markdown isn't
// safe here — the same reason describeArtifactSelection in build-menu.ts
// never counts lines from a CM6 <pre>. This is a plain, ungrouped list of
// cards (no scroll-sync, no in-document highlight); each jumps CodeMirror to
// its line on click.
import { CommentCard } from './CommentCard';
import { EmptyState } from '../ui/states';
import { useDocComments } from '../../state/doc-comments-store';

interface Props {
  path: string;
  onJumpToLine: (line: number) => void;
}

export function CodeCommentsRail({ path, onJumpToLine }: Props) {
  const { comments, focusId, showResolved, setCommentText, addReply, resolveComment, reopenComment, removeComment } = useDocComments(path);
  const visible = comments
    .filter((c) => showResolved || !c.resolved)
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0) || a.createdAt - b.createdAt);

  return (
    // pb-48: room to scroll the last card up past the floating Ask/Show
    // resolved buttons (SessionDrawer's bottom-right cluster).
    // data-comments-pane / data-comments-list: measured by ActiveArtifactView
    // so the floating comment actions line up with these cards.
    <div data-comments-pane className="w-64 shrink-0 border-l border-edge bg-panel overflow-y-auto">
    <div data-comments-list className="p-2 pb-48 flex flex-col gap-2">
      {visible.length === 0 && (
        <EmptyState message="No comments on this file yet." variant="inline" />
      )}
      {visible.map((c) => (
        // Clicking a card's background jumps the editor to its line (code
        // files have no in-text highlight to click, and the quote that used
        // to be the jump target was removed in round 11). Clicks on the
        // card's own controls are left alone.
        <div
          key={c.id}
          onClick={(e) => {
            if (!c.startLine || (e.target as HTMLElement).closest('button, input, textarea')) return;
            onJumpToLine(c.startLine);
          }}
          className={c.startLine ? 'cursor-pointer' : undefined}
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
      ))}
    </div>
    </div>
  );
}
