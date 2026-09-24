// Task 6.4: MarkdownView is now a fully controlled component.
// Edit state (editing, draft) is managed by ActiveArtifactView in SessionDrawer.tsx
// so the conflict banner has access to the in-progress draft.
import { useRef } from 'react';
import MarkdownContent from '../MarkdownContent';
import type { ArtifactViewProps } from './types';
// Doc comments (round 2, Destin): Reading mode (default) shows highlights +
// hover cards at full width; Comments mode shows the margin/markers rail —
// both live INSIDE this same overflow-auto element, as a flex sibling of the
// text column, so whichever one is active scrolls together with the
// document for free (CommentsMargin's own header comment has the full WHY).
// Skipped in edit mode: a highlighted span over a live textarea draft has
// nothing to anchor to.
import { CommentsMargin } from '../comments/CommentsMargin';
import { ReadingHighlights } from '../comments/ReadingHighlights';
import { useContainerNarrow } from '../../hooks/use-container-narrow';

// 640px, same NUMBER the app's viewport breakpoint uses, but measuring the
// PANE (see useContainerNarrow's own WHY) — SessionDrawer's fixed ~480px
// pane collapses to markers even in a wide window; ProjectView's full-width
// file tab keeps the margin.
const MARGIN_COLLAPSE_PX = 640;

// NOTE: Edit/Save/Cancel live in the HOST's header (SessionDrawer toolbar /
// ProjectDetailOverlay tools via the controlsInHeader handle) — this view never
// renders its own buttons. The former `!hideControls` in-view button blocks were
// dead code (every consumer passes controlsInHeader) and were removed.
export function MarkdownView({
  path, content,
  editing = false, draft = '', onDraftChange,
  commentsMode = 'reading', onOpenComments, focusThreadId,
}: ArtifactViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [rootRef, narrow] = useContainerNarrow<HTMLDivElement>(MARGIN_COLLAPSE_PX);

  if (content === null) {
    // Loading / missing / read-error are rendered by ActiveArtifactView (which
    // knows WHICH of the three it is — see ArtifactContentState). A null here
    // is an edge the router shouldn't reach (e.g. a binary sniff routed
    // elsewhere); render nothing rather than claim the file is gone.
    return null;
  }

  if (editing) {
    return (
      <div className="flex flex-col h-full">
        <textarea
          value={draft}
          onChange={(e) => onDraftChange?.(e.target.value)}
          // artifact-edit-textarea marks this for the right-click menu's editable
          // branch (build-menu.ts) — without it right-click here does nothing,
          // since Electron provides no default context menu.
          className="artifact-edit-textarea flex-1 w-full p-3 bg-inset text-fg font-mono text-sm resize-none focus:outline-none"
          // Mobile soft-keyboard optimization: inputMode hints to the keyboard type,
          // enterKeyHint gives Android a sensible Enter button label
          inputMode="text"
          enterKeyHint="enter"
        />
      </div>
    );
  }

  const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown');
  // Round 13: the wide comment list is its own scroller BESIDE the document
  // (cards stack from the top, no longer pinned to their highlights). Only
  // the narrow marker rail still lives inside the document's scroller, since
  // its markers do sit level with their highlights.
  const wideComments = commentsMode === 'comments' && !narrow;
  return (
    <div ref={rootRef} className="flex h-full">
      <div className="flex-1 min-w-0 overflow-auto">
        {/* WHY an inner min-h-full flex row: a scroller's own flex children
            stretch only to the scroller's VISIBLE height, so the marker rail
            (and its divider line) would end one screen down while the text
            kept going. This row grows to the full document height. */}
        <div className="flex min-h-full">
        <div
          ref={contentRef}
          className="flex-1 min-w-0 p-4"
          data-artifact-viewer
          data-doc-path={path}
          // Rendered markdown prose doesn't map back to source line numbers (see
          // describeArtifactSelection in build-menu.ts), so only plain-text files
          // get the 'raw' treatment that enables line-number citing.
          data-artifact-source={isMarkdown ? 'rendered' : 'raw'}
        >
          {isMarkdown
            ? <MarkdownContent content={content} />
            : <pre className="font-mono text-sm whitespace-pre-wrap">{content}</pre>}
        </div>
        {commentsMode === 'comments'
          ? (narrow && <CommentsMargin containerRef={contentRef} path={path} narrow openThreadId={focusThreadId} />)
          : <ReadingHighlights containerRef={contentRef} path={path} onOpenComments={onOpenComments ?? (() => {})} />}
        </div>
      </div>
      {wideComments && <CommentsMargin containerRef={contentRef} path={path} narrow={false} openThreadId={focusThreadId} />}
    </div>
  );
}
