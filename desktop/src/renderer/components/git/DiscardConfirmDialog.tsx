// L3 destructive confirm for the git surface (spec section 5). Uses the shared
// overlay primitives — never a hand-rolled bg-black/40 (react-renderer rule).
// The copy states EXACTLY what happens; the failure path (surfaced by the
// caller) carries real git stderr.
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { Button } from '../ui';
import { useEscClose } from '../../hooks/use-esc-close';

export interface DiscardConfirmDialogProps {
  fileName: string;
  /** true = HEAD has no committed copy (untracked OR staged-new) — the file
   *  goes to the OS trash instead of being restored from HEAD */
  willTrash: boolean;
  onConfirm: () => void;  // caller runs git.discard and closes
  onCancel: () => void;
}

export function DiscardConfirmDialog({ fileName, willTrash, onConfirm, onCancel }: DiscardConfirmDialogProps) {
  // Escape = cancel, routed through the shared useEscClose LIFO stack (same
  // pattern as CloseSessionPrompt). A dialog-local capture-phase listener
  // does NOT work here: EscCloseProvider's own capture-phase window listener
  // fires in registration order (it mounts once at App root, before this
  // dialog ever exists), so it always runs FIRST and pops whatever is
  // beneath us on the stack — e.g. SessionDrawer's handleBack — even if this
  // dialog also calls stopPropagation() in its own listener. stopPropagation
  // only stops propagation to ancestor/descendant nodes; it does nothing to
  // sibling listeners already registered on the same window. Joining the
  // stack via useEscClose(true, onCancel) instead pushes THIS dialog on top,
  // so EscCloseProvider pops us first and the drawer's entry underneath
  // never fires.
  useEscClose(true, onCancel);

  return (
    <Scrim layer={3} onClick={onCancel} className="flex items-center justify-center">
      <OverlayPanel
        layer={3}
        destructive
        role="alertdialog"
        aria-modal
        aria-label={willTrash ? 'Move file to trash' : 'Revert changes'}
        className="p-4 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-fg mb-1">
          {willTrash ? `Move “${fileName}” to the system trash?` : `Restore “${fileName}” to its last committed state?`}
        </div>
        <div className="text-sm text-fg-2 mb-4 break-all">
          {willTrash
            ? 'Git has no committed copy of this file. It goes to the trash, not permanent deletion.'
            : 'Your uncommitted edits to this file will be lost. Staged and unstaged changes are both restored from HEAD.'}
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>{willTrash ? 'Move to trash' : 'Revert changes'}</Button>
        </div>
      </OverlayPanel>
    </Scrim>
  );
}
