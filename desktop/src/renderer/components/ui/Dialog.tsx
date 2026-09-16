import React from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z, type OverlayLayer } from '../overlays/Overlay';
import { CloseButton } from './CloseButton';
import { useScrollFade } from '../../hooks/useScrollFade';

/**
 * D1 — the one dialog shell.
 *
 * Supersedes `SettingsPopup.tsx`, which had 7 callers against 49 files that
 * hand-rolled `createPortal` + `<Scrim>` + `<OverlayPanel>` themselves. Between
 * them those shipped ~18 distinct widths, 7 different max-heights, 2 competing
 * centering techniques and 4 header paddings, for one thing.
 *
 * Three properties this owns that the old shell left to the caller, each because
 * leaving it to the caller demonstrably failed:
 *
 * 1. THE SCROLL BODY. SettingsPopup set maxHeight but left the panel a plain
 *    block, so callers had to remember `className="flex flex-col"` AND wrap
 *    their own `.scroll-fade`. Two of its seven forgot (Sound, Session
 *    Defaults); the symptom is a dialog that clips with no way to reach the
 *    bottom. Destin hit it in Sound on 2026-07-26. Pass `scrollBody={false}`
 *    only when the caller genuinely owns its whole surface.
 *
 * 2. CENTERING. An outer flex wrapper, not `position:fixed` + transform. The
 *    transform technique breaks the height constraint a flex-1 scroll region
 *    needs — that is documented at StatusBar.tsx and was rediscovered
 *    independently by ResumeBrowser. One technique, chosen because it is the one
 *    that works with a bounded scroll body.
 *
 * 3. HEIGHT AS A CEILING. There is no `height` prop, so a fixed height is not
 *    expressible. A fixed `h-` is what makes ContextPopup jump to full height
 *    the moment its explainer opens.
 */

/**
 * Dialog widths, DERIVED — not a ladder fitted to whatever the old values were.
 *
 * The first version of this was `sm 340 / md 420 / lg 560 / xl 820`, chosen to
 * fit the clusters already in the codebase. That was circular: the old widths
 * were arbitrary, so a ladder fitted to them just launders the arbitrariness.
 * `lg` was the tell — nothing had ever been 560px wide, so three dialogs got
 * widened 17% to reach a rung that existed only to make the progression look
 * tidy.
 *
 * These come from the content instead. The app is ALL MONOSPACE (--font-sans
 * and --font-mono are both Cascadia Mono, globals.css), so character advance is
 * a constant 0.6em and reading measure converts to exact pixels:
 *
 *     text-3xs 10px -> 6.0px/ch    text-xs 12px -> 7.2px/ch
 *     text-2xs 11px -> 6.6px/ch    text-sm  14px -> 8.4px/ch
 *
 * PROMPT 340 — floored by two action buttons side by side without wrapping.
 *   The widest real pair is "Close session" (13ch) + "Cancel": 13ch x 8.4 + 32px
 *   padding = 141px per button, x2 + 8px gap + 32px panel padding = 322px.
 *
 * PANEL 420 — set by reading measure for UI prose. Content is 420 - 32 = 388px:
 *   59ch at text-2xs full width, and 51ch for a description sitting beside a
 *   toggle (-48px for control + gap). Both inside the 45-75ch comfort band, and
 *   the median dialog string (measured: 54ch across 130 of them) fits one line.
 *
 * DOCUMENT 600 — set by long-form measure. Content 600 - 40 = 560px = 67ch at
 *   text-sm, which is the classic optimum. Markdown code blocks do NOT drive
 *   this: they already carry overflow-x-auto, so they scroll rather than widen
 *   the dialog.
 *
 * Each is capped at 88vw so a narrow window shrinks it rather than clipping.
 */
export const DIALOG_WIDTHS = {
  prompt: 'min(340px, 88vw)',
  panel: 'min(420px, 88vw)',
  document: 'min(600px, 88vw)',
  // WIDE 820 — a two-pane settings window (Assistant settings, questions deck
  // Q-1a 2026-09-05): a 176px page list on the left plus a page on the right
  // that must still hold a `panel`-width column of prose (388px of content) and
  // the Local models browser. 820 - 176 - padding leaves ~600px for the page,
  // which is `document` width — nothing on a page is narrower than it was in
  // the popup it came from. 92vw (not 88) because this is the one dialog that
  // is a workspace rather than a card; on a 900px-wide window it still leaves
  // 36px of scrim a side.
  wide: 'min(820px, 92vw)',
} as const;

export type DialogSize = keyof typeof DIALOG_WIDTHS;

/**
 * Height caps. No per-dialog height — the cap is a function of the SIZE.
 *
 * Two earlier versions, both wrong in different ways:
 *
 * 1. `80vh`. Wrong because it scales with the monitor: ~700px on a laptop,
 *    ~1730px on a 4K display. Not one design, a different object per screen.
 *
 * 2. A flat `min(680px, …)` for everything. Better, but it silently gave each
 *    size a DIFFERENT proportion — a 340px prompt could run 2.0x as tall as it
 *    is wide, a 420px panel 1.62x, a 600px document only 1.13x. So the one
 *    number was least appropriate exactly where dialogs are narrowest, letting
 *    them become tall thin strips. Destin called the panels too tall; that is
 *    the reason.
 *
 * The cap is now 1.4x the size's own width, so every dialog holds the same
 * proportion instead of the same pixel count:
 *
 *     prompt    340 x 1.4 = 476     panel  420 x 1.4 = 588
 *     document  600 x 1.4 = 840
 *
 * Then clamped by `calc(100vh - 6rem)` so a modal always leaves visible scrim
 * (a constant 3rem margin, not a ratio) and shrinks on a short window.
 *
 * HONEST NOTE: the 1.4 is a design judgment, not a derivation — it is roughly
 * where a dialog stops reading as a card and starts reading as a column. What
 * IS principled is tying the cap to width at all; a flat number cannot be
 * right for 340px and 600px simultaneously. Change the ratio here and all
 * three move together.
 */
export const DIALOG_MAX_HEIGHTS = {
  prompt: 'min(476px, calc(100vh - 6rem))',
  panel: 'min(588px, calc(100vh - 6rem))',
  document: 'min(840px, calc(100vh - 6rem))',
  // NOT 1.4x. The ratio above keeps portrait cards from becoming columns; a
  // two-pane window is landscape by nature, and 820 x 1148 would be taller than
  // any laptop screen — the viewport clamp would decide the height everywhere
  // and the number here would never apply. 0.85x (697 → 700) is where the
  // page list still shows all eight rows with room under them and the window
  // reads as a window, not a sheet.
  wide: 'min(700px, calc(100vh - 6rem))',
} as const;

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  /** Omit ONLY when the caller renders its own header (see `scrollBody`). */
  title?: string;
  /** Small second line under the title — e.g. About's version string. */
  subtitle?: React.ReactNode;
  /** Rendered to the LEFT of the close button — e.g. an (i) explainer button. */
  headerActions?: React.ReactNode;
  /**
   * When set, a back chevron appears left of the title. For dialogs with an
   * internal second page (Account -> Connected accounts). Same affordance
   * SettingsExplainer already offered; hand-rolled at each site before this.
   */
  onBack?: () => void;
  /**
   * L2 popup (default) or L3 critical — a destructive confirmation, which gets
   * a heavier scrim and sits above ordinary popups so it cannot be lost behind
   * the thing it is confirming.
   */
  layer?: Extract<OverlayLayer, 2 | 3>;
  /** Marks the panel destructive, which the theme uses to tint its border. */
  destructive?: boolean;
  size?: DialogSize;
  /**
   * Hold the full height instead of hugging content. For dialogs that host
   * sub-views and would otherwise resize as you navigate between them
   * (Appearance, Remote Access). This is the honest version of the fixed height
   * those two used to set: "always maximum", not an invented pixel count.
   *
   * There is no `height` or `maxHeight` prop. The cap comes from the size — a
   * per-dialog height is what made ContextPopup jump.
   */
  fill?: boolean;
  /** For callers wiring their own outside-click detection. */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Extra classes on the panel. Layout classes are owned here — prefer not to. */
  className?: string;
  /**
   * Set false when the caller owns its whole surface and supplies its own
   * scroll region (Appearance hands the panel to ThemeScreen; Remote Access
   * swaps in SettingsExplainer). Default true.
   */
  scrollBody?: boolean;
  /** Accessible name when there is no visible title. */
  'aria-label'?: string;
  children: React.ReactNode;
};

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  headerActions,
  onBack,
  layer = 2,
  destructive,
  size = 'panel',
  fill,
  panelRef,
  className = '',
  scrollBody = true,
  children,
  ...aria
}: DialogProps) {
  // Dialog owns the scroll region, so it owns the edge-fade hook too. Callers
  // used to wire their own useScrollFade at the body they supplied; leaving it
  // to them now would silently drop the fades on every migrated dialog.
  // Declared before the early return -- hooks must run unconditionally.
  const scrollRef = useScrollFade<HTMLDivElement>();

  if (!open) return null;

  return createPortal(
    <>
      <Scrim layer={layer} onClick={onClose} />
      {/* Outer wrapper centers and carries the stacking; the panel then runs at
          position:relative / z-index:auto. pointer-events-none lets clicks fall
          through to the Scrim beneath, which is what closes on outside-click. */}
      <div
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none"
        style={{ zIndex: CONTENT_Z[layer] }}
      >
        <OverlayPanel
          ref={panelRef}
          layer={layer}
          destructive={destructive}
          role="dialog"
          aria-modal={true}
          aria-label={title ?? aria['aria-label']}
          className={`w-full flex flex-col overflow-hidden pointer-events-auto ${className}`.trim()}
          style={{
            position: 'relative',
            zIndex: 'auto',
            maxWidth: DIALOG_WIDTHS[size],
            maxHeight: DIALOG_MAX_HEIGHTS[size],
            ...(fill ? { height: DIALOG_MAX_HEIGHTS[size] } : {}),
          }}
        >
          {title && (
            // h2, matching SettingsPopup. Section labels inside the body are h3
            // (K1), so an h3 title would announce them as its siblings rather
            // than its children.
            <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {onBack && (
                  <button
                    onClick={onBack}
                    aria-label="Back"
                    className="text-fg-muted hover:text-fg transition-colors w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset shrink-0"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                )}
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-fg truncate">{title}</h2>
                  {subtitle && <p className="text-3xs text-fg-muted mt-0.5">{subtitle}</p>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {headerActions}
                <CloseButton onClick={onClose} label={`Close ${title}`} />
              </div>
            </div>
          )}
          {scrollBody ? (
            // Unpadded scroll region so the fade pseudo-elements sit flush with
            // the panel edge; padding lives on the inner track.
            <div ref={scrollRef} className="scroll-fade flex-1">
              <div className="px-4 py-4 space-y-5">{children}</div>
            </div>
          ) : (
            children
          )}
        </OverlayPanel>
      </div>
    </>,
    document.body,
  );
}
