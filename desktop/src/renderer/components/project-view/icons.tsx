// Shared lucide-style glyphs for the Project View surfaces (stroke currentColor,
// consistent with detail-tool-icons.tsx which holds the detail-overlay action
// icons). These were previously re-declared per file — ProjectView, ProjectHero,
// ProjectSwitcher, the tabs, and the context popups each carried their own copy
// of the same paths. One module keeps the glyph language in lockstep.

import type { FileKind } from '../../../shared/artifacts/categorization';

interface IconProps { size?: number; strokeWidth?: number }

function base(size: number, strokeWidth: number) {
  return {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
}

export function SearchIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}

// 2026-08-06: CheckCircleIcon/AlertTriangleIcon/CircleSlashIcon/MonitorIcon
// (the sync-pill per-state glyphs from the 2026-08-05 mockup) were removed
// here — the pill reverted to the plain colored dot (sync-spaces.md pins the
// dot as the one sanctioned status-color use; ProjectSwitcher rows already
// use it, and two visual languages for one status was the wrong call).

export function GitBranchIcon({ size = 13, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M6 9v6" />
      <path d="M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function InfoIcon({ size = 14, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function ChatIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function DocIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    </svg>
  );
}

// Folder shape shared by the All-files segment icon (strokeWidth 2) and the
// large folder-card glyph in FilesTab (strokeWidth 1.5 at 40px).
export function FolderIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

// Type glyphs for the folder-card filename list (image / spreadsheet / code;
// documents use DocIcon above). One per fileTypeGroup.
export function ImageIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

export function SheetIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" /><path d="M3 15h18" /><path d="M12 3v18" />
    </svg>
  );
}

export function CodeGlyphIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" />
    </svg>
  );
}

export function CheckIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function PlusIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M5 12h14" /><path d="M12 5v14" />
    </svg>
  );
}

/** GitHub octocat mark — same path as the local copies in AccountSection.tsx /
 *  ConnectedAccounts.tsx / SignInPromptModal.tsx, added here (fill, not stroke,
 *  hence no `base()`) for ProjectHero's inline repo link. */
export function GitHubIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Gear — the project hero's action menu trigger. */
export function CogIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

// ── File-kind glyphs ─────────────────────────────────────────────────────────
// One icon per shared/artifacts/categorization.ts FileKind. Image / sheet /
// doc / code above are reused; these fill the buckets that file didn't have
// (text, pdf, audio, video, archive, unknown). Moved out of the attachment-chip
// mock-up when design C shipped so every tile draws the same glyph per kind.

export function TextLinesIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <path d="M8 13h8" /><path d="M8 17h8" />
    </svg>
  );
}

export function PdfIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <path d="M9 18v-6h2a2 2 0 0 1 0 4H9" />
    </svg>
  );
}

export function AudioIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function VideoIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 9h20" /><path d="M2 15h20" /><path d="M7 4v16" /><path d="M17 4v16" />
    </svg>
  );
}

export function ArchiveIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" />
    </svg>
  );
}

export function UnknownFileIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
      <path d="M10 12.5a2 2 0 1 1 2.5 2c-.4.2-.5.5-.5 1" /><path d="M12 18h.01" />
    </svg>
  );
}

/** The glyph for a FileKind. Markdown and plain text share the lined page —
 *  the preview (rendered vs mono) is what tells them apart, not the icon. */
export function FileKindIcon({ kind, size = 15 }: { kind: FileKind; size?: number }) {
  switch (kind) {
    case 'image': return <ImageIcon size={size} />;
    case 'sheet': return <SheetIcon size={size} />;
    case 'code': return <CodeGlyphIcon size={size} />;
    case 'text':
    case 'markdown': return <TextLinesIcon size={size} />;
    case 'pdf': return <PdfIcon size={size} />;
    case 'audio': return <AudioIcon size={size} />;
    case 'video': return <VideoIcon size={size} />;
    case 'archive': return <ArchiveIcon size={size} />;
    case 'unknown': return <UnknownFileIcon size={size} />;
    default: return <DocIcon size={size} />;
  }
}

// View-switch glyphs for the Files tab toolbar (grid of thumbnails vs. compact
// list). Lucide's `layout-grid` and `list` — the two shapes people already read
// as "pictures" and "rows" from every file manager they've used, so the pair
// needs no label.
export function GridViewIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function ListViewIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" />
      <path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
    </svg>
  );
}
