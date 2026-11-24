// The words (and shape) of the three notices about the saved backup settings (backup fixes 2026-11-18, B-2).
// WHY shared: the app's main process writes them into the warning list, and the practice workbench draws the same
// ones for pictures; one definition keeps the pictures honest about the real wording.
//
// Wording follows docs/error-message-standards.md: nothing claims a cause we did not verify. "Couldn't be read" is
// exactly what was observed; nothing here says why.
export type ConfigNoticeKind = 'restored' | 'salvaged' | 'damaged';

export interface ConfigNotice {
  code: 'CONFIG_RESTORED' | 'CONFIG_SALVAGED' | 'CONFIG_DAMAGED';
  level: 'danger' | 'warn';
  title: string;
  body: string;
  dismissible: boolean;
  fixAction?: { label: string; kind: 'start-fresh' };
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
    return {
      code: 'CONFIG_SALVAGED', level: 'warn', dismissible: true,
      title: 'Please check your backups',
      body: `Your backup settings file was damaged and no earlier copy was saved. YouCoded kept the ${backups === 1 ? '1 backup' : `${backups} backups`} it could still read. Please check the list is complete and add any that are missing. The damaged file was kept.`,
    };
  }
  return {
    code: 'CONFIG_DAMAGED', level: 'danger', dismissible: false,
    title: "Backup settings couldn't be read",
    body: 'Nothing was changed, so nothing was lost. Start fresh sets the unreadable file aside (it is kept, not deleted) so you can set up your backups again.',
    fixAction: { label: 'Start fresh', kind: 'start-fresh' },
  };
}
