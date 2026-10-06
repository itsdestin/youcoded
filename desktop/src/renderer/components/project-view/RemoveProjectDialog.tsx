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
//  - a synced project (its folder lives in ~/YouCoded/Projects) stops syncing and leaves every
//    device's lists (sync-spaces service `syncSpacesRemoveProject`); every device keeps its
//    copy of the files and the GitHub backup is left alone (GithubBackupNote says so);
//  - a project whose folder is gone just leaves the list.
// Nothing here deletes a folder or a user's file. The one opt-in deletion is YouCoded's own
// file-history record inside the project (.youcoded/artifacts.json), as before.
import React, { useState } from 'react';
import { Button, ConsentRow, Dialog, FieldError } from '../ui';
import { GithubBackupNote } from '../GithubBackupNote';

type RemoveKind = 'folder' | 'synced' | 'missing';

export function RemoveProjectDialog({ name, kind, githubUrl, error, onConfirm, onCancel }: {
  /** What the switcher shows (a synced project's display name). */
  name: string;
  kind: RemoveKind;
  /** A synced project's GitHub page, when this device knows it (its sync remote). */
  githubUrl?: string | null;
  /** Why the last try failed, in the service's own words (never a guessed cause). */
  error?: string | null;
  onConfirm: (alsoDeleteHistory: boolean) => void;
  onCancel: () => void;
}) {
  const [alsoDeleteHistory, setAlsoDeleteHistory] = useState(false);
  // One screen name per kind so each wording can be photographed (dev/workbench/screens).
  const screen = kind === 'folder' ? 'projects/remove' : `projects/remove/${kind}`;
  return (
    // WHY `panel` for a synced project: its confirm also carries the GitHub note, and at
    // `prompt` height its buttons scrolled out of view (round 2 pictures).
    <Dialog open onClose={onCancel} layer={3} destructive size={kind === 'synced' ? 'panel' : 'prompt'} title="Remove project" screen={screen}>
      {kind === 'missing' && (
        <p className="text-xs text-fg-2 leading-relaxed">
          YouCoded can't find this folder any more — it was moved or deleted outside the app.
          Removing only takes “<span className="font-medium text-fg">{name}</span>” off your list.
        </p>
      )}
      {kind === 'folder' && (
        <div className="space-y-2 text-xs text-fg-2 leading-relaxed">
          <p>
            “<span className="font-medium text-fg">{name}</span>” leaves your project list and the
            folder list for new conversations.
          </p>
          <p>The folder and its files stay where they are. Add it back any time with Add a project.</p>
        </div>
      )}
      {kind === 'synced' && (
        // Destin, project-switcher-1 PQ-1 ("stop syncing on all devices, remove from list on all
        // devices"): said plainly, including what does NOT happen — no device loses its files.
        <div className="space-y-2 text-xs text-fg-2 leading-relaxed">
          <p>
            “<span className="font-medium text-fg">{name}</span>” stops syncing and leaves your
            project lists on all your devices.
          </p>
          <p>
            Every device keeps its copy of the folder and its files in YouCoded › Projects.
            Syncing can't be turned back on for it; Add a project lists it on one computer again.
          </p>
        </div>
      )}
      {kind === 'synced' && <GithubBackupNote url={githubUrl ?? null} />}
      {kind !== 'missing' && (
        // Guide "Settings": a tick before an action is the whole-line tappable box.
        <ConsentRow checked={alsoDeleteHistory} onChange={setAlsoDeleteHistory}>
          Also delete YouCoded's file history for this project
          <span className="block text-3xs text-fg-muted">Which files the assistant made or changed here. Your files stay.</span>
        </ConsentRow>
      )}
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-col gap-2" data-parts-agree="remove-project-buttons">
        <Button variant="danger" size="md" className="w-full" onClick={() => onConfirm(kind !== 'missing' && alsoDeleteHistory)}>
          {kind === 'synced' ? 'Remove from all devices' : 'Remove'}
        </Button>
        <Button variant="secondary" size="md" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
