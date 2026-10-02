// File-type glyphs for Office — stroke icons in the page-icons style, so a tab,
// a start-screen card and a file row all draw the same shape for the same kind.
import React from 'react';
import type { OfficeKind } from '../../../shared/office-types';

const PATHS: Record<OfficeKind, React.ReactNode> = {
  document: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3h8l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v4h4M8 12h8M8 16h8M8 8h3" />,
  spreadsheet: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 10h16M4 15h16M10 4v16" />,
  presentation: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M5 4v10a1 1 0 001 1h12a1 1 0 001-1V4M12 15v4M8 21l4-2 4 2M9 11l2-2 2 2 3-3" />,
};

export function OfficeKindGlyph({ kind, className = 'w-4 h-4' }: { kind: OfficeKind; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[kind]}
    </svg>
  );
}

export function HomeGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 11l8-7 8 7v8a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1v-8z" />
    </svg>
  );
}

export function HistoryGlyph({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12a9 9 0 103-6.7M3 4v4h4M12 8v4l3 2" />
    </svg>
  );
}

export const KIND_LABEL: Record<OfficeKind, string> = {
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
};

// The slim bar's glyphs (file viewers' Edit mode). Same 24-unit stroke style.
const CMD_PATHS: Record<string, React.ReactNode> = {
  undo: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />,
  redo: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />,
  bold: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z" />,
  italic: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4h7M6 20h7M14 4l-4 16" />,
  underline: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v7a5 5 0 0010 0V4M5 21h14" />,
  markers: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  numbering: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 13.5a1.5 1.5 0 013 0c0 1.5-3 2-3 3.5h3M3.5 18.5h3l-1.5 2" />,
  'align-left': <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  'align-center': <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  'align-right': <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
};

export function CommandGlyph({ cmd, className = 'w-4 h-4' }: { cmd: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      {CMD_PATHS[cmd]}
    </svg>
  );
}
