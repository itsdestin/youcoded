// Task 6.4: MarkdownView is now a fully controlled component.
// Edit state (editing, draft) is managed by ActiveArtifactView in SessionDrawer.tsx
// so the conflict banner has access to the in-progress draft.
import { useEffect, useState } from 'react';
import MarkdownContent from '../MarkdownContent';
import { PROGRESSIVE_MIN_CHARS } from '../markdown-blocks';
import { requestFindRewalk } from './artifact-find-bridge';
import type { ArtifactViewProps } from './types';
// Doc comments: the highlights / comment pane layout is shared with the Word
// and spreadsheet viewers (CommentableDocument's own WHY). Skipped in edit
// mode: a highlighted span over a live textarea draft has nothing to anchor to.
import { CommentableDocument } from '../comments/CommentableDocument';

/** Plain text is drawn this much per animation frame once a file is big (see ProgressiveText). */
const TEXT_SLICE_CHARS = 64_000;

/**
 * A plain-text file as one <pre>, drawn a slice at a time when it is big.
 * WHY (freeze hunt 2026-10-22, item 4): one <pre> holding up to 12 MB was built and laid out
 * in a single step. The slices are consecutive text nodes inside the SAME <pre>, cut at line
 * ends, so the finished page, its text, selection and copy are exactly the whole file's.
 */
function ProgressiveText({ text, onDone }: { text: string; onDone: (done: boolean) => void }) {
  const [end, setEnd] = useState(() => sliceEnd(text, 0));
  const done = end >= text.length;
  useEffect(() => {
    onDone(done);
    if (done) return;
    // rAF, not a timer: one slice per frame, and nothing at all while the window is hidden.
    const id = requestAnimationFrame(() => setEnd((e) => sliceEnd(text, e)));
    return () => cancelAnimationFrame(id);
  }, [text, end, done, onDone]);
  const slices: string[] = [];
  for (let at = 0, next = sliceEnd(text, 0); at < Math.min(end, text.length); at = next, next = sliceEnd(text, at)) {
    slices.push(text.slice(at, next));
    if (next >= end) break;
  }
  return <pre className="font-mono text-sm whitespace-pre-wrap">{slices}</pre>;
}

/** Where the slice starting at `from` ends: about TEXT_SLICE_CHARS later, at the end of a line. */
function sliceEnd(text: string, from: number): number {
  const target = from + TEXT_SLICE_CHARS;
  if (target >= text.length) return text.length;
  const nl = text.indexOf('\n', target);
  return nl === -1 ? text.length : nl + 1;
}

// NOTE: Edit/Save/Cancel live in the HOST's header (SessionDrawer toolbar /
// ProjectDetailOverlay tools via the controlsInHeader handle) — this view never
// renders its own buttons. The former `!hideControls` in-view button blocks were
// dead code (every consumer passes controlsInHeader) and were removed.
export function MarkdownView({
  path, content,
  editing = false, draft = '', onDraftChange,
  commentsMode = 'reading', onOpenComments, focusThreadId, projectRoot,
}: ArtifactViewProps) {
  // Which text the big-file draw has finished (null = not yet). Keyed by the text itself so a changed
  // file starts over as "still drawing"; read by Find and the comment highlights, which wait for it.
  const [doneFor, setDoneFor] = useState<string | null>(null);
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
  const big = content.length > PROGRESSIVE_MIN_CHARS;
  const loading = big && doneFor !== content;
  // Stable per text so the child's effect does not restart on every parent render.
  const onDone = (done: boolean) => {
    if (!done || doneFor === content) return;
    setDoneFor(content);
    // A search already typed re-counts against the whole file (ContentFindBar's rewalk).
    requestFindRewalk();
  };
  return (
    <CommentableDocument
      path={path}
      commentsMode={commentsMode}
      onOpenComments={onOpenComments}
      focusThreadId={focusThreadId}
      projectRoot={projectRoot}
      // Rendered markdown prose doesn't map back to source line numbers (see
      // describeArtifactSelection in build-menu.ts), so only plain-text files
      // get the 'raw' treatment that enables line-number citing.
      source={isMarkdown ? 'rendered' : 'raw'}
      loading={loading}
    >
      {/* WHY key={content} (2026-09-28 PR review): comment highlights split
          and wrap the text nodes React rendered here. When the file changed on
          disk (the assistant editing it), React patched those same nodes in
          place — doubling highlighted words, or throwing "The node to be
          removed is not a child of this node" and replacing the viewer with an
          error. Keying on the text makes React build the document fresh
          instead of patching nodes the highlights moved; the highlights then
          re-apply to the new text. Nothing changes while the text is the same. */}
      {isMarkdown
        ? <MarkdownContent key={content} content={content} progressive={big} onProgressive={big ? onDone : undefined} />
        : big
          ? <ProgressiveText key={content} text={content} onDone={onDone} />
          : <pre key={content} className="font-mono text-sm whitespace-pre-wrap">{content}</pre>}
    </CommentableDocument>
  );
}
