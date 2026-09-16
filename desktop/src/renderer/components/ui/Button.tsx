import React from 'react';

/**
 * The one button. Every button in the app goes through this — never hand-roll
 * `bg-accent text-on-accent` (design rule 1).
 *
 * Before this existed the renderer had ~15 button treatments across ~50 files:
 * 5 radii, 4 hover idioms, a hardcoded-blue family, and ~80% with no focus ring.
 *
 * Recipes below are the ones approved 2026-07-16 — see
 * docs/active/specs/2026-07-16-ui-consistency-design-spec.md §1.1. Each was an
 * explicit pick among rendered alternatives; the rejected ones are noted so they
 * don't get reintroduced as "improvements".
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'on-accent' | 'raised';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl' | 'icon' | 'icon-sm' | 'icon-xs';

/** The one focus ring — every interactive control shares it (design rule 4),
 *  so it lives here and Toggle/Checkbox/Radio/Select/SegmentedTabs import it.
 *
 *  The canvas offset was challenged post-approval: it's a solid fill, so on a
 *  panel or popup surface it paints a canvas-colored halo rather than a
 *  transparent gap, and no such ring existed anywhere in the codebase before.
 *  Destin reviewed both variants rendered in a real popup footer on 2026-07-16
 *  and KEPT the offset — the halo is known and accepted. Don't "fix" it.
 *  Community custom_css focus styles still override by specificity, on purpose:
 *  packs keep that power. */
export const FOCUS_RING =
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';

/** Always applied.
 *  rounded-lg is the one control radius (12px built-in / 24px on big-radius
 *  packs, since --radius-lg is a theme token). Rejected: sm, md, full-everywhere.
 *  Pills survive only as a documented exception (first-run hero CTAs), as the
 *  xl size — which is why a size may replace the base radius and weight (see
 *  buttonClasses). */
const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-colors ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  FOCUS_RING;

/** Hover is ALWAYS a background fade toward the surface — the label stays crisp.
 *  Rejected: `hover:brightness-110` (invisible on Light/Crème's near-black accent)
 *  and `hover:opacity-90` (fades the label too, and on glow themes like Halftone
 *  the fill fades out from under the theme's own box-shadow glow).
 *
 *  danger uses text-on-destructive, NOT text-white: --destructive is
 *  pack-overridable with no contrast guard, so hardcoded white can go
 *  white-on-pale. The engine derives the label color per theme.
 *
 *  danger-outline's LABEL uses text-destructive-fg while its border/hover-tint
 *  stay on --destructive. Those are two different jobs: the border sits on the
 *  panel as a fill, the label has to be readable text on that panel. On dark
 *  themes --destructive is too dark to read as text — no single red satisfies
 *  both roles at AA across our themes, which is why the token is split. */
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent/90',
  secondary: 'border border-edge-dim text-fg-2 hover:bg-inset',
  ghost: 'text-fg-dim hover:text-fg hover:bg-inset',
  danger: 'bg-destructive text-on-destructive hover:bg-destructive/90',
  'danger-outline': 'border border-destructive/50 text-destructive-fg hover:bg-destructive/10',
  // ghost, but for a control sitting ON an accent-filled surface (ViewToggleHint's
  // ✕). Added 2026-09-04: ghost there was wrong twice over — its hover fill is
  // --inset, a panel colour that reads as a foreign patch on accent, and its
  // hover TEXT is --fg, which on Light's near-black accent turns the glyph
  // black-on-black. Both roles derive from --on-accent instead, so the whole
  // control tracks whatever a theme pack sets the accent to.
  'on-accent': 'text-on-accent/80 hover:text-on-accent hover:bg-on-accent/15',
  // A small control that sits ON a picture or chip (the × on an attachment
  // thumbnail): a solid panel fill and outline so it stays visible over any image.
  // Added 2026-09-16 — the attachment chip hand-restyled a ghost button into this.
  raised: 'bg-panel border border-edge text-fg-2 hover:bg-edge',
};

/** sm  — inline row actions (EngineCard, provider rows, chips)
 *  md  — forms, popup footers, most actions
 *  lg  — page-level CTAs (sign-in, marketplace hero)
 *  xl  — the first-run sign-in pills: the one documented pill exception, so its
 *      radius and weight REPLACE the base ones (rounded-full, semibold). Added
 *      2026-09-16; five buttons hand-set exactly these classes before it existed.
 *  icon— icon-only square; aria-label is required by the type signature
 *  icon-sm — the same, on a chip-height bar where a 28px square would set the
 *      bar's height instead of sitting inside it (ViewToggleHint). The glyph
 *      shrinks with it, so the rounded hover fill still reads as a container
 *      around the glyph rather than a tile behind it.
 *  icon-xs — a 16px round glyph button on a thumbnail or chip (attachment ×).
 *      Visually tiny, so it always gets the touch-size hit area below. */
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'text-2xs px-2.5 py-1',
  md: 'text-xs px-3 py-1.5',
  lg: 'text-sm px-4 py-2',
  xl: 'text-base px-6 py-3 font-semibold rounded-full',
  icon: 'w-7 h-7 p-0',
  'icon-sm': 'w-5 h-5 p-0',
  'icon-xs': 'w-4 h-4 p-0 rounded-full text-3xs leading-none',
};

/** sm (~22px tall) and icon (28px) are under the ~44dp touch guideline, and this
 *  renderer is also the Android UI. `.coarse-hit` expands the tap target on
 *  touch devices only — no visual change. See globals.css. */
const NEEDS_COARSE_HIT: ReadonlySet<ButtonSize> = new Set<ButtonSize>(['sm', 'icon', 'icon-sm', 'icon-xs']);

type NativeButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

type CommonProps = NativeButtonProps & {
  variant?: ButtonVariant;
};

/** Icon buttons have no text, so aria-label isn't optional — the type enforces
 *  what a lint rule otherwise would (design rule 16). */
type SizeProps =
  | { size?: Exclude<ButtonSize, 'icon' | 'icon-sm' | 'icon-xs'> }
  | { size: 'icon' | 'icon-sm' | 'icon-xs'; 'aria-label': string };

export type ButtonProps = CommonProps & SizeProps;

/**
 * Utility groups where a caller's className must REPLACE the base rather than
 * pile on next to it.
 *
 * This is not optional politeness — Tailwind resolves two competing utilities by
 * CSS SOURCE ORDER, not by the order you list them in the class attribute, and
 * the order is Tailwind's, not ours. Measured in our own bundle: `.rounded-full`
 * is emitted at 26057 and `.rounded-lg` at 26104, so `<Button className="rounded-full">`
 * silently renders ROUNDED-LG. Same trap for `.text-base` (51062) vs `.text-sm`
 * (51252). The spec's documented pill exception (change 7: "first-run hero CTAs
 * keep rounded-full + their own larger padding via className override") would
 * have quietly produced rounded rectangles.
 *
 * The usual fix is tailwind-merge. This is a deliberately tiny stand-in: we own
 * every class in BUTTON_BASE/VARIANT/SIZE, so we only need to resolve the few
 * groups we actually emit, and adding a dependency for that is not worth it.
 * Patterns match RAW tokens, so variant-prefixed classes (`hover:bg-inset`,
 * `disabled:opacity-50`) never match and are always kept.
 */
const CONFLICT_GROUPS: readonly RegExp[] = [
  /^rounded(-|$)/,
  // Fix (ROADMAP L173): DISPLAY. Tailwind v4 emits `.hidden` BEFORE
  // `.inline-flex`, so `<Button className="hidden sm:inline-flex">` never hid —
  // the base `inline-flex` won at every width and the phone-width "Esc · Back
  // to chat" hint rendered anyway (Marketplace header, 2026-08-27). With the
  // group, a caller's display token REPLACES the base one; `sm:inline-flex`
  // is variant-prefixed, never matches, and is kept — it re-applies at ≥640px
  // from its own (later) media-query rule. Anchored so `flex-1`/`grid-cols-*`
  // stay sizing tokens, not display ones.
  /^(hidden|block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents)$/,
  // Font SIZE only — must not swallow text-on-accent / text-fg-2 (colors).
  /^text-(4xs|3xs|2xs|xs|sm|base|lg|xl)$/,
  // Fix: split padding into per-axis groups. The old single /^p[xytrbl]?-/
  // group treated px- and py- as interchangeable, so a caller passing
  // className="px-8" (wider horizontal padding) silently DROPPED the size's
  // py-2 — buttons rendered at text height with no vertical padding. Hit the
  // welcome-screen CTAs (App.tsx "New Session"/"Resume Session") and
  // SyncPanel's Save button. Regression pinned by Button.test.tsx.
  /^px-/,
  /^py-/,
  /^pt-/,
  /^pr-/,
  /^pb-/,
  /^pl-/,
  /^w-/,
  /^h-/,
  /^gap-/,
  /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/,
];

/** Returns the conflict groups a single class token belongs to. The p-N
 *  shorthand sets padding on all four sides, so it belongs to every padding
 *  group — overriding it must beat base px-/py-/pt-/etc., and vice versa. */
function groupsFor(token: string): RegExp[] {
  if (/^p-\d/.test(token)) return CONFLICT_GROUPS.filter((re) => re.source.startsWith('^p'));
  const g = CONFLICT_GROUPS.find((re) => re.test(token));
  return g ? [g] : [];
}

/** Drops base tokens whose group the caller has overridden, then appends theirs. */
export function mergeClasses(base: string, override: string): string {
  const overrides = override.split(/\s+/).filter(Boolean);
  if (overrides.length === 0) return base;

  const overrideGroups = new Set(overrides.flatMap(groupsFor));

  const kept = base
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const groups = groupsFor(token);
      if (groups.length === 0) return true;
      return !groups.some((g) => overrideGroups.has(g));
    });

  return [...kept, ...overrides].join(' ');
}

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className = '',
): string {
  // WHY the size is merged over base+variant instead of simply appended: Tailwind
  // picks between two competing classes by CSS source order, not class order, so a
  // size carrying its own radius or weight (xl's rounded-full / font-semibold,
  // icon-xs's rounded-full) would otherwise lose to the base rounded-lg /
  // font-medium and silently render wrong. Sizes without those classes are unaffected.
  const base = mergeClasses(
    `${BUTTON_BASE} ${BUTTON_VARIANT[variant]}`,
    [BUTTON_SIZE[size], NEEDS_COARSE_HIT.has(size) ? 'coarse-hit' : ''].filter(Boolean).join(' '),
  );

  return mergeClasses(base, className).trim();
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', className = '', type, ...rest },
  ref,
) {
  const size = (rest as { size?: ButtonSize }).size ?? 'md';
  const { size: _omit, ...domProps } = rest as NativeButtonProps & { size?: ButtonSize };

  return (
    <button
      ref={ref}
      // Default to "button" so a Button inside a <form> can't accidentally submit it.
      // Callers that DO want submit pass type="submit" explicitly.
      type={type ?? 'button'}
      className={buttonClasses(variant, size, className)}
      {...domProps}
    />
  );
});
