import type { SessionStatusColor } from './StatusDot';

// WHY: project availability borrows the session switcher's color semantics.
// One palette makes green/amber/red dots and pill surfaces stay equivalent on
// both screens; text remains theme-colored for readable light-theme contrast.
export const STATUS_DOT_BG: Record<SessionStatusColor, string> = {
  green: 'bg-green-400',
  red: 'bg-red-400',
  // Amber harmonizes with the buddy AttentionStrip's #f5a623 convention.
  amber: 'bg-amber-400',
  blue: 'bg-blue-400',
  gray: 'bg-gray-500',
};

// P-8 (2026-08-28): the session menu's dot alone gave no meaning. The word
// names the state; the tinted border and background carry only its tone.
export const STATUS_PILL_TONE: Record<SessionStatusColor, string> = {
  green: 'bg-green-400/15 border-green-400/30',
  red: 'bg-red-400/15 border-red-400/30',
  amber: 'bg-amber-400/15 border-amber-400/30',
  blue: 'bg-blue-400/15 border-blue-400/30',
  gray: 'bg-gray-500/15 border-gray-500/30',
};
