import React, { useState } from 'react';
import { SettingRow } from './SettingRow';
import { CARD_LEVEL_1 } from './cardLevels';

/**
 * The fold-out row — anything that opens in place (a log, advanced options,
 * error details) is a boxed row like a setting, label on the left, arrow on the
 * RIGHT that turns to point down when open.
 *
 * WHY (decisions.md "Fold-out sections", `ui-element-review-settings-pieces#P-1`;
 * design guide "Settings" → "One fold-out style everywhere"): Backup & sync's
 * "› Sync log" and "▸ Show details" were bare text with the arrow on the LEFT —
 * the shape Destin said he hates ("I HATE the bare dropdowns with a chevron",
 * 2026-09-05) and rejected again in fix batch 1. The box and the right-hand
 * arrow are SettingRow's own (`expanded`), so this reuses it rather than
 * drawing a sixth row shape; what this adds is owning the open state and
 * rendering the opened content INSIDE the same box, under the row (since
 * 2026-10-07 — see the return below; it used to be a sibling under the box).
 *
 * Controlled (`open` + `onToggle`) when the caller needs to react to opening
 * (Sync log fetches its lines then), uncontrolled otherwise.
 */
export type FoldRowProps = {
  title: React.ReactNode;
  /** Optional hint under the title, like any setting row. */
  description?: React.ReactNode;
  open?: boolean;
  onToggle?: (next: boolean) => void;
  defaultOpen?: boolean;
  /** What opens under the row. Only rendered while open. */
  children: React.ReactNode;
  className?: string;
};

export function FoldRow({ title, description, open, onToggle, defaultOpen = false, children, className = '' }: FoldRowProps) {
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = open ?? inner;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInner(next);
    onToggle?.(next);
  };
  // WHY the content opens INSIDE the box (Destin, submit-ticket-1#ST-3: "an expandable card
  // should always contain expanded content within itself, not open a new separate card
  // below. we made the same mistake in our new about page"; confirmed for every fold,
  // submit-ticket-2#ST2-Q1 "all"): the row used to be the box and its content a sibling
  // under it, so opened text read as loose text or a second card. Now the box wraps both;
  // the header row drops its own box (SettingRow `header`) and the wrapper carries the same
  // look (CARD_LEVEL_1 == the setting row's box), so a closed fold looks as before:
  // py-1 here + the header's py-1 = the boxed row's py-2.
  return (
    <div className={`${CARD_LEVEL_1} px-3 py-1 ${className}`.trim()}>
      <SettingRow variant="item" header title={title} description={description} onClick={toggle} expanded={isOpen} />
      {isOpen && <div className="pt-1 pb-2">{children}</div>}
    </div>
  );
}
