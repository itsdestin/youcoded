// CommentsPaneFrame — the settled Comments-mode side panel (round 16, Destin:
// "the rounded corners and such of sheet, the bigger panel from column, and
// the title from titled… show resolved should be a toggle at the top like
// show completed in resume browser"; round 17 dropped the title's count).
// Shared by CommentsMargin (text documents) and CodeCommentsRail (code
// files) so the two can never drift into different panels.
//
// data-comments-pane: the panel's outer edge, measured by ActiveArtifactView
// so the floating Comments/Edit buttons clear it and Ask Your Assistant lines
// up with the cards (the child list carries data-comments-list).
import type { ReactNode, Ref } from 'react';
import { Toggle } from '../ui/Toggle';
import { useDocComments } from '../../state/doc-comments-store';

interface Props {
  path: string;
  children: ReactNode;
  /** The outer column, for callers that measure it. */
  frameRef?: Ref<HTMLDivElement>;
}

export function CommentsPaneFrame({ path, children, frameRef }: Props) {
  const { showResolved, setShowResolved } = useDocComments(path);
  return (
    // w-68 + p-2: the panel itself is 256px wide, inset 8px on every side so
    // its rounded corners read as a panel.
    <div ref={frameRef} className="w-68 shrink-0 p-2">
      <div data-comments-pane className="h-full rounded-xl border border-edge bg-panel flex flex-col overflow-hidden">
        {/* Title row with Show resolved as the Resume browser's "Show
            Complete" switch — same label recipe and the shared Toggle. */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-edge shrink-0">
          <span className="font-semibold text-sm">Comments</span>
          <div className="flex items-center gap-2">
            {/* text-2xs, not Show Complete's text-3xs: G-5's 11px floor. */}
            <label className="text-2xs font-medium text-fg-muted tracking-wider uppercase">Show Resolved</label>
            <Toggle checked={showResolved} onChange={setShowResolved} aria-label="Show Resolved" />
          </div>
        </div>
        {/* The list is its own scroller: cards are not tied to positions in
            the document, so scrolling the document must not carry them away. */}
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
