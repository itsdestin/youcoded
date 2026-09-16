import React from 'react';
import { useThemeMascot } from '../hooks/useThemeMascot';
import { useTheme } from '../state/theme-context';
import { isAndroid, isRemoteMode } from '../platform';
import { MascotRig, type RigMotion } from './mascot/MascotRig';
import { MascotScene } from './mascot/MascotScene';
import { defaultMascotPaint } from './mascot/default-mascot-paint';
import type { PoseName } from './mascot/mascot-poses';
import type { MascotVariant } from '../themes/theme-types';

interface IconProps {
  className?: string;
}

/** Terminal icon — rounded rect with >_ prompt */
export function TerminalIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M4 4 L20 4 A2 2 0 0 1 22 6 L22 18 A2 2 0 0 1 20 20 L4 20 A2 2 0 0 1 2 18 L2 6 A2 2 0 0 1 4 4 Z"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M6 9 L10 12 L6 15" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15 L17 15" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Chat icon — speech bubble with three dots */
export function ChatIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M4 5 L20 5 A2 2 0 0 1 22 7 L22 15 A2 2 0 0 1 20 17 L10 17 L6 20 L7 17 L4 17 A2 2 0 0 1 2 15 L2 7 A2 2 0 0 1 4 5 Z"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M8.5 11 L8.5 11.01" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M12 11 L12 11.01" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M15.5 11 L15.5 11.01" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** A chat bubble with a play triangle inside — "continue this conversation".
 *  Destin (2026-08-27 gate, M-narrow): at phone width the Resume button drops
 *  its word, and a bare arrow said "go somewhere", not "carry on talking".
 *  Same bubble outline as ChatIcon so the two read as one family. */
export function ChatResumeIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M4 5 L20 5 A2 2 0 0 1 22 7 L22 15 A2 2 0 0 1 20 17 L10 17 L6 20 L7 17 L4 17 A2 2 0 0 1 2 15 L2 7 A2 2 0 0 1 4 5 Z"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M10 8.2 L15.4 11 L10 13.8 Z" strokeWidth="1.6" strokeLinejoin="round" fill="currentColor" />
    </svg>
  );
}

/** Paperclip attachment icon */
export function AttachIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M15.5 6 L15.5 15.5 A3.5 3.5 0 0 1 8.5 15.5 L8.5 7 A2 2 0 0 1 12.5 7 L12.5 15.5 A0.5 0.5 0 0 1 11.5 15.5 L11.5 8.5"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

/** Game controller icon — handheld style */
export function GamepadIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {/* Body */}
      <rect x="5" y="3" width="14" height="18" rx="2.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Screen */}
      <rect x="8" y="6" width="8" height="5" rx="1" strokeWidth="1.4" />
      {/* D-pad */}
      <path d="M9 15.5 L11 15.5" strokeWidth="2" strokeLinecap="round" />
      <path d="M10 14.5 L10 16.5" strokeWidth="2" strokeLinecap="round" />
      {/* Buttons */}
      <path d="M14.5 15 L14.5 15.01" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M16.5 16.5 L16.5 16.51" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

/** Compass icon — circle with needle, used for command drawer entry */
export function CompassIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="10" strokeWidth="1.8" />
      <polygon
        points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="currentColor"
        opacity="0.3"
      />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Status: complete — subtle rounded check */
export function CheckIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.6">
      <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
      <path d="M8 12.5 L11 15.5 L16.5 9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Status: failed — subtle rounded X */
export function FailIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.6">
      <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
      <path d="M9 9 L15 15 M15 9 L9 15" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Status: awaiting approval — subtle rounded ? */
/** Specialists 1c: a helper that was stopped (interrupted) — circle + square,
 *  the universal "stop" glyph, at the same weight as Check/Fail. */
export function StoppedIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.6">
      <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function QuestionIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.6">
      <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
      <path d="M9.5 9.5a3 3 0 0 1 5 1.5c0 1.5-2.5 2-2.5 2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Note — page with folded top-right corner and three wavy "scribble"
 * lines representing handwritten text. Shown in place of the check icon
 * on a successfully invoked Skill tool card so skills read distinctly in
 * the chat timeline. Same opacity and stroke weight as the status icons
 * (Check/Fail/Question) so it sits in the same visual slot. */
export function NoteIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.6">
      {/* Page outline with a folded top-right corner — document silhouette */}
      <path
        d="M6 3 L 15 3 L 19 7 L 19 21 L 6 21 Z"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
      {/* Folded corner — the diagonal flap */}
      <path
        d="M15 3 L 15 7 L 19 7"
        strokeWidth="1.2" strokeLinejoin="round"
      />
      {/* Scribbled line 1 — full width */}
      <path
        d="M8 11 Q 9 10.5, 10 11 Q 11 11.5, 12 11 Q 13 10.5, 14 11 Q 15 11.5, 16 11"
        strokeWidth="1.2" strokeLinecap="round"
      />
      {/* Scribbled line 2 — full width */}
      <path
        d="M8 14 Q 9 13.5, 10 14 Q 11 14.5, 12 14 Q 13 13.5, 14 14 Q 15 14.5, 16 14"
        strokeWidth="1.2" strokeLinecap="round"
      />
      {/* Scribbled line 3 — short (paragraph end) */}
      <path
        d="M8 17 Q 9 16.5, 10 17 Q 11 17.5, 12 17"
        strokeWidth="1.2" strokeLinecap="round"
      />
    </svg>
  );
}

/** Chevron — used for expand/collapse toggles */
export function ChevronIcon({ className = 'w-3.5 h-3.5', expanded = false }: IconProps & { expanded?: boolean }) {
  return (
    <svg
      className={`${className} transition-transform ${expanded ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/** Fast mode icon — stylized bolt in the line-art style (not the filled ⚡ emoji) */
export function FastIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        d="M13 3 L5 13.5 L11 13.5 L10 21 L19 9.5 L13 9.5 L13 3 Z"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

/** App mascot — chibi welcome variant with sparkle eyes, tilted smile, waving */
export function WelcomeAppIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <defs>
        {/* Layered swirl gradients for eye backgrounds */}
        <radialGradient id="eye-swirl-a" cx="25%" cy="30%" r="60%">
          <stop offset="0%" stopColor="#2a3040" stopOpacity="1" />
          <stop offset="100%" stopColor="#2a3040" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="eye-swirl-b" cx="70%" cy="65%" r="55%">
          <stop offset="0%" stopColor="#2a2535" stopOpacity="1" />
          <stop offset="100%" stopColor="#2a2535" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Eye backgrounds — navy base with blue-gray + plum swirls */}
      <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="var(--default-icon-face, #1e2636)" />
      <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="url(#eye-swirl-a)" />
      <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="url(#eye-swirl-b)" />
      <ellipse cx="14.7" cy="9.25" rx="1.6" ry="2.2" fill="var(--default-icon-face, #1e2636)" />
      <ellipse cx="14.7" cy="9.25" rx="1.6" ry="2.2" fill="url(#eye-swirl-a)" />
      <ellipse cx="14.7" cy="9.25" rx="1.6" ry="2.2" fill="url(#eye-swirl-b)" />
      {/* Body with eye cutouts (left slightly lower, right slightly higher) */}
      <path
        fillRule="evenodd"
        d="M9 4 L15 4 A4 4 0 0 1 19 8 L19 12 A4 4 0 0 1 15 16 L9 16 A4 4 0 0 1 5 12 L5 8 A4 4 0 0 1 9 4 Z M9.3 7.35 A1.6 2.2 0 1 0 9.3 11.75 A1.6 2.2 0 1 0 9.3 7.35 Z M14.7 7.05 A1.6 2.2 0 1 0 14.7 11.45 A1.6 2.2 0 1 0 14.7 7.05 Z"
      />
      {/* Eye sparkles — scattered cluster, bottom-right of each eye */}
      <circle cx="10" cy="10.25" r="0.25" />
      <circle cx="9.4" cy="10.85" r="0.18" />
      <circle cx="10.3" cy="10.85" r="0.13" />
      <circle cx="15.4" cy="9.95" r="0.25" />
      <circle cx="14.8" cy="10.55" r="0.18" />
      <circle cx="15.7" cy="10.55" r="0.13" />
      {/* Half-circle smile, tilted -2° */}
      <g transform="rotate(-2 12 13.3)"><path data-mascot-face d="M10.8 13.3 Q10.8 13 12 13 Q13.2 13 13.2 13.3 A1.1 1 0 0 1 10.8 13.3 Z" fill="var(--default-icon-face, #222030)" /></g>
      {/* Left arm (tilted slightly clockwise, lowered) */}
      <g transform="translate(0.3 1.0) rotate(-10 2.5 11)"><path d="M1.8 9 L3.2 9 A0.8 0.8 0 0 1 4 9.8 L4 12.2 A0.8 0.8 0 0 1 3.2 13 L1.8 13 A0.8 0.8 0 0 1 1 12.2 L1 9.8 A0.8 0.8 0 0 1 1.8 9 Z" /></g>
      {/* Right arm (waving, rotated near head corner) */}
      <g transform="translate(-0.1 0.8) rotate(-20 19.5 6)"><path d="M20.8 2.5 L22.2 2.5 A0.8 0.8 0 0 1 23 3.3 L23 5.7 A0.8 0.8 0 0 1 22.2 6.5 L20.8 6.5 A0.8 0.8 0 0 1 20 5.7 L20 3.3 A0.8 0.8 0 0 1 20.8 2.5 Z" /></g>
      {/* Legs */}
      <rect x="7.2" y="17" width="3.5" height="4" rx="1.2" />
      <rect x="13.3" y="17" width="3.5" height="4" rx="1.2" />
    </svg>
  );
}

/** App mascot — squat character with >< eyes, nub arms, stubby legs */
export function AppIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      {/* Body with eye cutouts */}
      <path
        fillRule="evenodd"
        d="M9 4 L15 4 A4 4 0 0 1 19 8 L19 12 A4 4 0 0 1 15 16 L9 16 A4 4 0 0 1 5 12 L5 8 A4 4 0 0 1 9 4 Z M8.5 8 L10.5 10 L8.5 12 L9.5 12 L11.5 10 L9.5 8 Z M15.5 8 L13.5 10 L15.5 12 L14.5 12 L12.5 10 L14.5 8 Z"
      />
      {/* Left arm */}
      <path d="M1.8 9 L3.2 9 A0.8 0.8 0 0 1 4 9.8 L4 12.2 A0.8 0.8 0 0 1 3.2 13 L1.8 13 A0.8 0.8 0 0 1 1 12.2 L1 9.8 A0.8 0.8 0 0 1 1.8 9 Z" />
      {/* Right arm */}
      <path d="M20.8 9 L22.2 9 A0.8 0.8 0 0 1 23 9.8 L23 12.2 A0.8 0.8 0 0 1 22.2 13 L20.8 13 A0.8 0.8 0 0 1 20 12.2 L20 9.8 A0.8 0.8 0 0 1 20.8 9 Z" />
      {/* Left leg — gap from body, rounded */}
      <rect x="7.2" y="17" width="3.5" height="4" rx="1.2" />
      {/* Right leg — gap from body, rounded */}
      <rect x="13.3" y="17" width="3.5" height="4" rx="1.2" />
    </svg>
  );
}

interface ThemeMascotProps {
  /** WHY: the 24px silhouette rim must not scale up on hero/gate artwork.
   * Large callers explicitly opt out; CSS class names are not a size API. */
  small?: boolean;
  variant: MascotVariant;
  fallback: React.ComponentType<IconProps>;
  className?: string;
  /** Render the theme's scene companions (sun, motes, sparkles) around the
   *  mascot. Only for big-canvas hero surfaces (welcome screen) — satellites
   *  orbit well outside the mascot box and would clip or clutter tiles. */
  scene?: boolean;
}

// Static motion for non-buddy surfaces — never dragging, so the rig's limb
// springs stay parked and only the pose transforms + blink loop are active.
const STATIC_MOTION: { current: RigMotion } = { current: { vx: 0, vy: 0, dragging: false } };

// The app's four flat variants → rig pose names ('inquisitive' predates the
// rig contract's 'curious'; same expression).
const VARIANT_POSE: Record<MascotVariant, PoseName> = {
  idle: 'idle',
  welcome: 'welcome',
  inquisitive: 'curious',
  shocked: 'shocked',
};

/** Renders a themed mascot: the rig when the theme ships one (rig-first, spec §3.5),
 *  else the flat variant image, else the built-in fallback glyph. */
export function ThemeMascot({ variant, fallback: Fallback, className = 'w-6 h-6', scene = false, small = true }: ThemeMascotProps) {
  const { theme, activeTheme, reducedEffects } = useTheme();
  const overrideSrc = useThemeMascot(variant);
  // Rig rendering is Electron-desktop-only for now: it fetches theme-asset://
  // URLs, which don't exist in the Android WebView or the remote-browser shim.
  // Those platforms keep the flat path until rig asset delivery is ported.
  const desktop = !isAndroid() && !isRemoteMode();
  const rigSrc = desktop ? activeTheme?.mascot?.rig ?? null : null;
  const companions = scene && desktop ? activeTheme?.companions ?? [] : [];
  // A picture this page cannot show gets the default mascot, never a broken-image box (Destin,
  // 2026-09-11: a screenshot of "No Active Session" with one where Meadow Mist's mascot belongs).
  // A browser connected over remote access cannot load theme-asset:// at all: the files are on the
  // computer. The Android app serves them from the phone, so it still tries. Any picture that fails
  // to load falls back too; keyed on the address, so switching theme tries the new picture.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const unreachable = !!overrideSrc && overrideSrc.startsWith('theme-asset://') && isRemoteMode() && !isAndroid();
  const pictureCanLoad = !unreachable && failedSrc !== overrideSrc;

  let mascot: React.ReactNode;
  if (rigSrc) {
    // Inline rig render — the whole reason rigs exist: the <img> path below
    // can't resolve CSS variables (currentColor renders black) and can't
    // swap faces. MascotRig sanitizes the SVG before inlining it.
    mascot = (
      <div
        className={className}
        aria-hidden="true"
        style={{
          // Map theme tokens onto the rig tint contract (wecoded-themes
          // mascots/README.md): --rig-accent/-on-accent/-line.
          ['--rig-accent' as string]: 'var(--accent)',
          ['--rig-on-accent' as string]: 'var(--on-accent)',
          ['--rig-line' as string]: 'var(--fg)',
          ...defaultMascotPaint(theme, small),
        }}
      >
        <MascotRig
          svgUrl={rigSrc}
          pose={VARIANT_POSE[variant]}
          motionRef={STATIC_MOTION}
          reducedEffects={reducedEffects}
        />
      </div>
    );
  } else if (overrideSrc && pictureCanLoad) {
    mascot = <img src={overrideSrc} className={className} alt="" aria-hidden="true" draggable={false} onError={() => setFailedSrc(overrideSrc)} />;
  } else {
    // WHY: scope art paint to the fallback, never a theme's authored rig/image.
    const paint = defaultMascotPaint(theme, small);
    mascot = <span data-default-mascot="icon" data-soft-palette={!!paint['--default-icon-body']} style={{ display: 'contents', ...paint }}><Fallback className={className} /></span>;
  }

  if (companions.length) {
    return (
      <MascotScene companions={companions} reducedEffects={reducedEffects}>
        {mascot}
      </MascotScene>
    );
  }
  return mascot;
}

// Voice prompting (2026-09-05): the composer's mic. Same 24-box, 1.8 stroke and
// round caps as AttachIcon so the two read as one family at 20px.
export function MicIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3M9 21h6" />
    </svg>
  );
}
