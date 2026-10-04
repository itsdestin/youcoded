// Edits kept from last time for a file that changed outside Office since (finish plan Task 8 fix
// round 1). WHY a choice, not an automatic replay: the edits were made to the file as it was, and
// replaying them would overwrite whatever changed it since. The document opens as it is on disk;
// Recover reopens it with the kept edits (the file as it is stays in Versions), Discard drops them.
// Used by the Office page's tab strip and the in-place editor's bar, like OfficeSaveFailed.
import React, { useState, type RefObject } from 'react';
import { Button } from '../ui';
import type { EditorFrameHandle } from './EditorFrame';
import { useRecoverOffer } from './office-store';

export function OfficeRecoverOffer({ path, frame, className = '' }: {
  path: string;
  frame: RefObject<EditorFrameHandle | null> | { current: EditorFrameHandle | null | undefined };
  className?: string;
}) {
  const offered = useRecoverOffer(path);
  const [busy, setBusy] = useState(false);
  if (!offered) return null;
  const answer = (recover: boolean) => {
    setBusy(true);
    void frame.current?.answerRecoverOffer(recover).finally(() => setBusy(false));
  };
  return (
    <div className={`flex items-center gap-2 ${className}`.trim()} role="status">
      <span className="text-2xs text-fg-2 min-w-0">Unsaved changes from last time were kept, but this file has changed since.</span>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => answer(true)}>Recover unsaved changes</Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => answer(false)}>Discard</Button>
    </div>
  );
}
