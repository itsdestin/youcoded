// The "Update" affordance — shared by the marketplace card and the detail
// overlay (marketplace overhaul, Task 1).
//
// WHY this exists as its own component: until now the word "Update" was a
// decorative <span> on every card and did not appear in the detail overlay at
// all, so `mp.update()` had ZERO callers in the renderer — the main process
// could update a plugin or a theme, but no user could ask it to. Both surfaces
// need the same three behaviours, so they share one implementation:
//   1. stopPropagation — cards are themselves role="button", and without it a
//      click would ALSO open the detail overlay behind the update.
//   2. an in-progress state, so a slow git fetch doesn't look like a dead click.
//   3. the updater's REAL error text. `skills:update` / `theme:update` report
//      failures as `{ ok: false, error }` instead of throwing, so a caller that
//      ignores the result shows nothing at all.

import React, { useState } from "react";
import { useMarketplace } from "../../state/marketplace-context";
import { Button } from "../ui";

// Used only when the updater failed WITHOUT saying why. Deliberately states
// what happened and guesses no cause — see docs/error-message-standards.md.
const NO_REASON = "Update failed. No reason was reported.";

interface Props {
  /** Marketplace id for a plugin, theme slug for a theme. */
  id: string;
  kind: "skill" | "theme";
  /** `pill` for the card corner, `button` for a detail-overlay header action. */
  variant?: "pill" | "button";
}

export default function UpdateButton({ id, kind, variant = "pill" }: Props) {
  const mp = useMarketplace();
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (updating) return;
    setUpdating(true);
    setError(null);
    try {
      const result: any = await mp.update(id, kind);
      if (result && result.ok === false) setError(result.error || NO_REASON);
    } catch (err: any) {
      // The provider already surfaced this on installError; repeat it here so
      // the message sits next to the button the user actually pressed.
      setError(err?.message || NO_REASON);
    } finally {
      setUpdating(false);
    }
  };

  const label = updating ? "Updating…" : "Update";

  return (
    // stopPropagation on the wrapper too, so clicking the error text inside a
    // card doesn't open the detail overlay.
    <span
      className="inline-flex flex-col items-end gap-0.5 min-w-0"
      onClick={(e) => e.stopPropagation()}
    >
      {variant === "button" ? (
        <Button
          variant="secondary"
          size="lg"
          onClick={run}
          disabled={updating}
          title={error || undefined}
        >
          {label}
        </Button>
      ) : (
        <button
          type="button"
          onClick={run}
          disabled={updating}
          title={error || undefined}
          // Accent-tinted pill: it must read as something you can press, unlike
          // the inert "Installed" text it replaces. Tokens, not raw colours, so
          // it re-tints on every theme.
          // WHY: this is a status/action pill — normal case, no letter-spacing
          // (labels batch, guide: "Status and notices").
          className="relative z-10 shrink-0 text-3xs px-2 py-0.5 rounded-full border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {label}
        </button>
      )}
      {error && (
        <span
          role="status"
          className="text-2xs text-destructive-fg text-right leading-snug max-w-[16rem] break-words"
        >
          {error}
        </span>
      )}
    </span>
  );
}
