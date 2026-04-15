import React from 'react';
import type { RestoreCategory, RestorePreview as RestorePreviewData } from '../../../shared/types';

// Pure presentational component — renders the preview/diff summary the
// main-process returned from restore:preview.
//
// Columns vary by mode:
//   merge → Download (remote→local) / Update (overwrite-newer) / Upload (local→remote)
//   wipe  → Add / Overwrite / Delete  (the exact ops the mirror will perform)
//
// Each row has a folder icon that resolves the category's remote browse URL
// via the main process and opens it (Drive folder, GitHub tree, file:// for iCloud).

type Props = {
  preview: RestorePreviewData;
  categories: RestoreCategory[];
  backendId: string;
  versionRef: string;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// SVG folder icon — small, theme-tokened. Clicking opens the browse URL via IPC.
function FolderLink({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="w-5 h-5 rounded-sm flex items-center justify-center text-fg-muted hover:text-fg-2 hover:bg-inset transition-colors"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}

export function RestorePreview({ preview, categories, backendId, versionRef }: Props) {
  const rows = preview.perCategory.filter((p) => categories.includes(p.category));
  const isMerge = preview.mode === 'merge';

  const openCategoryFolder = async (c: RestoreCategory) => {
    try {
      // @ts-ignore contextBridge
      const res = await window.claude.sync.restore.browseCategory(backendId, c, versionRef);
      // Desktop main opens via shell.openExternal inside the handler; browser
      // gets the URL back and opens it here (new tab).
      if (res?.url && typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
        window.open(res.url, '_blank', 'noopener');
      }
    } catch {
      // Non-fatal — adapter may not support browse URLs (older backends).
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-fg">Preview changes</div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          {isMerge
            ? 'Merge will sync files both directions. Nothing gets deleted on either side.'
            : 'Wipe & restore will replace local files with the backup. Review each category.'}
        </div>
      </div>

      <div className="rounded-md border border-edge-dim overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="bg-inset/60">
            <tr className="text-fg-dim">
              <th className="text-left px-3 py-2 font-medium">Category</th>
              {isMerge ? (
                <>
                  <th className="text-right px-2 py-2 font-medium" title="Files on backup missing locally">Download</th>
                  <th className="text-right px-2 py-2 font-medium" title="Files newer on backup">Update</th>
                  <th className="text-right px-2 py-2 font-medium" title="Files only local — will be uploaded">Upload</th>
                </>
              ) : (
                <>
                  <th className="text-right px-2 py-2 font-medium">Add</th>
                  <th className="text-right px-2 py-2 font-medium">Overwrite</th>
                  <th className="text-right px-2 py-2 font-medium text-red-400">Delete</th>
                </>
              )}
              <th className="text-right px-3 py-2 font-medium">Size</th>
              <th className="w-8 px-1 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category} className="border-t border-edge-dim">
                <td className="px-3 py-2 text-fg capitalize">{r.category}</td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toAdd}</td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toOverwrite}</td>
                {isMerge ? (
                  <td className="px-2 py-2 text-right text-fg-dim">{r.toUpload ?? 0}</td>
                ) : (
                  <td className={`px-2 py-2 text-right ${r.toDelete > 0 ? 'text-red-400' : 'text-fg-dim'}`}>
                    {r.toDelete}
                  </td>
                )}
                <td className="px-3 py-2 text-right text-fg-dim">{formatBytes(r.bytes)}</td>
                <td className="px-1 py-2">
                  <FolderLink
                    onClick={() => openCategoryFolder(r.category)}
                    title={`Browse ${r.category} on backup`}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-fg-muted">
                  No categories selected.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between text-[11px] text-fg-dim px-1">
        <span>Total: {formatBytes(preview.totalBytes)}</span>
        <span>Estimated: ~{Math.max(1, Math.round(preview.estimatedSeconds))}s</span>
      </div>

      {preview.warnings.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-1">
          {preview.warnings.map((w, i) => (
            <div
              key={i}
              className={`text-[11px] px-3 py-2 rounded-md border ${
                w.includes('DELETE')
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              }`}
            >
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
