import React from 'react';
import type { RestoreCategory, RestorePreview as RestorePreviewData } from '../../../shared/types';

// Pure presentational component — renders the preview/diff summary the
// main-process returned from restore:preview. Shows per-category adds,
// overwrites, deletes, plus warnings in an amber accent so destructive
// implications are visible before the user confirms.

type Props = {
  preview: RestorePreviewData;
  categories: RestoreCategory[];
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function RestorePreview({ preview, categories }: Props) {
  const rows = preview.perCategory.filter((p) => categories.includes(p.category));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-fg">Preview changes</div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          Restore will copy the backup over your device. Review what will change.
        </div>
      </div>

      <div className="rounded-md border border-edge-dim overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="bg-inset/60">
            <tr className="text-fg-dim">
              <th className="text-left px-3 py-2 font-medium">Category</th>
              <th className="text-right px-2 py-2 font-medium">Add</th>
              <th className="text-right px-2 py-2 font-medium">Overwrite</th>
              <th className="text-right px-2 py-2 font-medium">Delete</th>
              <th className="text-right px-3 py-2 font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category} className="border-t border-edge-dim">
                <td className="px-3 py-2 text-fg capitalize">{r.category}</td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toAdd}</td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toOverwrite}</td>
                <td className="px-2 py-2 text-right text-fg-dim">{r.toDelete}</td>
                <td className="px-3 py-2 text-right text-fg-dim">{formatBytes(r.bytes)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-fg-muted">
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
              className="text-[11px] px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300"
            >
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
