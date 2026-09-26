// CommentableDocument — the one layout every commentable file viewer shares:
// the document, plus EITHER Reading mode's highlights (full width) OR
// Comments mode's pane (a marker rail when the pane is narrow). Lifted out of
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
  children: ReactNode;
}

export function CommentableDocument({
  path, commentsMode = 'reading', onOpenComments, focusThreadId,
  source, fill = false, contentClassName = '', children,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [rootRef, narrow] = useContainerNarrow<HTMLDivElement>(MARGIN_COLLAPSE_PX);
  // Hover/click an "Ask about this" chip → light up its source text here.
  useRefSourceHighlight(contentRef, path);
  // Round 13: the wide comment list is its own scroller BESIDE the document
  // (cards stack from the top, no longer pinned to their highlights). Only
  // the narrow marker rail still lives inside the document's scroller, since
  // its markers do sit level with their highlights.
  const wideComments = commentsMode === 'comments' && !narrow;
  const content = (
    <div
      ref={contentRef}
      className={`flex-1 min-w-0 ${fill ? 'h-full' : 'p-4'} ${contentClassName}`}
      data-artifact-viewer
      data-doc-path={path}
      data-artifact-source={source}
    >
      {children}
    </div>
  );
  const inline = commentsMode === 'comments'
    ? (narrow && <CommentsMargin containerRef={contentRef} path={path} narrow openThreadId={focusThreadId} />)
    // A spreadsheet has no text selection to comment on — its cells are
    // commented by right-clicking them (build-menu.ts) — so the auto-popping
    // selection menu stays off there.
    : <ReadingHighlights containerRef={contentRef} path={path} onOpenComments={onOpenComments ?? (() => {})} selectionMenu={source !== 'sheet'} />;
  return (
    <div ref={rootRef} className="flex h-full">
      {fill ? (
        <div className="flex-1 min-w-0 h-full flex">{content}{inline}</div>
      ) : (
        <div className="flex-1 min-w-0 overflow-auto">
          {/* WHY an inner min-h-full flex row: a scroller's own flex children
              stretch only to the scroller's VISIBLE height, so the marker rail
              (and its divider line) would end one screen down while the text
              kept going. This row grows to the full document height. */}
          <div className="flex min-h-full">{content}{inline}</div>
        </div>
      )}
      {wideComments && <CommentsMargin containerRef={contentRef} path={path} narrow={false} openThreadId={focusThreadId} />}
    </div>
  );
}
