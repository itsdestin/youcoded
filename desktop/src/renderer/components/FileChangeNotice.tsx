// The one-time backup notice on the first card where the assistant creates or
// changes a file — one of the three candidate homes for the warning removed
// from setup (backlog row 18, deck backup-warning-1; see backup-note-practice.ts).
//
// WHY on the card, whatever its state: in Ask first the card is the permission
// ask itself; in Auto edit (a native session's default) the change happens with
// no ask at all, and the card is the only place it ever shows. Either way this
// is the first moment the warning is about something real on screen.
//
// Guide: "a notice about one thing sits inside that thing, its buttons inside
// the notice at the right" (Status and notices) — so the info notice box sits
// inside the card, under its header, with Got it at its right.
import React, { useEffect, useSyncExternalStore } from 'react';
import { Button, Callout } from './ui';
import {
  BACKUP_NOTE_TEXT,
  acknowledgeFileChangeNotice,
  claimFileChangeNotice,
  fileChangeNoticeOwner,
  releaseFileChangeNotice,
  subscribeFileChangeNotice,
} from './backup-note-practice';

export function FileChangeNotice({ id, live }: { id: string; live: boolean }) {
  // WHY only a LIVE card claims (waiting for a Yes, or running): a card from an
  // old conversation — or one in a tab kept open behind this one — is not "the
  // first time the assistant changes a file", and claiming there hid the notice
  // in a tab nobody was looking at (first photo round). Once claimed, the card
  // keeps it after the change finishes, until Got it.
  useEffect(() => {
    if (live) claimFileChangeNotice(id);
  }, [id, live]);
  useEffect(() => () => releaseFileChangeNotice(id), [id]);
  // A boolean snapshot, so only the claiming card redraws on a claim or Got it.
  const mine = useSyncExternalStore(subscribeFileChangeNotice, () => fileChangeNoticeOwner() === id, () => false);
  if (!mine) return null;
  return (
    <div className="px-3 pb-2" data-testid="file-change-notice">
      <Callout
        tone="info"
        // WHY outlined, beside the words: the card's own answer (Yes / No) is
        // the main action here; a filled Got it would compete with it (guide:
        // one filled button per view; text and buttons on one line when they fit).
        actions={<Button size="sm" variant="secondary" onClick={acknowledgeFileChangeNotice}>Got it</Button>}
      >
        {BACKUP_NOTE_TEXT}
      </Callout>
    </div>
  );
}
