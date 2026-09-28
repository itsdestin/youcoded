import React from 'react';
import { isAndroid } from '../platform';
import { Tooltip } from './ui';

// Pencil SVG icon — matches the one used in StatusBar.tsx
export function PencilIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

/** The small square pencil button the quick-chips row uses to open its editor.
 *  WHY shared (Destin, 2026-09-28 Send now review: "re-use the edit element
 *  used for the status bar, quick chips menu"): one component, so the waiting-
 *  message strip's Edit and the quick chips' edit cannot drift apart.
 *  `className` adds hooks only (QuickChips passes `quick-chip-edit`, which float
 *  chrome uses to give it the chips' own surface); the look lives here. */
export function EditPencilButton({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  const android = isAndroid();
  return (
    <Tooltip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`${className} shrink-0 ${android ? 'w-8 h-8' : 'w-6 h-6'} rounded-md bg-well border border-edge-dim text-fg-muted hover:bg-inset hover:text-fg transition-colors flex items-center justify-center`}
      >
        <PencilIcon size={android ? 12 : 10} />
      </button>
    </Tooltip>
  );
}
