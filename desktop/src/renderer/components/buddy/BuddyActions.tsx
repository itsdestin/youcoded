/**
 * The icons of the buddy's four actions — screenshot the desktop into the chat, a bigger or smaller chat window, open
 * YouCoded, hide the buddy — drawn by the panel beside the mascot (BuddyBarApp; buddy-rebuild-review5#C-5). The same
 * stroke style as the app's other inline icons, so they sit naturally in its shared ghost buttons.
 */
const ICON = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

export function CameraIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
/** A window with an arrow leaving it: "open the app". Not the diagonal arrows, which mean the size below. */
export function OpenIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="4" width="14" height="14" rx="2" /><path d="M3 8h14M14 3h7v7M21 3l-8 8" />
    </svg>
  );
}
export function SizeIcon() {
  return <svg {...ICON}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>;
}
export function HideIcon() {
  return (
    <svg {...ICON}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
