// CodeCommentPopover — code files' equivalent of ReadingHighlights' own
// "Add comment" flow (Destin, testing the dev instance: right-click on a
// code file → "Add comment" should look and behave exactly like it does on
// a markdown/text file — a small floating box right at the selection,
// without leaving the plain editor. Before this file existed, code files
// took a different path entirely: ActiveArtifactView had an effect that
// force-switched into the WHOLE Comments panel (CodeCommentsRail) the
// instant a fresh draft appeared, because CM6 has no in-text <mark> to hang
// a popover off of the way ReadingHighlights does for rendered text
// (use-code-comment-anchors.ts's own WHY has the full "CM6 virtualizes its
// DOM" reasoning). That effect is gone — see ActiveArtifactView's own WHY at
// its old call site — replaced by this component, which anchors the SAME
// NewCommentPopover through CodeMirror's own `coordsAtPos` instead of a DOM
// Range.
//
// Existing line markers/anchoring for already-persisted code comments are
// unchanged (CodeCommentsRail + use-code-comment-anchors.ts, shown only in
// Comments mode) — this component only covers the moment a FRESH draft is
// being composed, while still in Reading mode.
import { useEffect, useState } from 'react';
import { NewCommentPopover } from './NewCommentPopover';
import { useDocComments } from '../../state/doc-comments-store';
import { visibleEditorFor } from '../artifact-views/cm/ref-line-highlight';

interface Props {
  path: string;
  /** T5: forwarded to `useDocComments` for the real docComments:* IPC. */
  projectRoot?: string;
}

interface Anchor {
  rect: DOMRect;
  bounds: HTMLElement | null;
}

export function CodeCommentPopover({ path, projectRoot }: Props) {
  const { comments, focusId, setCommentText, removeComment, clearFocus } = useDocComments(path, projectRoot);
  const draftComment = comments.find((c) => c.id === focusId) ?? null;
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Captured once per fresh draft — mirrors ReadingHighlights' own
  // draftAnchor effect (read once when focusId changes, never on every
  // keystroke). build-menu.ts's "Add comment" runs off the LIVE CM6
  // selection and never clears it, so that selection is still exactly what
  // was right-clicked by the time this effect runs.
  useEffect(() => {
    if (!focusId) { setAnchor(null); return; }
    const view = visibleEditorFor(path);
    if (!view) { setAnchor(null); return; }
    const comment = comments.find((c) => c.id === focusId);
    const range = view.state.selection.main;
    // A selection's END, same as ReadingHighlights' lastRectOf — falls back
    // to the line the comment was minted against (cellEntries/artifactMenu's
    // own `lineOpts`) on the rare chance the live selection already moved on.
    const line = comment?.startLine != null
      ? Math.max(1, Math.min(comment.startLine, view.state.doc.lines))
      : null;
    const pos = !range.empty ? range.to : line != null ? view.state.doc.line(line).to : null;
    const coords = pos != null ? view.coordsAtPos(pos) : null;
    if (!coords) { setAnchor(null); return; }
    // CM6's editor host carries `data-artifact-viewer` (CodeEditorView.tsx) —
    // the same "viewer's own content area, never the window" bound
    // NewCommentPopover's own WHY requires.
    const bounds = view.dom.closest<HTMLElement>('[data-artifact-viewer]');
    setAnchor({ rect: new DOMRect(coords.right, coords.bottom, 0, 0), bounds });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per fresh draft (focusId); comments/path are looked up, not triggers
  }, [focusId]);

  if (!draftComment || !anchor) return null;
  return (
    <NewCommentPopover
      comment={draftComment}
      anchorRect={anchor.rect}
      boundsEl={anchor.bounds}
      onTextChange={(t) => setCommentText(draftComment.id, t)}
      onDone={clearFocus}
      onCancel={() => removeComment(draftComment.id)}
    />
  );
}
