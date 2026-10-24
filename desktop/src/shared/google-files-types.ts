export interface GoogleAccount { id: string; email: string; displayName: string }
export interface GoogleDriveFile {
  id: string; accountId: string; account: string; name: string;
  kind: 'Doc' | 'Sheet' | 'Slides' | 'File'; mimeType: string; webViewLink: string;
  canEdit: boolean; canCopy: boolean;
}
export interface GoogleFilesStatus { configured: boolean; accounts: GoogleAccount[] }
export type GoogleAuthState = { state: 'pending' } | { state: 'complete'; account: GoogleAccount; files: GoogleDriveFile[] } | { state: 'error'; error: string };
export type GoogleEdit = { kind: 'replaceText'; find: string; replace: string } | { kind: 'writeCells'; range: string; values: (string | number | boolean | null)[][] };
export interface GoogleProposal { id: string; sessionId: string; file: GoogleDriveFile; summary: string; edits: GoogleEdit[]; mode: 'original' | 'copy'; createdAt: number; create?: { kind: 'Doc' | 'Sheet' | 'Slides'; name: string; content: string } }
export interface GoogleReadResult { file: GoogleDriveFile; content: string; revision?: string }
