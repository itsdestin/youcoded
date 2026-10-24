export type GoogleFile = {
  id: string;
  name: string;
  kind: 'Doc' | 'Sheet' | 'Slides' | 'File';
  account: string;
  accountId?: string;
  canEdit?: boolean;
  canCopy?: boolean;
  webViewLink?: string;
};

/** Selection is explicit and scoped to this chat; previously chosen files never imply another chat's selection. */
export function toggleGoogleFile(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

/** Saving always targets the exact chosen account/file and defaults to the original. */
export type GoogleSaveTarget = { fileId: string; account: string; mode: 'copy' | 'original' };
export function saveTarget(file: GoogleFile, _selectedAccount: string, asCopy = false): GoogleSaveTarget {
  // WHY: switching the picker account must never redirect a write to another account.
  return { fileId: file.id, account: file.account, mode: asCopy ? 'copy' : 'original' };
}
