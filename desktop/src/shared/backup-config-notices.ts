// The words (and shape) of the three notices about the saved backup settings (backup fixes 2026-11-18, B-2).
// WHY shared: the app's main process writes them into the warning list, and the practice workbench draws the same
// ones for pictures; one definition keeps the pictures honest about the real wording.
//
// Wording follows docs/error-message-standards.md: nothing claims a cause we did not verify. "Couldn't be read" is
// exactly what was observed; nothing here says why.
export type ConfigNoticeKind = 'restored' | 'salvaged' | 'damaged' | 'write-failed';

export interface ConfigNotice {
  code: 'CONFIG_RESTORED' | 'CONFIG_SALVAGED' | 'CONFIG_DAMAGED' | 'CONFIG_WRITE_FAILED';
  level: 'danger' | 'warn';
  title: string;
  body: string;
  dismissible: boolean;
  fixAction?: { label: string; kind: 'start-fresh' | 'recheck-settings' };
}

export function configNotice(kind: ConfigNoticeKind, backups = 0): ConfigNotice {
  if (kind === 'restored') {
    return {
      code: 'CONFIG_RESTORED', level: 'warn', dismissible: true,
      title: 'Backup settings restored',
      body: 'Your backup settings file was damaged, so YouCoded brought back the last copy it had saved. The damaged file was kept next to it in case you need it.',
    };
  }
  if (kind === 'salvaged') {
    // WHY "no earlier copy was readable", not "was saved": the copy may exist and be unreadable too — only what was observed is claimed.
    return {
      code: 'CONFIG_SALVAGED', level: 'warn', dismissible: true,
      title: 'Please check your backups',
      body: backups === 0
        ? 'Your backup settings file was damaged and no earlier copy could be read. YouCoded could not read any of your backups from it, so please add them again. The damaged file was kept.'
        : `Your backup settings file was damaged and no earlier copy could be read. YouCoded kept the ${backups === 1 ? '1 backup' : `${backups} backups`} it could still read. Please check the list is complete and add any that are missing. The damaged file was kept.`,
    };
  }
  if (kind === 'write-failed') {
    // The repair itself could not be SAVED. Nothing says the file is unreadable, and nothing claims why saving failed.
    return {
      code: 'CONFIG_WRITE_FAILED', level: 'danger', dismissible: false,
      title: "Backup settings couldn't be saved",
      body: "Your backup settings needed repairing, but YouCoded couldn't save the repair. Nothing was changed. You can try again.",
      fixAction: { label: 'Try again', kind: 'recheck-settings' },
    };
  }
  // Damaged and nothing could be restored or read: states only what was observed, and what Start fresh does.
  return {
    code: 'CONFIG_DAMAGED', level: 'danger', dismissible: false,
    title: "Backup settings couldn't be read",
    body: "YouCoded couldn't read your saved backup settings and found no earlier copy to bring back. Nothing was changed. Start fresh puts the file aside (it is kept, not deleted) so you can set up your backups again.",
    fixAction: { label: 'Start fresh', kind: 'start-fresh' },
  };
}
