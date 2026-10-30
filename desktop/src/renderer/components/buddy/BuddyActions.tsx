import React from 'react';
/**
 * The icons of the buddy's four actions — screenshot the desktop into the chat, a bigger or smaller chat window, open
 * YouCoded, hide the buddy — drawn by the panel beside the mascot (BuddyBarApp; buddy-rebuild-review5#C-5). The same
 * stroke style as the app's other inline icons, so they sit naturally in its shared ghost buttons.
 */
const ICON = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

// TEMPORARY — icon review (Destin, 2026-10-30: "screenshot, open youcoded, and hide … redrawn so their purpose is more
// intuitive"). ?icons=<shot>,<open>,<hide> swaps in a candidate so the review deck can photograph each one in the real
// row. Deleted, with every losing candidate, once he picks.
const PICK = (() => {
  try { return new URLSearchParams(window.location.search).get('icons')?.split(',') ?? []; } catch { return []; }
})();
const CANDIDATES: Record<'shot' | 'open' | 'hide', Record<string, React.ReactNode>> = {
  shot: {
    frame: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></>,
    monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M6 9V7h3M15 7h3v2M18 11v2h-3M9 13H6v-2" /></>,
    camera: <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="3" /></>,
  },
  open: {
    external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
    window: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 9h20M6 6.5h.01M9 6.5h.01" /></>,
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9" /></>,
    // Round 2 (Destin: "either b/c. want to see a few more variants").
    winout: <><path d="M13 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M3 9h9" /><path d="M16 3h5v5M21 3l-7 7" /></>,
    wininside: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M10 16l5-5M11 11h4v4" /></>,
    winup: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M12 17v-5M9.5 14.5 12 12l2.5 2.5" /></>,
    extsoft: <><rect x="3" y="7" width="14" height="14" rx="3" /><path d="M14 3h7v7M21 3l-9 9" /></>,
  },
  hide: {
    eyeoff: <><path d="M10.7 5.1A10.7 10.7 0 0 1 21.9 12a10.8 10.8 0 0 1-1.4 2.5M14.1 14.2a3 3 0 0 1-4.3-4.3M17.5 17.5A10.8 10.8 0 0 1 2.1 12a10.8 10.8 0 0 1 4.4-5.1" /><path d="m2 2 20 20" /></>,
    tuck: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    // Round 2 (Destin: "none of these").
    sleep: <><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /><path d="M15 3h4l-4 5h4" /></>,
    leave: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>,
    minimize: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12h8" /></>,
    putaway: <><path d="M3 13h5l1.5 2.5h5L16 13h5v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 3v8M8.5 7.5 12 11l3.5-3.5" /></>,
  },
};
const candidate = (kind: 'shot' | 'open' | 'hide', i: number) => {
  const c = CANDIDATES[kind][PICK[i] ?? ''];
  return c ? <svg {...ICON}>{c}</svg> : null;
};

export function CameraIcon() {
  const c = candidate('shot', 0); if (c) return c;
  return (
    <svg {...ICON}>
      <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
/** A window with an arrow leaving it: "open the app". Not the diagonal arrows, which mean the size below. */
export function OpenIcon() {
  const c = candidate('open', 1); if (c) return c;
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
  const c = candidate('hide', 2); if (c) return c;
  return (
    <svg {...ICON}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
