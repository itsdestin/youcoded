// Settings → Backup & sync → "Removed projects": synced projects removed from every device's
// lists, each with a link to its GitHub backup, and how to delete that backup there.
//
// WHY (Destin, project-switcher-1 PQ-1: "separate setting that explains the github backup
// remains in place, with an outlink and instructions for users to delete themselves on github
// if they desire"): removing a synced project from the project switcher stops syncing and
// takes it off every list, but its GitHub copy is never deleted. Once it is off every list,
// this is where that copy can be found again. Shown only when there is one. A label and one
// card (guide "Spacing"); the names are plain rows in one nested box (guide "Card levels":
// lists of short names). Its own file so Backup & sync stays inside its line budget.
import React from 'react';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, SectionLabel } from './ui';
import { GithubBackupNote } from './GithubBackupNote';
import type { SyncStatusData } from './sync-dot-state';

export function RemovedProjectsCard({ removed }: { removed: SyncStatusData['removed'] }) {
  if (!removed?.length) return null;
  return (
    <div>
      <SectionLabel className="mb-2">Removed projects</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-3 space-y-2`}>
        <p className="text-2xs text-fg-muted leading-relaxed">
          These no longer sync and are off your project lists. Every device kept its copy of the files.
        </p>
        <div className={`${CARD_LEVEL_2} px-3 py-1`}>
          {removed.map((r) => (
            <div key={r.name} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-xs text-fg truncate">{r.displayName}</span>
              {r.githubUrl && (
                <Button variant="secondary" size="sm" onClick={() => void window.claude.shell.openExternal(r.githubUrl!)}>
                  Open on GitHub
                </Button>
              )}
            </div>
          ))}
        </div>
        <GithubBackupNote url={null} />
      </div>
    </div>
  );
}
