// CommentableDocument — the one layout every commentable file viewer shares:
// the document with hoverable highlights at full width, OR the full Comments
// pane beside it when expanded. Narrow panes never show a marker rail. Lifted out of
// MarkdownView (rounds 2–17 built it there) when Word documents and
// spreadsheets joined (Destin, questions deck Q-4 + chat follow-up: Word and
// Excel comments "work fully natively"), so the three viewers can never
// drift into three slightly different comment layouts.
import { useRef, type ReactNode } from 'react';
import { CommentsMargin } from './CommentsMargin';
import { ReadingHighlights } from './ReadingHighlights';
import { useContainerNarrow } from '../../hooks/use-container-narrow';
import { useRefSourceHighlight } from './use-ref-source-highlight';

// 640px, same NUMBER the app's viewport breakpoint uses, but measuring the
// PANE (see useContainerNarrow's own WHY) — SessionDrawer's fixed ~480px
// pane collapses to markers even in a wide window; ProjectView's full-width
// file tab keeps the margin.
const MARGIN_COLLAPSE_PX = 640;

interface Props {
  path: string;
  commentsMode?: 'reading' | 'comments';
  onOpenComments?: (commentId?: string) => void;
  focusThreadId?: string;
  /** build-menu.ts's `data-artifact-source`: 'raw' text cites line numbers,
   *  'rendered' prose and 'sheet' cells fall back to the quote / the cell. */
  source: 'rendered' | 'raw' | 'sheet';
  /** The content scrolls ITSELF (a spreadsheet grid, with its formula bar
   *  and sheet tabs pinned around it) — so no outer scroller is added, and
   *  the content column fills the height instead of growing past it. */
  fill?: boolean;
  /** Extra classes for the content column (e.g. Word's `.doc-html`). */
  contentClassName?: string;
  /** T5 (doc-comments build, design §7): forwarded to `useDocComments` via
   *  CommentsMargin/ReadingHighlights so the real IPC calls know which
   *  project's sidecar (or tracked `.docx`/`.xlsx`) to reach. */
  projectRoot?: string;
  children: ReactNode;
}

export function CommentableDocument({
  path, commentsMode = 'reading', onOpenComments, focusThreadId,
  source, fill = false, contentClassName = '', children, projectRoot,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [rootRef, narrow] = useContainerNarrow<HTMLDivElement>(MARGIN_COLLAPSE_PX);
  // Hover/click an "Ask about this" chip → light up its source text here.
  // F3 (T5 review): projectRoot threaded through so a repeated relative path
  // across two open projects highlights only ITS OWN comments.
  useRefSourceHighlight(contentRef, path, projectRoot);
  // WHY only two views: a narrow pane keeps the same hoverable highlights as
  // Reading mode, with no marker rail. Only the expanded view gets a full comment list
  // beside the document (Destin, comment-popup-review#2 follow-up).
  const wideComments = commentsMode === 'comments' && !narrow;
  const content = (
    <div
      ref={contentRef}
      className={`flex-1 min-w-0 ${fill ? 'h-full' : 'p-4'} ${contentClassName}`}
      data-artifact-viewer
      data-doc-path={path}
      data-artifact-source={source}
      // F3 fix (T5 review): build-menu.ts's "Add comment" has no React props
      // of its own — it reads this container's own attributes at click time,
      // the same way it already reads `data-doc-path`. Without this, a
      // comment added via the right-click menu had no way to know WHICH
      // project's copy of `path` it belonged to and always landed in the
      // per-machine loose-file partition, even when this file is really
      // inside a known project (two projects sharing a relative path, e.g.
      // both having a `README.md`, would then merge their comments).
      data-project-root={projectRoot ?? ''}
    >
      {children}
    </div>
  );
  const inline = wideComments
    ? null
    // A spreadsheet has no text selection to comment on — its cells are
    // commented by right-clicking them (build-menu.ts) — so the auto-popping
    // selection menu stays off there.
    : <ReadingHighlights containerRef={contentRef} path={path} onOpenComments={onOpenComments ?? (() => {})} selectionMenu={source !== 'sheet'} popoverOnTouch={narrow} projectRoot={projectRoot} />;
  return (
    <div ref={rootRef} className="flex h-full">
      {fill ? (
        <div className="flex-1 min-w-0 h-full flex">{content}{inline}</div>
      ) : (
        <div className="scroll-mask flex-1 min-w-0 overflow-auto">
          {/* WHY an inner min-h-full flex row: a scroller's own flex children
              stretch only to the scroller's VISIBLE height, so the marker rail
              (and its divider line) would end one screen down while the text
              kept going. This row grows to the full document height. */}
          <div className="flex min-h-full">{content}{inline}</div>
        </div>
      )}
      {wideComments && <CommentsMargin containerRef={contentRef} path={path} narrow={false} openThreadId={focusThreadId} projectRoot={projectRoot} />}
    </div>
  );
}
