// Task 6.4: MarkdownView is now a fully controlled component.
// Edit state (editing, draft) is managed by ActiveArtifactView in SessionDrawer.tsx
// so the conflict banner has access to the in-progress draft.
import MarkdownContent from '../MarkdownContent';
import type { ArtifactViewProps } from './types';
// Doc comments: the highlights / comment pane layout is shared with the Word
// and spreadsheet viewers (CommentableDocument's own WHY). Skipped in edit
// mode: a highlighted span over a live textarea draft has nothing to anchor to.
import { CommentableDocument } from '../comments/CommentableDocument';

// NOTE: Edit/Save/Cancel live in the HOST's header (SessionDrawer toolbar /
// ProjectDetailOverlay tools via the controlsInHeader handle) — this view never
// renders its own buttons. The former `!hideControls` in-view button blocks were
// dead code (every consumer passes controlsInHeader) and were removed.
export function MarkdownView({
  path, content,
  editing = false, draft = '', onDraftChange,
  commentsMode = 'reading', onOpenComments, focusThreadId,
}: ArtifactViewProps) {
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
  return (
    <CommentableDocument
      path={path}
      commentsMode={commentsMode}
      onOpenComments={onOpenComments}
      focusThreadId={focusThreadId}
      // Rendered markdown prose doesn't map back to source line numbers (see
      // describeArtifactSelection in build-menu.ts), so only plain-text files
      // get the 'raw' treatment that enables line-number citing.
      source={isMarkdown ? 'rendered' : 'raw'}
    >
      {isMarkdown
        ? <MarkdownContent content={content} />
        : <pre className="font-mono text-sm whitespace-pre-wrap">{content}</pre>}
    </CommentableDocument>
  );
}
