import React from 'react';
import { useThemeMascot } from '../hooks/useThemeMascot';
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

/** Menu icon — three horizontal dots */
export function MenuIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="6" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18" cy="12" r="1.5" />
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
export function QuestionIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.6">
      <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
      <path d="M9.5 9.5a3 3 0 0 1 5 1.5c0 1.5-2.5 2-2.5 2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
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

/** App mascot variant — inquisitive expression with wide round eyes */
export function InquisitiveAppIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      {/* Body with round eye cutouts */}
      <path
        fillRule="evenodd"
        d="M9 4 L15 4 A4 4 0 0 1 19 8 L19 12 A4 4 0 0 1 15 16 L9 16 A4 4 0 0 1 5 12 L5 8 A4 4 0 0 1 9 4 Z M9.8 8.2 A2 2 0 1 0 9.8 12.2 A2 2 0 1 0 9.8 8.2 Z M14.2 8.2 A2 2 0 1 0 14.2 12.2 A2 2 0 1 0 14.2 8.2 Z"
      />
      {/* Pupils — small dots inside the round eyes */}
      <circle cx="10.3" cy="10.2" r="0.7" />
      <circle cx="14.7" cy="10.2" r="0.7" />
      {/* Left arm */}
      <path d="M1.8 9 L3.2 9 A0.8 0.8 0 0 1 4 9.8 L4 12.2 A0.8 0.8 0 0 1 3.2 13 L1.8 13 A0.8 0.8 0 0 1 1 12.2 L1 9.8 A0.8 0.8 0 0 1 1.8 9 Z" />
      {/* Right arm */}
      <path d="M20.8 9 L22.2 9 A0.8 0.8 0 0 1 23 9.8 L23 12.2 A0.8 0.8 0 0 1 22.2 13 L20.8 13 A0.8 0.8 0 0 1 20 12.2 L20 9.8 A0.8 0.8 0 0 1 20.8 9 Z" />
      {/* Left leg */}
      <rect x="7.2" y="17" width="3.5" height="4" rx="1.2" />
      {/* Right leg */}
      <rect x="13.3" y="17" width="3.5" height="4" rx="1.2" />
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
      <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="#1e2636" />
      <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="url(#eye-swirl-a)" />
      <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="url(#eye-swirl-b)" />
      <ellipse cx="14.7" cy="9.25" rx="1.6" ry="2.2" fill="#1e2636" />
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
      <g transform="rotate(-2 12 13.3)"><path d="M10.8 13.3 Q10.8 13 12 13 Q13.2 13 13.2 13.3 A1.1 1 0 0 1 10.8 13.3 Z" fill="#222030" /></g>
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
  variant: MascotVariant;
  fallback: React.ComponentType<IconProps>;
  className?: string;
}

/** Renders a themed mascot SVG if the active theme overrides it, otherwise falls back to the default. */
export function ThemeMascot({ variant, fallback: Fallback, className = 'w-6 h-6' }: ThemeMascotProps) {
  const overrideSrc = useThemeMascot(variant);

  if (overrideSrc) {
    return <img src={overrideSrc} className={className} alt="" aria-hidden="true" draggable={false} />;
  }

  return <Fallback className={className} />;
}
