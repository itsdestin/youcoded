import React from 'react';
import type { RestoreCategory, RestorePreview as RestorePreviewData } from '../../../shared/types';
import { Scrim, OverlayPanel } from '../overlays/Overlay';

// Pure presentational component — renders the preview/diff summary the
// main-process returned from restore:preview.
//
// Columns vary by mode:
//   merge → Download (remote→local) / Update (overwrite-newer) / Upload (local→remote)
//   wipe  → Add / Overwrite / Delete  (the exact ops the mirror will perform)
//
// Each category name is a dotted-underline button. Tapping opens a confirmation
// modal that asks before opening the category folder on the remote backend
// (Drive, GitHub tree). Per-row size was removed so the table fits phone
// viewports without horizontal overflow — the totals row at the bottom still
// shows aggregate size.

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

export function RestorePreview({ preview, categories, backendId, versionRef }: Props) {
  const rows = preview.perCategory.filter((p) => categories.includes(p.category));
  const isMerge = preview.mode === 'merge';

  // Category whose browse-folder confirmation modal is open. null = no modal.
  const [confirmCategory, setConfirmCategory] = React.useState<RestoreCategory | null>(null);

  const openCategoryFolder = async (c: RestoreCategory) => {
    try {
      // @ts-ignore contextBridge
      const res = await window.claude.sync.restore.browseCategory(backendId, c, versionRef);
      // Desktop main opens via shell.openExternal inside the handler; Android
      // handler fires Intent.ACTION_VIEW. The browser path falls through to
      // window.open below. file: (Android WebView) never reaches window.open.
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
        <div className="text-[11px] text-fg-faint mt-1">
          Tap a category name to open that folder on the backup.
        </div>
      </div>

      <div className="rounded-md border border-edge-dim overflow-hidden">
        <table className="w-full text-[11px] table-fixed">
          <thead className="bg-inset/60">
            <tr className="text-fg-dim align-bottom">
              <th className="text-left px-3 py-2 font-medium">Category</th>
              {/* Count columns are per-file — "files" subtext below each header
                  avoids a phone reader mis-parsing "skills / 124" as "124 skills". */}
              {isMerge ? (
                <>
                  <th className="text-right px-2 py-2 font-medium" title="Files on backup missing locally">
                    <div>Download</div>
                    <div className="text-[9px] text-fg-faint font-normal">files</div>
                  </th>
                  <th className="text-right px-2 py-2 font-medium" title="Files newer on backup">
                    <div>Update</div>
                    <div className="text-[9px] text-fg-faint font-normal">files</div>
                  </th>
                  <th className="text-right px-2 py-2 font-medium" title="Files only local — will be uploaded">
                    <div>Upload</div>
                    <div className="text-[9px] text-fg-faint font-normal">files</div>
                  </th>
                </>
              ) : (
                <>
                  <th className="text-right px-2 py-2 font-medium">
                    <div>Add</div>
                    <div className="text-[9px] text-fg-faint font-normal">files</div>
                  </th>
                  <th className="text-right px-2 py-2 font-medium">
                    <div>Overwrite</div>
                    <div className="text-[9px] text-fg-faint font-normal">files</div>
                  </th>
                  <th className="text-right px-2 py-2 font-medium text-red-400">
                    <div>Delete</div>
                    <div className="text-[9px] text-fg-faint font-normal">files</div>
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category} className="border-t border-edge-dim">
                {/* Category name is a text button with a dotted underline —
                    the previous folder-icon-in-a-6th-column approach was
                    clipped on narrow phones AND hard to recognize as tappable. */}
                <td className="px-3 py-2 text-fg capitalize">
                  <button
                    type="button"
                    onClick={() => setConfirmCategory(r.category)}
                    className="text-left border-b border-dotted border-fg-faint hover:border-fg-dim hover:text-fg-2 transition-colors cursor-pointer bg-transparent p-0 font-inherit"
                    title={`Open the ${r.category} folder in Google Drive`}
                  >
                    {r.category}
                  </button>
                </td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toAdd}</td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toOverwrite}</td>
                {isMerge ? (
                  <td className="px-2 py-2 text-right text-fg-dim">{r.toUpload ?? 0}</td>
                ) : (
                  <td className={`px-2 py-2 text-right ${r.toDelete > 0 ? 'text-red-400' : 'text-fg-dim'}`}>
                    {r.toDelete}
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-fg-muted">
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

      {confirmCategory && (
        <>
          <Scrim layer={2} onClick={() => setConfirmCategory(null)} />
          <OverlayPanel
            layer={2}
            role="dialog"
            aria-modal
            aria-labelledby="browse-category-title"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-xl p-5"
          >
            <h2 id="browse-category-title" className="text-sm font-semibold text-fg mb-2">
              Open in Google Drive?
            </h2>
            <p className="text-[12px] text-fg-muted mb-4">
              This will open the <span className="capitalize font-medium text-fg-2">{confirmCategory}</span> folder on the backup so you can see exactly what's there. The backup itself won't change.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmCategory(null)}
                className="px-3 py-1.5 rounded-md text-[12px] text-fg-dim hover:text-fg bg-inset hover:bg-inset/80 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const c = confirmCategory;
                  setConfirmCategory(null);
                  void openCategoryFolder(c);
                }}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-accent text-on-accent hover:brightness-110 transition-colors"
              >
                Open in Drive
              </button>
            </div>
          </OverlayPanel>
        </>
      )}
    </div>
  );
}
