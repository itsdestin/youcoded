import type { ArtifactContentInfo } from './ActiveArtifactView';

export interface ArtifactViewProps {
  /** Read metadata from artifacts:get. BinaryFallback needs sizeBytes to say
   *  whether the reason it can't show the file is the FORMAT or the SIZE —
   *  stating the wrong one is how a 2.3 MB PNG got "too large" (spec §4.5). */
  contentInfo?: ArtifactContentInfo | null;
  /** The file's EXTENSION says text (.md, .ts, .html) but its bytes sniffed
   *  binary. The format is supported; this particular file is not text — so the
   *  handoff must not claim "can't display .md files", which is false.
   *  Computed by ActiveArtifactView, which owns the routing decision. */
  sniffedBinaryTextFile?: boolean;
  path: string;
  content: string | null;
  absolutePath: string;
  isEditable: boolean;
  onEdit?: (newContent: string) => void;
  // Task 6.4: controlled edit-mode props lifted from MarkdownView into
  // ActiveArtifactView so the conflict banner can manage edit state.
  // Optional — non-editing viewers (Code, Image, etc.) safely ignore them.
  editing?: boolean;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  // When true the viewer renders content/editor only — the Edit / Save / Cancel
  // controls live elsewhere (the SessionDrawer header toolbar drives them via
  // the onStartEdit/onSaveEdit/onCancelEdit callbacks). ProjectView leaves this
  // unset and keeps the in-viewer buttons.
  hideControls?: boolean;
  /** The host's find bar (Ctrl+F) is open and occupying the pane's TOP-RIGHT
   *  corner (ContentFindBar's default `top-2 right-2`). A viewer with its own
   *  floating control up there moves it down out of the way. */
  findBarOpen?: boolean;
  // Doc comments (mockup, round 2): Reading mode (highlights + hover cards,
  // full width) vs Comments mode (the margin/markers rail). Owned by
  // ActiveArtifactView (the toggle lives in its header bar) — MarkdownView is
  // the only consumer today; CodeEditorView's simpler treatment (its rail
  // shown/hidden by mode) lives entirely in ActiveArtifactView instead.
  commentsMode?: 'reading' | 'comments';
  /** "Open in comments" (the hover card's link) — switches mode AND focuses
   *  the given thread. Owned by ActiveArtifactView for the same reason. */
  onOpenComments?: (commentId?: string) => void;
  /** The thread "Open in comments" asked to focus — set once per click, read
   *  once by CommentsMargin (via MarkdownView) to scroll/highlight it. */
  focusThreadId?: string;
}
