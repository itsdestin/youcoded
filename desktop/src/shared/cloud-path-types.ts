/** Read intent defaults to preview at every backend boundary. Consent is an
 * expiring server-issued capability for one operation, never a folder grant. */
export interface CloudReadOptions {
  intent?: 'preview' | 'explicit';
  operationToken?: string;
}
export interface NeedsDownload {
  ok: false;
  error: 'needs-download';
  path: string;
  name: string;
  sizeBytes: number;
  operationToken?: string;
}
