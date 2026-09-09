import React from 'react';

// Icon set for the chat context menu. Same visual language as the app's other
// inline icons (24×24 viewBox, stroke: currentColor, stroke-width 2, round
// caps/joins) so they inherit theme color from the menu row. The sparkle for
// "Ask about this" was Destin's pick (2026-07-17 icon review).

export type MenuIconName =
  | 'rename'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'select-all'
  | 'ask'
  | 'code'
  | 'open'
  | 'link'
  | 'folder'
  | 'path';

const PATHS: Record<MenuIconName, React.ReactNode> = {
  // WHY: renaming needs its own pencil, not the unrelated move-window icon.
  rename: <path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5M4 15l5 5" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M20 4 8.5 15.5M14.5 14.5 20 20M8 8l4 4" />
    </>
  ),
  paste: (
    <>
      <rect x="8" y="4" width="8" height="4" rx="1" />
      <path d="M16 6h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
    </>
  ),
  'select-all': (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>
  ),
  ask: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M18.5 14.5l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z" />
    </>
  ),
  code: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12" />,
  open: <path d="M14 4h6v6M20 4l-9 9M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />,
  link: (
    <>
      <path d="M9 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M15 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  path: (
    <>
      <path d="M9 5h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2" />
      <path d="M4 15l3-3-3-3" />
      <path d="M12 9h4M12 13h4" />
    </>
  ),
};

export function MenuIcon({ name }: { name: MenuIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
