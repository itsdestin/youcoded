// The note that a removed synced project's GitHub backup is left in place — with a link to
// it and how to delete it there yourself.
//
// WHY (Destin, project-switcher-1 PQ-1: "separate setting that explains the github backup
// remains in place, with an outlink and instructions for users to delete themselves on github
// if they desire"): removing a synced project stops syncing and takes it off every device's
// lists, but the app never deletes anything on GitHub. Said on the Remove confirm and again in
// Settings → Backup & sync → Removed projects, where it can be found later. One component so
// the two places can never word it differently. Guide "Status and notices": one tinted notice
// box, its button inside at the right.
import React from 'react';
import { Button, Callout } from './ui';

export function GithubBackupNote({ url }: { url: string | null }) {
  return (
    <Callout
      tone="info"
      title="Your GitHub backup stays"
      actions={url ? (
        <Button variant="secondary" size="sm" onClick={() => void window.claude.shell.openExternal(url)}>
          Open on GitHub
        </Button>
      ) : undefined}
    >
      YouCoded never deletes it. To delete it yourself, open it on GitHub, go to Settings, and
      choose Delete this repository at the bottom of the page.
    </Callout>
  );
}
