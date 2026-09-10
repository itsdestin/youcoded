import { FOCUS_RING } from './ui/Button';
import type { SessionContext } from '../state/chat-types';
import { wasTrimmed } from './session-context-facts';

// SessionContextBanner — the always-visible strip at the top of a session's
// timeline that summarizes its STARTING context (Step 3, 2026-08-17, broadened
// from "context truncation" to "context transparency").
//
// Every session shows one — including a session that started with everything
// intact, because a missing line cannot be told apart from a broken app. It says
// what the assistant was handed, or goes amber when something was left out.
// Pressing anywhere on it opens SessionContextPopup.
//
// The dismissible design from v1 (2026-08-17) is GONE, and so is dismissal
// itself: this is not a one-off notice but the only way back into the
// accounting, so there is nothing to dismiss. The popup's × closes the popup.

interface Props {
  context: SessionContext;
  /** Opens SessionContextPopup. */
  onOpen: () => void;
}

function fullSummary(ctx: SessionContext): string {
  // WHY plain nouns, not "context": Destin's 2026-09-09 review — users should be able to
  // tell what the strip means without knowing the word. It names what the assistant was
  // handed: this project's rules, N skills, N tools.
  const parts: string[] = [];
  if (ctx.projectInstructions) parts.push('this project’s rules');
  if (ctx.skills?.length) parts.push(`${ctx.skills.length} skill${ctx.skills.length === 1 ? '' : 's'}`);
  if (ctx.tools?.length) parts.push(`${ctx.tools.length} tool${ctx.tools.length === 1 ? '' : 's'}`);
  // The strip appears even when nothing extra was given (review-5 Q-2,
  // "always-show"): its absence would otherwise be ambiguous between "nothing was
  // given" and "the app failed to report", and the panel stays reachable.
  if (parts.length === 0) return 'Started with no extra instructions';
  const last = parts.pop();
  return parts.length ? `Started with ${parts.join(', ')} and ${last}` : `Started with ${last}`;
}

export function SessionContextBanner({ context, onOpen }: Props) {
  const trimmed = wasTrimmed(context);

  // WHY a dot rather than a tick or a warning glyph (Destin, review-5 G-3:
  // "remove the checkmark. improve the button"): dot-plus-text is the app's own
  // badge shape (design guide G-14), the same one the panel's own rows use, so
  // the strip and the panel it opens agree. A ✓/⚠ pair was two glyphs from
  // nowhere else in the app.
  //
  // The strip is now the ONLY way into the panel — review-5 Q-1 chose "never"
  // for opening by itself — so the amber state is load-bearing: it is the only
  // thing on screen that says something was left out.
  // THE WHOLE ROW IS THE BUTTON (Destin, 2026-09-10: "i want the whole row thing
  // to be a clickable button that opens the popup"). Which forces the shape of
  // everything below it: a <button> may not contain another interactive element,
  // so "Details" CANNOT be a real <Button> any more — it would be a control
  // inside a control, which browsers treat inconsistently and screen readers
  // announce as two things when there is one.
  //
  // So Details keeps the look and gives up the mechanism: a plain <span> wearing
  // the secondary recipe, lighting up with the row through `group-hover`. This is
  // the same trade ThemeShareSheet already makes for its <a> styled as a button
  // (see NOT_CALLOUTS in callout-authority.test.tsx). The focus ring is the
  // primitive's own export, not a copy, so keyboard focus still looks like every
  // other control in the app.
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left cursor-pointer transition-colors ${FOCUS_RING} ${
        trimmed
          ? 'border-amber-500/40 bg-amber-500/10 text-fg-2 hover:bg-amber-500/15'
          : 'border-edge-dim bg-inset/50 text-fg-2 hover:bg-inset'
      }`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${trimmed ? 'bg-amber-500' : 'bg-green-500'}`} aria-hidden />
      <span className="text-xs leading-snug min-w-0 flex-1">
        {trimmed
          ? 'This model’s context window is small, so some rules and skills were left out'
          : fullSummary(context)}
      </span>
      {/* No border (Destin, 2026-09-10). The box was the last thing making this
          look like a target of its own, which it no longer is — the row is. What
          remains is a label that brightens with the row, so it still reads as
          "there is more behind this" without pretending to be pressable.
          The fill and radius went with the border: an unbordered chip whose
          hover tint matched the row's own would have been invisible anyway.
          aria-hidden so the row is announced as one thing, not two. */}
      <span aria-hidden className="shrink-0 px-2 text-2xs font-medium text-fg-2 transition-colors group-hover:text-fg">
        Details
      </span>
    </button>
  );
}