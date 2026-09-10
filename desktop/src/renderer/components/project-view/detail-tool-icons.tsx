// detail-tool-icons — shared inline icons + button class strings for the action
// buttons that live in the ProjectDetailOverlay header (the "tools" slot). Kept
// in one place so the artifact / conversation / context detail views all render
// identical-looking header tools, matching the prototype's renderDetail() buttons
// (one accent primary + neutral bordered secondaries).
import React from 'react';

// Accent primary action (Edit / Save / Resume / Confirm).
export const TOOL_BTN_ACCENT =
  'px-3 py-1.5 rounded-md bg-accent text-on-accent text-[12.5px] inline-flex items-center gap-1.5 hover:opacity-90 transition-opacity disabled:opacity-50';

// Neutral bordered secondary (Reveal / Copy path / Cancel / Open transcript / Exclude).
export const TOOL_BTN_NEUTRAL =
  'px-3 py-1.5 rounded-md bg-inset text-fg-2 hover:text-fg border border-edge-dim hover:border-edge text-[12.5px] inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-default';

function Svg({ size = 13, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PencilIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);

export const CheckIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const FolderIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    {/* Folder + eye — same reveal glyph as the SessionDrawer top bar (approved
        mockup 2-prime), so the two surfaces stay consistent. */}
    <path d="M10.5 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.67.9l.81 1.2a2 2 0 0 0 1.69.9H20a2 2 0 0 1 2 2v3.5" />
    <path strokeWidth={1.5} d="M12.5 18.3s1.9-3.3 5.25-3.3S23 18.3 23 18.3s-1.9 3.3-5.25 3.3-5.25-3.3-5.25-3.3Z" />
    <circle cx="17.75" cy="18.3" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

export const LinkIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    {/* Clipboard + slash — "Copy path" (approved mockup 13; same glyph as the
        SessionDrawer top bar). Export name kept to avoid churn at call sites,
        both of which are Copy-path buttons. */}
    <path d="M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M10.5 16 13.5 10.5" />
  </Svg>
);

export const PlayIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </Svg>
);

// External-link (box + arrow-out) — "Open externally" (OS default app).
export const ExternalLinkIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
  </Svg>
);

// Tray + arrow-down — "Download" (remote access batch 3, 2026-09-10). A phone
// cannot Open or Reveal a file that lives on another computer; it saves a copy.
export const DownloadIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </Svg>
);
