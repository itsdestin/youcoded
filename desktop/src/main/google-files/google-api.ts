import type { GoogleAccount, GoogleDriveFile, GoogleEdit } from '../../shared/google-files-types';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE = 'https://www.googleapis.com/drive/v3';
const MAX_RESPONSE = 2 * 1024 * 1024;
export type Json = Record<string, any>;
class SafeGoogleError extends Error {}

/** Only locally defined codes and HTTP status cross the service boundary, never API bodies. */
export class GoogleRequestError extends SafeGoogleError {
  constructor(message: string, readonly code: 'unauthenticated' | 'forbidden' | 'not_found' | 'request_failed' | 'transport', readonly status?: number) { super(message); }
}

/** WHY: neither transport exceptions nor Google's response bodies are safe UI error copy. */
export async function request(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Json> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['www.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com', 'slides.googleapis.com', 'oauth2.googleapis.com'].includes(target.hostname)) throw new SafeGoogleError('Google endpoint not allowed.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      // Do not read error bodies: they can echo tokens, client secrets, or file content.
      await response.body?.cancel();
      if (response.status === 401) throw new GoogleRequestError('Reconnect this Google account to continue.', 'unauthenticated', response.status);
      // WHY: 403 also covers account-wide policy and quota failures, so it is never a stale-file verdict.
      if (response.status === 403 || response.status === 404) throw new GoogleRequestError('Google file access is unavailable. Select the file again.', response.status === 404 ? 'not_found' : 'forbidden', response.status);
      if (response.status === 400 && target.hostname === 'oauth2.googleapis.com') throw new GoogleRequestError('Google sign-in expired or was refused. Reconnect this Google account.', 'unauthenticated', response.status);
      throw new GoogleRequestError('Google could not complete the request. Check the file before trying again.', 'request_failed', response.status);
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) { await response.body?.cancel(); throw new SafeGoogleError('Google file is too large for this operation.'); }
    const reader = response.body?.getReader(); if (!reader) return {};
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new SafeGoogleError('Google file is too large for this operation.'); }
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeGoogleError(); return value; }
    catch { throw new SafeGoogleError('Google returned an invalid response.'); }
  } catch (error) {
    if (error instanceof SafeGoogleError) throw error;
    throw new GoogleRequestError('Google request could not be completed. Check the file before trying again.', 'transport');
  } finally { clearTimeout(timer); }
}

export function validateScope(scope: unknown): void {
  if (typeof scope !== 'string' || scope.trim().split(/\s+/).some(s => s !== DRIVE_SCOPE) || !scope.trim()) throw new SafeGoogleError('Google sign-in must grant only selected-file access. Reconnect this account.');
}
export function fileMetadata(raw: Json, account: GoogleAccount): GoogleDriveFile {
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || typeof raw.mimeType !== 'string' || raw.trashed === true) throw new SafeGoogleError('Google file is unavailable. Select the file again.');
  const kind = raw.mimeType === 'application/vnd.google-apps.document' ? 'Doc' : raw.mimeType === 'application/vnd.google-apps.spreadsheet' ? 'Sheet' : raw.mimeType === 'application/vnd.google-apps.presentation' ? 'Slides' : 'File';
  // WHY: don't expose arbitrary webViewLink URLs supplied by API JSON to the browser.
  return { id: raw.id, accountId: account.id, account: account.email || account.displayName, name: raw.name.slice(0, 1024), kind, mimeType: raw.mimeType,
    webViewLink: `https://drive.google.com/file/d/${encodeURIComponent(raw.id)}/view`, canEdit: raw.capabilities?.canEdit === true, canCopy: raw.capabilities?.canCopy === true };
}
export function metadataUrl(id: string): string {
  return `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed,capabilities(canEdit,canCopy),version`;
}
export function validateEdits(file: GoogleDriveFile, edits: GoogleEdit[]): void {
  if (!Array.isArray(edits) || !edits.length || edits.length > 20 || JSON.stringify(edits).length > 100_000) throw new SafeGoogleError('Google edit is empty or too large.');
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') throw new SafeGoogleError('Invalid Google edit.');
    if ((file.kind === 'Doc' || file.kind === 'Slides') && edit.kind === 'replaceText') {
      if (typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string' || edit.find.length > 10_000 || edit.replace.length > 50_000) throw new SafeGoogleError('Invalid Google text replacement.');
    } else if (file.kind === 'Sheet' && edit.kind === 'writeCells') {
      const match = typeof edit.range === 'string' && /^(?:(?:'(?:[^'\r\n]|''){1,100}'|[A-Za-z_][\w ]{0,99})!)?([A-Z]{1,3})([1-9]\d{0,5})(?::([A-Z]{1,3})([1-9]\d{0,5}))?$/.exec(edit.range);
      if (!match) throw new SafeGoogleError('Use a bounded A1 cell range, such as Sheet1!A1:B2.');
      const col = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      const rows = Number(match[4] ?? match[2]) - Number(match[2]) + 1, cols = col(match[3] ?? match[1]) - col(match[1]) + 1;
      if (rows < 1 || cols < 1 || rows * cols > 10_000 || !Array.isArray(edit.values) || !edit.values.length || edit.values.length > rows || edit.values.some(row => !Array.isArray(row) || !row.length || row.length > cols || row.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)))) throw new SafeGoogleError('Google cell values exceed the bounded range.');
    } else throw new SafeGoogleError('This Google file does not support that edit.');
  }
}

/** Extract plain text without treating document content as instructions; never recurse unbounded. */
export function textContent(value: unknown, depth = 0): string {
  if (depth > 30 || !value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(v => textContent(v, depth + 1)).join('');
  const obj = value as Json;
  if (obj.textRun && typeof obj.textRun.content === 'string') return obj.textRun.content;
  return Object.values(obj).map(v => textContent(v, depth + 1)).join('');
}
