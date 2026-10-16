import { FIELD_SURFACE } from './field';

/**
 * Card levels (trial, 2026-09-27 — decisions.md "Card levels (the Settings
 * rule)"). Destin's rule, verbatim essence: a single line must never cross the
 * whole width of a card or popup (that's why popup headers use a TAPERED line,
 * never a full divider); every FIRST-level card on a page looks the same; every
 * card/box NESTED inside one looks the same, one level down; the next level
 * down is one style again; notices keep their own tint wherever they sit.
 *
 * Two previous trials were rejected for inventing a NEW look (`session/ui-one-
 * card`: a solid card + full-width divider lines; `session/ui-four-kinds`: every
 * setting became its own separate-looking box, destroying grouping). This trial
 * does neither — it names the shapes the app ALREADY uses most and makes every
 * card reach for one of the two, instead of hand-typing a slightly different
 * recipe per file (card-measurements.md §e/§f: this exact background string was
 * already hand-copied into FieldRow, SettingRow, ContextSettings, SessionNaming
 * and SyncPanel independently).
 *
 * LEVEL 1 — a first-level card on a page: the translucent `bg-inset/50` box
 * already used by `FieldRow`, `SettingRow` and the General page's own field
 * cards ("the glass card... the ones with the glass effect look fine" — Destin,
 * 2026-09-27), PLUS the 1px `border-edge-dim` the "before" version of this card
 * (card-measurements.md "Card B") always had (round 4, 2026-09-28 — Destin:
 * first-level cards "no longer separate from the background, esp. Meadow
 * Mist" once the border was dropped). Restoring it here fixes every level-1
 * card on every screen from one place.
 *
 * LEVEL 2 — anything nested INSIDE a level-1 card: reuses the app's existing
 * `FIELD_SURFACE` (opaque `bg-inset` + a visible `border-edge-dim`, already the
 * shared recipe behind every text field, dropdown trigger and Select). Giving a
 * nested sub-card, segmented-tab track or list row this SAME recipe is what
 * makes "everything nested looks the same" true without inventing a ninth card
 * style — it already existed, just wasn't reused for non-field nested boxes.
 */
// `surface-1` marks the level so globals.css can re-level a first-level box that
// ends up nested inside another one (see "Surface levels" there).
export const CARD_LEVEL_1 = 'surface-1 bg-inset/50 border border-edge-card rounded-lg';
export const CARD_LEVEL_2 = FIELD_SURFACE;
