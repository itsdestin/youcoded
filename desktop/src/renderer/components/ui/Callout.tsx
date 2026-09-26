import React from 'react';
import { ChevronDown } from './ChevronDown';

/**
 * K4 — the callout. THE notice box: one geometry, three tones, used for every
 * warning, error and info notice in the app.
 *
 * Replaces two competing geometries that were doing the same job:
 * `rounded-md px-2.5 py-2` (3 sites) and `rounded-lg p-3` (2 sites), plus
 * SyncPanel's destructive banner, which was a full-bleed `border-b` strip
 * because no danger tone existed to reach for.
 *
 * ── It HAS an action slot now (2026-09-25) ─────────────────────────────────
 * This file used to say "THERE IS NO ACTION SLOT, AND THAT IS THE POINT" — a
 * block that offered a button was meant to be a K5 status strip instead. Destin
 * overruled that on the settings-pieces deck (`ui-element-review-settings-
 * pieces#P-2`, `#P-4`, decisions.md "Errors and warnings in a setting" /
 * "Problem on a list item"): a problem is ALWAYS this same tinted box, sitting
 * inside the thing it is about, and **its buttons (Try again, Show details,
 * Resume, Delete…) go INSIDE the box, at the right**. Splitting "a notice"
 * from "a notice with a button" into two looks is exactly what he rejected
 * (fix batch 1: "these top banners are still unlike anything else in the app").
 * StatusStrip remains for a subsystem's RUNNING state ("Checking…", "Not set up
 * yet"), which is not a problem notice.
 *
 * ── Colour lives in the box and the title only ─────────────────────────────
 * Design guide "Status and notices": the text inside is the normal grey/black,
 * never red or coloured body text. The danger tone used to write its body in
 * `text-destructive-fg`; it is now `text-fg-2` like the other two tones, and
 * only the title keeps the tone's colour.
 *
 * Tone preserves change 14's rule — accent means information, amber means
 * warning — plus the danger tone.
 */

export type CalloutTone = 'info' | 'warning' | 'danger';

const TONE: Record<CalloutTone, { surface: string; body: string; title: string }> = {
  info: { surface: 'bg-accent/10 border-accent/25', body: 'text-fg-2', title: 'text-fg' },
  // Status colors stay hardcoded per the standing rule (desktop/CLAUDE.md), so
  // amber is a raw Tailwind color rather than a theme token.
  // WHY the warning title is normal text colour, not amber (fix batch 2, 2026-09-26): amber-400
  // text on the pale amber tint was near-invisible on light and wallpaper themes ("Download
  // interrupted" inside a model card), and the app's own rule is that a status hue lives in the
  // tint and border, NEVER in the word (react-renderer.md, "Status colours").
  warning: { surface: 'bg-amber-500/10 border-amber-500/25', body: 'text-fg-2', title: 'text-fg' },
  // `destructive` is the one status color that IS tokenised: change 17 moved the
  // app's reds onto it so theme packs can restyle their own danger.
  // WHY body text-fg-2 (2026-09-25, decisions.md P-2): "text is normal
  // grey/black, never red" — only the box and its title carry the red.
  danger: { surface: 'bg-destructive/10 border-destructive/50', body: 'text-fg-2', title: 'text-destructive-fg' },
};

export type CalloutProps = {
  tone?: CalloutTone;
  /** Optional bold lead-in line above the body. The ONLY coloured text. */
  title?: React.ReactNode;
  className?: string;
  /** Collapse to the title line; the body opens on click. Needs `title`.
   *  For a warning whose headline says enough and whose detail is a list (the
   *  Sync box's too-big conversations, 2026-09-16). */
  collapsible?: boolean;
  /**
   * The notice's own buttons — Try again, Show details, Resume, Delete — drawn
   * INSIDE the box at the right (decisions.md P-2/P-4). Usually `<Button
   * size="sm">`s: outlined ones first, the one filled main action last, so the
   * filled button ends up at the far right like every other button pair.
   * When the box is too narrow for text and buttons side by side (a phone),
   * the buttons wrap onto their own line, still right-aligned.
   */
  actions?: React.ReactNode;
  /** Optional: a title-only notice (e.g. "Download interrupted" with its
   *  Resume/Delete) has nothing more to say underneath. */
  children?: React.ReactNode;
};

export function Callout({ tone = 'info', title, className = '', collapsible = false, actions, children }: CalloutProps) {
  const t = TONE[tone];
  if (collapsible && title) {
    return (
      <details className={`group rounded-lg p-3 border ${t.surface} ${className}`.trim()}>
        {/* The browser's own left-hand triangle is hidden; the arrow sits on the
            right and turns like the session switcher's (Destin, 2026-09-16). */}
        <summary className={`flex items-center justify-between gap-2 list-none [&::-webkit-details-marker]:hidden text-xs font-medium cursor-pointer select-none ${t.title}`}>
          <span className="min-w-0">{title}</span>
          <ChevronDown className="w-3 h-3 shrink-0 text-fg-muted transition-transform group-open:rotate-180" strokeWidth={2.5} />
        </summary>
        {children && <div className={`text-xs mt-1.5 ${t.body}`}>{children}</div>}
        {actions && <div className="mt-2 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </details>
    );
  }
  // Both slots are <div>, not <p>. A callout body can legitimately carry a
  // block child — SyncSetupWizard's install error puts an "Install manually"
  // link on its own line — and a <div> inside a <p> is invalid HTML that the
  // browser silently repairs by closing the paragraph early, which would drop
  // the body's own text classes off everything after it.
  //
  // WHY the title is text-xs (12px) medium, not the old text-3xs: the guide's
  // reference notice is Backup & Sync's "too big to sync" box, whose title is
  // the collapsible branch above at text-xs. The plain branch used a smaller
  // title, so the "same" box read as two looks; the audit also flagged the
  // tiny amber title on Setup Complete as hard to read.
  const text = (
    <>
      {title && <div className={`text-xs font-medium mb-0.5 ${t.title}`}>{title}</div>}
      {children && <div className={`text-xs ${t.body}`}>{children}</div>}
    </>
  );
  if (!actions) {
    return <div className={`rounded-lg p-3 border ${t.surface} ${className}`.trim()}>{text}</div>;
  }
  return (
    <div className={`rounded-lg p-3 border ${t.surface} ${className}`.trim()}>
      {/* WHY flex-wrap with a basis on the text: side by side when there is
          room, and on a phone the button group drops to its own line (still
          at the right, via ml-auto) instead of squeezing the words into a
          one-word column. `items-start` keeps the buttons level with the
          title, and they never move when the body grows (e.g. Show details
          opening below the summary — Destin, 2026-09-16). */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex-1 min-w-48">{text}</div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}
