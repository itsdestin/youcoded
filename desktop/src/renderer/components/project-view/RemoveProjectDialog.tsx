// "Remove project" — the confirm the project switcher's bin (and the hero's Remove) opens.
//
// WHY its own popup on the shared Dialog (redesign backlog row 10): the old confirm was a
// hand-built panel with its own heading, a ✕-less header and buttons side by side with the red
// one on the RIGHT of a narrow panel. Guide "Popups": every popup is the shared Dialog (title,
// ✕, Esc); guide "Buttons": in a narrow popup two buttons stack full width with the main one on
// top, and a destructive confirm's red button takes that place.
//
// What removing does — and never does — is said in words on the popup, because the three kinds
// of project are removed differently (folders-service.ts):
//  - a plain folder leaves the saved-folders list;
//  - a synced project (its folder lives in ~/YouCoded/Projects) goes on this computer's
//    "removed" list — its folder, files and sync are untouched, other devices still list it;
//  - a project whose folder is gone just leaves the list.
// Nothing here deletes a folder or a user's file. The one opt-in deletion is YouCoded's own
// file-history record inside the project (.youcoded/artifacts.json), as before.
import React, { useState } from 'react';
import { Button, ConsentRow, Dialog } from '../ui';

type RemoveKind = 'folder' | 'synced' | 'missing';

export function RemoveProjectDialog({ name, kind, keepsSyncing, onConfirm, onCancel }: {
  /** What the switcher shows (a synced project's display name). */
  name: string;
  kind: RemoveKind;
  /** A synced project that is actively syncing — the popup says it keeps doing so. */
  keepsSyncing: boolean;
  onConfirm: (alsoDeleteHistory: boolean) => void;
  onCancel: () => void;
}) {
  const [alsoDeleteHistory, setAlsoDeleteHistory] = useState(false);
  // One screen name per kind so each wording can be photographed (dev/workbench/screens).
  const screen = kind === 'folder' ? 'projects/remove' : `projects/remove/${kind}`;
  return (
    <Dialog open onClose={onCancel} layer={3} destructive size="prompt" title="Remove project" screen={screen}>
      {kind === 'missing' ? (
        <p className="text-xs text-fg-2 leading-relaxed">
          YouCoded can't find this folder any more — it was moved or deleted outside the app.
          Removing only takes “<span className="font-medium text-fg">{name}</span>” off your list.
        </p>
      ) : (
        <div className="space-y-2 text-xs text-fg-2 leading-relaxed">
          <p>
            “<span className="font-medium text-fg">{name}</span>” leaves {kind === 'synced' ? "this computer's" : 'your'} project
            list and the folder list for new conversations.
          </p>
          <p>
            {kind === 'synced'
              ? `Its folder stays in YouCoded › Projects with every file in it${keepsSyncing ? ', and it keeps syncing between your devices' : ''}. Your other devices still list it.`
              : 'The folder and its files stay where they are.'}
            {' '}Add it back any time with Add a project.
          </p>
        </div>
      )}
      {kind !== 'missing' && (
        // Guide "Settings": a tick before an action is the whole-line tappable box.
        <ConsentRow checked={alsoDeleteHistory} onChange={setAlsoDeleteHistory}>
          Also delete YouCoded's file history for this project
          <span className="block text-3xs text-fg-muted">Which files the assistant made or changed here. Your files stay.</span>
        </ConsentRow>
      )}
      <div className="flex flex-col gap-2" data-parts-agree="remove-project-buttons">
        <Button variant="danger" size="md" className="w-full" onClick={() => onConfirm(kind !== 'missing' && alsoDeleteHistory)}>
          Remove
        </Button>
        <Button variant="secondary" size="md" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
