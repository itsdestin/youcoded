// What a failed Office save offers (the owner's decision, Task 6 fix round 1): the reason main
// gave, and three ways out — Retry, "Save a copy…" and "Close without saving" (confirmed first).
// Used by the Office page's tab strip and by the in-place editor's bar, so a file that can
// never save (a read-only file, a disk that is gone) never leaves an editor that cannot close
// and never loses its changes without the person choosing that.
import React, { useEffect, useState, type RefObject } from 'react';
import { Button, ErrorState } from '../ui';
import { OverlayPanel, Scrim } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import type { EditorFrameHandle } from './EditorFrame';

export function OfficeSaveFailed({ message, frame, onCloseWithoutSaving, className = '' }: {
  message: string;
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
      <ErrorState variant="inline" className={className} message={copyError ?? message} moreActions={more} onRetry={() => frame.current?.save()} />
      {confirming && (
        <CloseWithoutSavingConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); frame.current?.discard(); onCloseWithoutSaving(); }}
        />
      )}
    </>
  );
}

function CloseWithoutSavingConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  // Esc = Cancel, through the app's shared Esc stack (same pattern as DiscardConfirmDialog).
  useEscClose(true, onCancel);
  return (
    <Scrim layer={3} onClick={onCancel} className="flex items-center justify-center">
      <OverlayPanel
        layer={3}
        destructive
        role="alertdialog"
        aria-modal
        aria-label="Close without saving"
        className="p-4 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-fg mb-1">Close without saving?</div>
        <div className="text-sm text-fg-2 mb-4">Your changes since the last save will be lost.</div>
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>Close</Button>
        </div>
      </OverlayPanel>
    </Scrim>
  );
}
