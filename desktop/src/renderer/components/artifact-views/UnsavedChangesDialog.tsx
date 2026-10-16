// Unsaved-changes prompt (D3, decided 2026-07-20): Save / Discard / Keep editing —
// NOT auto-save, which would write real source files with no explicit user
// action and race the agent on the same file. Hosts gate every navigation away
// from a dirty editor (selection change, close, Esc) through useUnsavedGuard.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveArtifactHandle } from './ActiveArtifactView';
import { registerDirtyEditorGuard, unregisterDirtyEditorGuard } from './dirty-editor-guard';
import { Button, CARD_LEVEL_1, Dialog } from '../ui';

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
  // WHY the shared popup (final review F13; decisions "Popup and side-panel titles", "Closing
  // popups", "Unsaved changes: main button" CS6-4): this was a hand-built panel with no ✕ and
  // three FILLED buttons (Button defaults to primary). It now copies the approved "Unsaved
  // changes" popup before quitting (UnsavedBeforeQuit.tsx): the shared title and ✕, the text in
  // one card, and the buttons stacked full width in the narrow popup's footer — Save filled on
  // top (the one main action), Discard outlined in red (it throws edits away), "Keep editing"
  // outlined as the way back ("Cancel" could be read either way). Esc and the ✕ are Keep
  // editing; the Dialog joins the shared Esc stack itself, so one Esc closes only this popup.
  // Layer 3, as before: the guarded navigation can start from a drawer or popup below.
  return (
    <Dialog
      open
      onClose={onCancel}
      title="Unsaved changes"
      size="prompt"
      layer={3}
      noScreen="Only opens while leaving a file with unsaved edits; covered by unsaved-dialog-esc-stack.test.tsx."
      footer={(
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="w-full" onClick={onSave}>Save</Button>
          <Button variant="danger-outline" className="w-full" onClick={onDiscard}>Discard</Button>
          <Button variant="secondary" className="w-full" onClick={onCancel}>Keep editing</Button>
        </div>
      )}
    >
      <div className={`${CARD_LEVEL_1} p-3`}>
        <p className="text-sm text-fg-2 break-all">{fileName} has edits that are not saved yet.</p>
      </div>
    </Dialog>
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
