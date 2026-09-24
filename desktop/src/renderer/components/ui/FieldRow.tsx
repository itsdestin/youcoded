import React from 'react';

/**
 * A wide control's label: title + hint above, the control full width below.
 *
 * WHY promoted here from assistant-settings/pages.tsx (fix batch 1, 2026-09-24
 * — design guide "Settings" → "Small controls … sit beside … Wide controls …
 * go below", decisions.md's setting-row-layout rule SA-1): the shape already
 * existed as a local `FieldRow` used only on Assistant settings' General page
 * (Default model, Default project folder, Step guard) — Remote Access's
 * Password field and every other "a text box needs a label and a hint" site
 * hand-rolled a slightly different shape instead (settings-screens.md's
 * candidate rule 1). One shared primitive, same recipe, so the next wide
 * control reaches for this instead of inventing a sixth shape.
 *
 * Pairs with `SettingRow`, which owns the OTHER half of SA-1 — a small control
 * (switch, small button) beside the title+hint, on the right.
 */
export function FieldRow({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5 space-y-1.5">
      <div>
        <p className="text-xs font-medium text-fg">{title}</p>
        <p className="text-3xs text-fg-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}
