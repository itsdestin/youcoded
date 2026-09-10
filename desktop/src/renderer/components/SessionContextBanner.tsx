import { Button } from './ui';
import type { SessionContext } from '../state/chat-types';
import { wasTrimmed } from './session-context-facts';

// SessionContextBanner — the always-visible strip at the top of a session's
// timeline that summarizes its STARTING context (Step 3, 2026-08-17, broadened
// from "context truncation" to "context transparency").
//
// Every session shows one: "Full context loaded — 4 skills, 8 tools, project
// instructions" when everything fit, or the amber "Context was trimmed" line
// when something was cut. Clicking it opens SessionContextPopup — the full
// accounting (system prompt, CLAUDE.md as-truncated, skills, tools, dropped
// MCP servers, Manage Assistant Settings).
//
// The dismissible design from v1 (2026-08-17) is GONE: this is not a one-off
// notice, it is a persistent affordance — the user can always reopen the
// accounting. Dismissal still hides the strip for the session; the popup's
// × closes only the popup.

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
  return (
    <div
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
        trimmed
          ? 'border-amber-500/40 bg-amber-500/10 text-fg-2'
          : 'border-edge-dim bg-inset/50 text-fg-2'
      }`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${trimmed ? 'bg-amber-500' : 'bg-green-500'}`} aria-hidden />
      <span className="text-xs leading-snug min-w-0 flex-1">
        {trimmed
          ? 'This model’s context window is small, so some rules and skills were left out'
          : fullSummary(context)}
      </span>
      <Button variant="secondary" size="sm" onClick={onOpen} className="shrink-0">
        Details
      </Button>
    </div>
  );
}