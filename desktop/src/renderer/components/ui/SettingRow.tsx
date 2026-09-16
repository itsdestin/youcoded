import React from 'react';
import { FOCUS_RING } from './Button';
import { Radio } from './Radio';

/**
 * K2 — the setting row.
 *
 * The universal row: anything with a label and a control is this. Supersedes
 * `components/SettingsRow.tsx` (which was nav-only, required an icon, and
 * hard-coded a chevron) and the five hand-rolled shapes scattered through the
 * settings family.
 *
 * THE ONE RULE that kills all five: **the description always lives in the left
 * column, under the title.** Never below the whole row (Sound), never after the
 * row (Buddy), never as a K1 section label (Session Defaults / Skip
 * Permissions), never as a separate <p> outside the container (Buddy again —
 * that popup had two different placements within itself).
 *
 * ── Two densities, selected by ROLE ────────────────────────────────────────
 *
 * The spec originally wrote one size for every row (text-xs/text-3xs), which
 * would have silently reverted change 51 — Destin's 2026-07-16 decision to take
 * the drawer rows one step UP to text-sm/text-2xs because "at 11px the
 * title/subtitle gap read as too loose".
 *
 * Both sizes are already approved, from looking at rendered UI rather than at a
 * spec: drawer rows at sm/2xs (change 51) and Sound preset rows at xs/3xs
 * (tranche 1, 2026-07-26). So the axis is not drawer-vs-in-menu, it is
 * NAVIGATION vs LIST ITEM:
 *
 *   nav   the row takes you somewhere — it opens a dialog or a sub-view
 *   item  the row is one of N being scanned, toggled, or chosen between
 *
 * This costs nothing K2 was actually buying. The five shapes it retires were
 * about where the DESCRIPTION lives, not about type size. One component, one
 * description rule, one control-slot vocabulary, two densities.
 */

export type SettingRowVariant = 'nav' | 'item';

const DENSITY: Record<SettingRowVariant, { title: string; desc: string }> = {
  nav: { title: 'text-sm', desc: 'text-2xs' },
  item: { title: 'text-xs', desc: 'text-3xs' },
};

/**
 * Geometry, shared by both densities so a nav row and an item row stack without
 * a seam. py-2 (not the spec's py-2.5) is change 51's: the taller type pays for
 * the lost padding and the row stays ~50px.
 */
// `stepped-hover` frame-budgets the hover fade — SettingsPanel renders 33 of
// these rows inside the app's largest backdrop-filter region, so a pointer
// sweep down the list keeps many fades alive at once. See globals.css.
//
// EXPORTED for the same reason Button exports `buttonClasses` and `FOCUS_RING`:
// a caller occasionally needs this surface on an element `SettingRow` itself
// cannot render. The only such caller today is Settings → Permissions, whose
// folder headers are DISCLOSURE buttons — `SettingRow` has no `aria-expanded`
// pass-through, and its `<button>` branch appends a static right-chevron that
// cannot express open/closed. Taking the string by reference keeps one
// definition; copying it is what setting-row-authority exists to stop.
export const SETTING_ROW_BASE = 'w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-inset/50 text-left transition-colors stepped-hover';

/**
 * `items-center`, always — deviating from the spec's `items-start`.
 *
 * Both approved renderings center. With items-start the chevron would sit at
 * the top-right of a two-line row instead of beside it, which is visibly worse
 * and would regress every drawer row. Rows whose description runs to several
 * lines (Preferences' per-turn metadata) center the control against the block,
 * which is what the shipped Buddy "pin above other windows" row already does.
 */

export type SettingRowProps = {
  title: React.ReactNode;
  /** Always renders under the title, in the left column. Never anywhere else. */
  description?: React.ReactNode;
  /** Optional. `nav` rows reserve a 32x20 box so titles align down the list. */
  icon?: React.ReactNode;
  variant?: SettingRowVariant;
  /**
   * Exactly one of: <Toggle> · <Button size="sm"> · a `value` (below). Omit on a
   * navigating row — the chevron is implied by `onClick`.
   */
  control?: React.ReactNode;
  /** Right-aligned read-only value. Shorthand for the value control slot. */
  value?: React.ReactNode;
  /** Sits between the text column and the control — e.g. Backup & Sync's badge. */
  accessory?: React.ReactNode;
  /**
   * Whole-row click. Renders a <button> with a chevron, so the row must not
   * contain another interactive element — pass `control` or `onSelect` instead
   * for rows that do. Nested buttons are invalid HTML and break keyboard focus.
   */
  onClick?: () => void;
  /**
   * Radio-list row (K3's "any option needs a description" form): renders a
   * <Radio> in the icon slot and makes the whole tile the hit target. The row
   * stays a <div> because the Radio is the tab stop — you should not have to
   * aim at the 14px circle. Pair with <RadioGroup> for arrow-key navigation.
   */
  selected?: boolean;
  onSelect?: () => void;
  /** Roving tabindex from RadioGroup — 0 for the selected option, -1 otherwise. */
  radioTabIndex?: number;
  /**
   * Clip the title to one line instead of wrapping. Off by default because row
   * titles are authored copy and should stay readable — turn it on only where
   * the title is user data of unbounded length (a chosen sound file's name).
   */
  truncateTitle?: boolean;
  /** Accessible name for the radio when the title is not a plain string. */
  radioLabel?: string;
  disabled?: boolean;
  /**
   * Expand-in-place row (2026-09-05, Destin: "I HATE the bare dropdowns with a
   * chevron"). The ONE shape for a section that opens below its row: the same
   * right-hand chevron every navigating row has, turned to point down while
   * open, plus aria-expanded. Never a leading "›" text toggle.
   */
  expanded?: boolean;
  /** Overrides the muted description color — e.g. Android's green "Connected". */
  descriptionClassName?: string;
  className?: string;
};

export function SettingRow({
  title,
  description,
  icon,
  variant = 'nav',
  control,
  value,
  accessory,
  onClick,
  selected,
  onSelect,
  radioTabIndex,
  radioLabel,
  truncateTitle,
  expanded,
  disabled,
  descriptionClassName,
  className = '',
}: SettingRowProps) {
  const d = DENSITY[variant];
  // A row is a <button> only when nothing inside it is focusable. Everything
  // else stays a <div> and lets its own control carry the semantics.
  const isButton = !!onClick && !control && !value && !onSelect;
  // Hover + pointer follow the HIT TARGET, not the element type: a control row
  // that also takes a whole-row click is just as clickable as a nav row, and
  // gating this on `isButton` would have left those two rows looking inert.
  const clickable = !!onClick || !!onSelect;
  const hover = clickable && !disabled ? ' hover:bg-inset cursor-pointer' : '';

  const label = typeof title === 'string' ? title : undefined;

  const body = (
    <>
      {onSelect !== undefined && (
        <Radio
          checked={!!selected}
          onChange={onSelect}
          tabIndex={radioTabIndex}
          aria-label={radioLabel ?? label}
          disabled={disabled}
        />
      )}
      {icon &&
        (variant === 'nav' ? (
          // Fixed box so every title in a nav list starts at the same x, whatever
          // each icon's intrinsic width is.
          <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
            {icon}
          </div>
        ) : (
          <div className="shrink-0 flex items-center">{icon}</div>
        ))}
      <div className="flex-1 min-w-0">
        <div className={`${d.title} text-fg font-medium ${truncateTitle ? 'truncate' : ''}`} title={label}>
          {title}
        </div>
        {description && (
          // -mt-0.5 is change 51's: the default gap read as too loose once the
          // title grew. `truncate` on nav only — nav subtitles are one-liners by
          // design, in-menu descriptions are explanatory and must wrap.
          <p
            className={`${d.desc} -mt-0.5 ${variant === 'nav' ? 'truncate' : ''} ${descriptionClassName ?? 'text-fg-muted'}`}
          >
            {description}
          </p>
        )}
      </div>
      {accessory}
      {value !== undefined && (
        <span className={`${d.title} text-fg-dim font-mono shrink-0`}>{value}</span>
      )}
      {control &&
        (onClick ? (
          // A control row can still take a whole-row click — that is what the
          // <label> wrappers around the Remote Access toggles used to buy. The
          // control must not let its own click bubble back up to the row, or
          // clicking the toggle would fire the handler twice and land back where
          // it started.
          <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
            {control}
          </span>
        ) : (
          control
        ))}
      {isButton && (
        <svg
          className={`w-4 h-4 text-fg-muted shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
    </>
  );

  const cls = `${SETTING_ROW_BASE}${hover} ${disabled ? 'opacity-50' : ''} ${className}`.trim();

  if (isButton) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} aria-expanded={expanded} className={`${cls} ${FOCUS_RING}`}>
        {body}
      </button>
    );
  }

  // `disabled` has to actually block the handler, not just dim the row. The
  // <button> branch above gets that from the DOM attribute; a <div> does not,
  // so a disabled control row would still fire on click while looking inert.
  // Found by K6: the saved-devices row disables itself while a connection is in
  // flight, and without this you could start a second one mid-connect.
  return (
    <div className={cls} onClick={disabled ? undefined : (onSelect ?? onClick)}>
      {body}
    </div>
  );
}
