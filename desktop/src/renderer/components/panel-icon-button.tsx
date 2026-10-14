// The small square icon buttons of a side panel's header (Session Files, the
// Browser): one look for every panel's header. Moved out of SessionDrawer.tsx
// (2026-10-13) when the Browser panel took the same buttons.
import React from 'react';
import { Tooltip } from './ui';

// Lucide-style paths, drawn in currentColor.
const PANEL_ICON_PATHS: Record<string, string> = {
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  // Clipboard + slash — "Copy path" (approved mockup 13; the old chain link
  // read as "hyperlink", not "copy the file path").
  copypath: 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M10.5 16 13.5 10.5',
  // Folder — "Reveal in folder".
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  // External-link (box + arrow-out) — "Open externally" (OS default app).
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  // Tray + arrow-down — "Download" (remote access batch 3, 2026-09-10): the
  // phone's stand-in for Open externally / Reveal, which have no meaning there.
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  // Four standalone corner arrows (approved mockup 12, stems shortened) —
  // the old bare brackets did not read as expand/contract.
  expand: 'M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15M5 5l4.2 4.2M19 5l-4.2 4.2M5 19l4.2-4.2M19 19l-4.2-4.2',
  shrink: 'M9.5 5v4.5H5M14.5 5v4.5H19M9.5 19v-4.5H5M14.5 19v-4.5H19M9.1 9.1 4.9 4.9M14.9 9.1 19.1 4.9M9.1 14.9 4.9 19.1M14.9 14.9 19.1 19.1',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  // Square-pen — distinct from the filename rename pencil; this edits contents.
  editdoc: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  forward: 'M5 12h14M13 6l6 6-6 6',
  // Chain link — "Copy link" (the Browser panel: an address, not a file path).
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  // "New tab" (the Browser panel's tab strip).
  plus: 'M12 5v14M5 12h14',
};
export function PanelIcon({ name, size = 15 }: { name: keyof typeof PANEL_ICON_PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {PANEL_ICON_PATHS[name].split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

export function PanelIconButton({ name, title, onClick, active, glyph }: { name?: string; title: string; onClick: () => void; active?: boolean; glyph?: React.ReactNode }) {
  return (
    <Tooltip text={title}>
    <button
      type="button"
      onClick={onClick}
      className={`w-7 h-7 rounded-md inline-flex items-center justify-center shrink-0 border transition-colors ${
        active ? 'text-fg bg-well border-edge' : 'text-fg-dim border-transparent hover:text-fg hover:bg-well hover:border-edge'
      }`}
    >
      {glyph ?? <PanelIcon name={name!} />}
    </button>
    </Tooltip>
  );
}
