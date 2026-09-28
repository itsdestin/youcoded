// What a failed Office save offers (the owner's decision, Task 6 fix round 1): the reason main
// gave, and three ways out — Retry, "Save a copy…" and "Close without saving" (confirmed first).
// Used by the Office page's tab strip and by the in-place editor's bar, so a file that can
// never save (a read-only file, a disk that is gone) never leaves an editor that cannot close
// and never loses its changes without the person choosing that.
import React, { useEffect, useState, type RefObject } from 'react';
import { Button, Dialog, ErrorState } from '../ui';
import type { EditorFrameHandle } from './EditorFrame';
import { useCopying } from './office-store';

export function OfficeSaveFailed({ path, message, frame, onCloseWithoutSaving, className = '', visible = true }: {
  /** The file this strip is for (its copy-in-progress state). */
  path: string;
  message: string;
  /** false while the Office page is kept but not on view: no confirm may open (or hold Escape). */
  visible?: boolean;
  frame: RefObject<EditorFrameHandle | null> | { current: EditorFrameHandle | null | undefined };
  /** Runs after the person confirmed: the host closes the tab or leaves the in-place edit. */
  onCloseWithoutSaving: () => void;
  className?: string;
}) {
  // WHY asked, not assumed: a copy goes through the same translation as the save, so after a
  // translation failure — or with no edited copy ever handed over (a full temp disk) — it cannot
  // succeed, and offering it would only fail again.
  const [canCopy, setCanCopy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Fix round 5: while a copy is written, every action here is disabled — a Retry or a Close
  // without saving pressed mid-copy would race the copy's own save and switch.
  const copying = useCopying(path);
  useEffect(() => {
    let live = true;
    void frame.current?.canSaveCopy().then((ok) => { if (live) setCanCopy(ok); });
    return () => { live = false; };
  }, [frame, message]);

  const saveCopy = async () => {
    setCopyError(null);
    const r = await frame.current?.saveCopy();
    // Cancelled: nothing changes. Success: the strip says where it went (office-store copiedTo).
    if (r && !r.ok && 'message' in r) setCopyError(r.message);
  };
  const more = [
    ...(canCopy ? [{ label: 'Save a copy…', onClick: () => void saveCopy() }] : []),
    { label: 'Close without saving', onClick: () => setConfirming(true) },
  ];
  return (
    <>
      <ErrorState variant="inline" className={className} message={copyError ?? message} moreActions={more} busy={copying} onRetry={() => frame.current?.save()} />
      {confirming && visible && (
        <CloseWithoutSavingConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); frame.current?.discard(); onCloseWithoutSaving(); }}
        />
      )}
    </>
  );
}

function CloseWithoutSavingConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  // The app's confirm shell (<Dialog>: scrim, Esc = Cancel through the shared Esc stack).
  return (
    <Dialog
      open
      onClose={onCancel}
      title="Close without saving?"
      size="prompt"
      layer={3}
      destructive
      noScreen="opens only after a real save has failed, which the photo build's fake host never produces"
    >
      <p className="text-sm text-fg-2 pb-4">Your changes since the last save will be lost.</p>
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm}>Close</Button>
      </div>
    </Dialog>
  );
}
