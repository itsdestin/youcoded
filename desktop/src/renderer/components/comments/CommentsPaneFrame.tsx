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
import { createContext, useContext, type ReactNode, type Ref } from 'react';
import { Toggle } from '../ui/Toggle';
import { CloseButton } from '../ui/CloseButton';
import { useDocComments } from '../../state/doc-comments-store';
import { CommentsFloatingActions } from './CommentsFloatingActions';
import type { ComposeRef } from '../context-menu/compose-ref';

/** Set when the host has no floating button cluster of its own (the
 *  Projects screen's file overlay): Ask Your Assistant then floats at the
 *  bottom of this panel instead — the same place it sits in the file drawer,
 *  where SessionDrawer positions it over the panel from outside. `beforeAsk`
 *  runs first (the Projects screen closes itself so the chat is visible). */
export const CommentsActionsInPaneContext = createContext<{
  beforeAsk?: () => void;
  /** Replaces the send (review deck Q-1): the Projects screen asks which
   *  project and model first, in the new-session dialog. */
  sendVia?: (lead: string, refs: ComposeRef[]) => void;
} | null>(null);

/** Leaves Comments mode — the panel's own × (review deck R-3). */
export const CommentsCloseContext = createContext<(() => void) | null>(null);

interface Props {
  path: string;
  children: ReactNode;
  /** The outer column, for callers that measure it. */
  frameRef?: Ref<HTMLDivElement>;
}

export function CommentsPaneFrame({ path, children, frameRef }: Props) {
  const { showResolved, setShowResolved } = useDocComments(path);
  const actionsInPane = useContext(CommentsActionsInPaneContext);
  const closePane = useContext(CommentsCloseContext);
  return (
    // w-68 + p-2: the panel itself is 256px wide, inset 8px on every side so
    // its rounded corners read as a panel.
    <div ref={frameRef} className="w-68 shrink-0 p-2">
      <div data-comments-pane className="relative h-full rounded-xl border border-edge bg-panel flex flex-col overflow-hidden">
        {/* Review deck R-3 (Destin, 2026-09-26): "move show resolved to be at
            the top of the panel under the title/header divider line. add an
            'x' in the top right of the comment panel". The × leaves Comments
            mode, the same as pressing the floating Comments button again. */}
        <div className="flex items-center justify-between gap-2 pl-3 pr-1.5 py-1.5 border-b border-edge shrink-0">
          <span className="font-semibold text-sm">Comments</span>
          {closePane && <CloseButton size="icon-sm" label="Close comments" onClick={closePane} />}
        </div>
        {/* Show resolved as the Resume browser's "Show Complete" switch — same
            label recipe and the shared Toggle; text-2xs for G-5's 11px floor. */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 shrink-0">
          <label className="text-2xs font-medium text-fg-muted tracking-wider uppercase">Show Resolved</label>
          <Toggle checked={showResolved} onChange={setShowResolved} aria-label="Show Resolved" />
        </div>
        {/* The list is its own scroller: cards are not tied to positions in
            the document, so scrolling the document must not carry them away. */}
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        {/* Floats over the list's bottom (no bar behind it, Destin round 5);
            the list's pb-28 lets the last card scroll clear of it. */}
        {actionsInPane && (
          <div className="absolute inset-x-2 bottom-2">
            <CommentsFloatingActions path={path} beforeSend={actionsInPane.beforeAsk} sendVia={actionsInPane.sendVia} />
          </div>
        )}
      </div>
    </div>
  );
}
