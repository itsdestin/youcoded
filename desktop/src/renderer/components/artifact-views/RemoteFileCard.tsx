import React from 'react';
import { Button } from '../ui';
import { formatFileSize, REMOTE_TEXT_PREVIEW_MAX_BYTES, REMOTE_BINARY_PREVIEW_MAX_BYTES } from '../../../shared/remote-file-limits';

// The card a PHONE shows for a file it will not preview (questions deck
// 2026-09-10, Q-8 "Name, size, Download"). Over remote access a file over the
// phone's preview ceiling (remote-file-limits.ts) is answered `too-large` with
// its real size instead of a prefix — so the person learns what the file is and
// how big, then decides. Download (Q-7) hands the whole file to the phone's
// own downloads folder; the transfer does not block the chat.
//
// Rendered by both hosts of a file preview — ActiveArtifactView for text and
// BinaryContent for images/PDFs/documents — so the two cannot drift apart.

/** "PDF", "Image", "Text", "File" — the kind a phone user would call it. */
function describeKind(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'PDF';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'Image';
  if (['docx', 'doc'].includes(ext)) return 'Document';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'Spreadsheet';
  if (['md', 'txt', 'log', 'json', 'yaml', 'yml', 'html', 'ts', 'tsx', 'js', 'py', 'kt'].includes(ext)) return 'Text';
  return 'File';
}

export function RemoteFileCard({ path, sizeBytes, reason }: {
  /** Absolute path of the file — what Download asks the host for. */
  path: string;
  sizeBytes?: number;
  /** Why there is no preview. `too-large` is the only reason today. */
  reason: 'too-large';
}) {
  const name = path.split('/').pop() ?? path;
  const kind = describeKind(path);
  const limit = kind === 'Text'
    ? formatFileSize(REMOTE_TEXT_PREVIEW_MAX_BYTES)
    : formatFileSize(REMOTE_BINARY_PREVIEW_MAX_BYTES);
  const download = () => { void (window.claude as any).artifacts?.download?.(path); };
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-xs rounded-lg bg-inset px-4 py-5 flex flex-col items-center text-center gap-1.5">
        <div className="text-sm font-medium text-fg break-all">{name}</div>
        <div className="text-xs text-fg-2">
          {typeof sizeBytes === 'number' ? `${formatFileSize(sizeBytes)} · ${kind}` : kind}
        </div>
        {reason === 'too-large' && (
          <p className="text-xs text-fg-muted mt-1">
            Too large to preview on a phone. Previews stop at {limit} for {kind === 'Text' ? 'text' : 'this kind of file'}.
          </p>
        )}
        <div className="mt-3">
          <Button variant="primary" size="sm" onClick={download}>Download</Button>
        </div>
      </div>
    </div>
  );
}
