import React from 'react';
/**
 * The icons of the buddy's four actions — screenshot the desktop into the chat, a bigger or smaller chat window, open
 * YouCoded, hide the buddy — drawn by the panel beside the mascot (BuddyBarApp; buddy-rebuild-review5#C-5). The same
 * stroke style as the app's other inline icons, so they sit naturally in its shared ghost buttons.
 *
 * Chosen over three rounds (buddy-rebuild-icons, -icons2, -icons3). WHY the shared sizing: Destin saw the old row
 * "zigzag" — each picture filled a different share of its box at a different height — so all four fill the same
 * 16-unit height centred on the box's middle line (buddy-rebuild-icons3#I-6). Keep a new or redrawn one to that.
 */
const ICON = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

/** A screen with capture corners inside it: "take a picture of the desktop" (buddy-rebuild-icons#I-1). */
export function ScreenshotIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v3.5M8.5 20h7M6.5 9V7h2M15.5 7h2v2M17.5 11v2h-2M8.5 13h-2v-2" />
    </svg>
  );
}
/**
 * The app window — title bar and its two dots — with the arrow leaving through its open corner: "open the app"
 * (buddy-rebuild-icons3#I-4). Not the bare diagonal arrows, which mean the size button beside it.
 */
export function OpenIcon() {
  return (
    <svg {...ICON}>
      <path d="M11 5H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5M3 9h6" />
      <path d="M5.6 7h.01M8 7h.01" />
      <path d="M15 3h6v6M21 3l-8 8" />
    </svg>
  );
}
export function SizeIcon() {
  return <svg {...ICON}><path d="M14 4h6v6M10 20H4v-6M20 4l-6 6M4 20l6-6" /></svg>;
}
/**
 * A crossed-out eye (buddy-rebuild-icons3#I-5). WHY the mask: the old hand-cut arcs left a lopsided pupil where the
 * slash crossed it; the mask cuts one even gap through outline and pupil alike. The id is per instance because the
 * row can be drawn more than once on a page (the workbench), and a shared id would point every eye at the first mask.
 */
export function HideIcon() {
  const id = `buddy-eye${React.useId().replace(/:/g, '')}`;
  return (
    <svg {...ICON}>
      <mask id={id}><rect width="24" height="24" fill="white" /><path d="M4.5 4.5l15 15" stroke="black" strokeWidth="4.6" /></mask>
      <g mask={`url(#${id})`}>
        <path d="M2.5 12C4.6 8 8 6 12 6s7.4 2 9.5 6c-2.1 4-5.5 6-9.5 6S4.6 16 2.5 12z" />
        <circle cx="12" cy="12" r="2.6" />
      </g>
      <path d="M4.5 4.5l15 15" />
    </svg>
  );
}
