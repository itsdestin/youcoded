// Unsaved-changes prompt (D3, decided 2026-07-20): Save / Discard / Cancel —
// NOT auto-save, which would write real source files with no explicit user
// action and race the agent on the same file. Hosts gate every navigation away
// from a dirty editor (selection change, close, Esc) through useUnsavedGuard.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveArtifactHandle } from './ActiveArtifactView';
import { registerDirtyEditorGuard, unregisterDirtyEditorGuard } from './dirty-editor-guard';
import { useEscClose } from '../../hooks/use-esc-close';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { Button } from '../ui';

function UnsavedChangesDialog({
  fileName,
  onSave,
  onDiscard,
  onCancel,
}: {
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  // Esc = Cancel (stay in the editor), via the app's shared LIFO Esc stack.
  // WHY: this used to be a raw capture-phase window listener with
  // stopPropagation(), but stopPropagation cannot stop OTHER capture listeners
  // on the same target — and the useEscClose provider's Esc handler is exactly
  // that. Depending on mount order, one Esc press could cancel this dialog AND
  // pop the top of the app's Esc stack underneath (closing a drawer/popup the
  // user didn't ask to close). Joining the stack makes this dialog the topmost
  // entry while mounted, so one Esc = cancel this dialog only; the provider
  // preventDefaults the event, which also keeps the chat PTY-interrupt
  // passthrough from firing. Always open: the host only mounts this component
  // while a navigation is pending.
  useEscClose(true, onCancel);

  // L3 via the shared overlay primitives (react-renderer rule: never a
  // hand-rolled bg-black/40 — <Scrim> gives the theme-tinted var(--scrim)
  // backdrop and Overlay.tsx owns the z-index). Same layer as its sibling
  // DiscardConfirmDialog: a blocking confirm that can lose work must sit
  // above L1 drawers and L2 popups, because the guarded navigation can be
  // triggered FROM them (drawer toggle, session switch). No `destructive`
  // ring though — unlike the git revert dialog, the headline action here is
  // Save, not destroy.
  return (
    <Scrim layer={3} onClick={onCancel} className="flex items-center justify-center">
      <OverlayPanel
        layer={3}
        role="alertdialog"
        aria-modal
        aria-label="Unsaved changes"
        className="p-4 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-fg mb-1">Unsaved changes</div>
        <div className="text-sm text-fg-2 mb-4 break-all">
          {fileName} has edits that are not saved yet.
        </div>
        <div className="flex gap-2 justify-end">
          <Button onClick={onCancel}>Cancel</Button>
          <Button onClick={onDiscard}>Discard</Button>
          <Button onClick={onSave}>Save</Button>
        </div>
      </OverlayPanel>
    </Scrim>
  );
}

/**
 * Host-side gate: `guard(action)` runs the action immediately when the editor
 * is clean, or holds it behind the Save/Discard/Cancel dialog when dirty.
 * Render `dialog` somewhere in the host tree. Save proceeds only when the save
 * actually lands (a conflict or protected-path refusal keeps the user in the
 * pane, where the corresponding banner is showing).
 */
export function useUnsavedGuard(
  handleRef: React.RefObject<ActiveArtifactHandle | null>,
  fileName: string
): { guard: (action: () => void) => void; dialog: React.ReactNode } {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  pendingRef.current = pending;

  const guard = useCallback((action: () => void) => {
    const h = handleRef.current;
    // Office edits in place save themselves (office-questions#Q-save), so there is nothing to
    // ask — but closing the panel, switching file or session unmounts the editor, and inside
    // autosave's 3 s window that dropped the last changes (C2, Task 6 fix round 1). Leave only
    // once they are saved; a failed save keeps the editor open with its reason and actions.
    if (h?.autosaves && h.editing) { void h.saveEdit().then((ok) => { if (ok) action(); }); return; }
    if (h?.dirty) setPending(() => action);
    else action();
  }, [handleRef]);

  // Make this host's guard reachable by OUTSIDE discard paths (drawer toggle
  // in HeaderBar/OverflowMenu, session switching in App) — they cannot see
  // the handle, but they must not silently discard a dirty draft either.
  useEffect(() => {
    registerDirtyEditorGuard(guard);
    return () => unregisterDirtyEditorGuard(guard);
  }, [guard]);

  const dialog = pending ? (
    <UnsavedChangesDialog
      fileName={fileName}
      onSave={async () => {
        const ok = await handleRef.current?.saveEdit();
        const action = pendingRef.current;
        setPending(null);
        if (ok && action) action();
        // !ok → the pane is showing the conflict/error banner; stay put.
      }}
      onDiscard={() => {
        const action = pendingRef.current;
        setPending(null);
        handleRef.current?.cancelEdit();
        if (action) action();
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { guard, dialog };
}
