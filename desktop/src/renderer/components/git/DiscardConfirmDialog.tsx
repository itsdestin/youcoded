// L3 destructive confirm for the git surface (spec section 5). The copy states
// EXACTLY what happens; the failure path (surfaced by the caller) carries real
// git stderr.
//
// WHY the shared Dialog (known deviations fixed by existing rules, 2026-10-13): this
// was a hand-built Scrim + OverlayPanel with no ✕ and Cancel / Revert side by side.
// The guide's popup rules say every popup has the ✕ and closes on Esc, and two actions
// in a narrow popup stack full width with the main one on top — red on top for a
// destructive confirm (decisions "Closing popups and side panels", "Button arrangement
// by width", "Stacked order and wide pairs"). Copied from Remove project
// (project-view/RemoveProjectDialog.tsx): `prompt` size, layer 3, destructive, the red
// button over the outlined Cancel. Escape still cancels: the Dialog joins the same
// useEscClose stack this file used to join by hand, so it stays on top of the drawer's
// own Escape entry. No onEnter: a destructive main action takes a click, not Enter.
import { Dialog, Button } from '../ui';

export interface DiscardConfirmDialogProps {
  fileName: string;
  /** true = HEAD has no committed copy (untracked OR staged-new) — the file
   *  goes to the OS trash instead of being restored from HEAD */
  willTrash: boolean;
  onConfirm: () => void;  // caller runs git.discard and closes
  onCancel: () => void;
}

export function DiscardConfirmDialog({ fileName, willTrash, onConfirm, onCancel }: DiscardConfirmDialogProps) {
  return (
    <Dialog
      open
      onClose={onCancel}
      layer={3}
      destructive
      size="prompt"
      title={willTrash ? 'Move file to trash' : 'Revert changes'}
      noScreen="opens only from Git review's Revert changes… on a file with uncommitted edits; explore covers it"
    >
      <div className="space-y-2 text-xs text-fg-2 leading-relaxed">
        <p className="font-medium text-fg break-all">
          {willTrash ? `Move “${fileName}” to the system trash?` : `Restore “${fileName}” to its last committed state?`}
        </p>
        <p>
          {willTrash
            ? 'Git has no committed copy of this file. It goes to the trash, not permanent deletion.'
            : 'Your uncommitted edits to this file will be lost. Staged and unstaged changes are both restored from HEAD.'}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="danger" size="md" className="w-full" onClick={onConfirm}>
          {willTrash ? 'Move to trash' : 'Revert changes'}
        </Button>
        <Button variant="secondary" size="md" className="w-full" onClick={onCancel}>Cancel</Button>
      </div>
    </Dialog>
  );
}
