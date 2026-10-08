import { ChevronDown } from './ChevronDown';
import { workbenchPillTintStrong } from '../../pill-practice';
import type { MouseEvent, ReactNode } from 'react';

/**
 * The small tinted pill — a short label about a thing ("Read-only",
 * "1 warning"), in normal case, with its colour in the TINT and the words in
 * the normal text colour.
 *
 * WHY (design guide "Status and notices": "a status label is a small tinted
 * pill in its status colour, normal case"; decisions.md "Status labels",
 * `ui-element-review-status#S-1`): the Specialists roster drew these as tiny
 * spaced-out capitals in a hairline box ("READ-ONLY", "CAN EDIT & RUN
 * COMMANDS"), which the guide retires everywhere. There was no shared pill in
 * `components/ui/` yet — every tinted pill in the app is hand-typed — so this
 * is the one the next screen reaches for instead of a seventh spelling.
 *
 * Not `Badge`: Badge is the neutral, square-cornered record chip (counts,
 * "Optional") and deliberately has no colour. A pill is round and tinted.
 *
 * Words stay `text-fg-2` in every tone: the status colours are fixed across
 * themes, so as TEXT they fail the pale themes (react-renderer rule "Status
 * colour … goes in the ring/tint, NEVER the word"). The tint is /15, not the
 * callout's /10 — a label, not a notice box.
 */
export type PillTone = 'neutral' | 'info' | 'ok' | 'warning' | 'danger';

const TONE: Record<PillTone, string> = {
  neutral: 'bg-inset border-edge-dim',
  info: 'bg-accent/15 border-accent/30',
  ok: 'bg-green-400/15 border-green-400/30',
  warning: 'bg-amber-500/15 border-amber-500/30',
  danger: 'bg-destructive/15 border-destructive/30',
};

// PROPOSED (submit-ticket-5, waiting for Destin — not decided): a stronger tint for the
// coloured tones. Measured on every theme, the 15% green/amber tint over a pale card was
// close to invisible ("Submitted" read grey on YouCoded). Shown only behind ?pillTint=strong.
const TONE_STRONG: Record<PillTone, string> = {
  neutral: 'bg-fg-muted/15 border-edge',
  info: 'bg-accent/25 border-accent/50',
  ok: 'bg-green-500/30 border-green-600/60',
  warning: 'bg-amber-500/30 border-amber-600/60',
  danger: 'bg-destructive/25 border-destructive/55',
};

const DOT: Record<PillTone, string> = {
  neutral: 'bg-fg-muted',
  info: 'bg-accent',
  ok: 'bg-green-400',
  warning: 'bg-amber-500',
  danger: 'bg-destructive',
};

/**
 * `dot` — a LIVE status (someone online, a session working) carries its coloured
 * dot inside the pill, before the word.
 *
 * WHY (guide "Status and notices": "A live status … carries its coloured dot inside
 * the pill"; decisions "Status labels", S-1 — the session switcher's look): the
 * friends panel's Online / In game / Offline pills are the second live-status
 * caller after the session switcher, whose pill is its own copy in SessionStrip
 * (with a breathing dot). This one is static — a friend's presence is a fact, not
 * an activity, and an infinite animation per row costs a frame budget
 * (performance rule 6).
 */
export function Pill({ tone = 'neutral', dot = false, children, className = '' }: { tone?: PillTone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center shrink-0 rounded-full border ${dot ? 'gap-1 pl-1.5 pr-2' : 'px-2'} py-px text-3xs leading-tight text-fg-2 whitespace-nowrap ${(workbenchPillTintStrong() ? TONE_STRONG : TONE)[tone]} ${className}`.trim()}
    >
      {dot && <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`} />}
      {children}
    </span>
  );
}

/**
 * A pill you can click — the same tinted pill (and dot), plus the app's dropdown chevron,
 * turned up while its menu is open. The menu is the caller's.
 *
 * WHY (games-social round 3, deck games-social-2 G2-2 — Destin: "i wanted to keep the
 * styling of the online pill, but make it clickable"): your own status in the friends card
 * was a dropdown field, which read as a form control in a row of pills. Guide "Buttons": an
 * edit control is shaped like the things it edits — a pill among pills.
 */
export function PillButton({ tone = 'neutral', dot = false, open, onClick, children, className = '', 'aria-label': ariaLabel }: {
  tone?: PillTone; dot?: boolean; open: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode; className?: string; 'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      className={`inline-flex items-center shrink-0 gap-1 rounded-full border ${dot ? 'pl-1.5' : 'pl-2'} pr-1.5 py-px text-3xs leading-tight text-fg-2 whitespace-nowrap transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${(workbenchPillTintStrong() ? TONE_STRONG : TONE)[tone]} ${className}`.trim()}
    >
      {dot && <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`} />}
      {children}
      <ChevronDown className={`w-2.5 h-2.5 shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} />
    </button>
  );
}
