import React, { useState } from 'react';
import { SettingRow } from './SettingRow';

/**
 * The fold-out row — anything that opens in place (a log, advanced options,
 * error details) is a boxed row like a setting, label on the left, arrow on the
 * RIGHT that turns to point down when open.
 *
 * WHY (decisions.md "Fold-out sections", `ui-element-review-settings-pieces#P-1`;
 * design guide "Settings" → "One fold-out style everywhere"): Backup & Sync's
 * "› Sync log" and "▸ Show details" were bare text with the arrow on the LEFT —
 * the shape Destin said he hates ("I HATE the bare dropdowns with a chevron",
 * 2026-09-05) and rejected again in fix batch 1. The box and the right-hand
 * arrow are SettingRow's own (`expanded`), so this reuses it rather than
 * drawing a sixth row shape; what this adds is owning the open state and
 * rendering the opened content directly under the row — a sibling, not a box
 * inside the row's box.
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
  return (
    <div className={className}>
      <SettingRow variant="item" title={title} description={description} onClick={toggle} expanded={isOpen} />
      {/* 6px under the row — the guide's gap between settings rows. */}
      {isOpen && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
