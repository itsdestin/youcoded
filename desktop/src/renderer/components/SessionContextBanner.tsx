import type { SessionContext } from '../state/chat-types';

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
  if (parts.length === 0) return 'Started with no extra instructions';
  const last = parts.pop();
  return parts.length ? `Started with ${parts.join(', ')} and ${last}` : `Started with ${last}`;
}

function wasTrimmed(ctx: SessionContext): boolean {
  return !!(
    ctx.projectInstructions?.truncated
    || ctx.skills?.some((s) => s.truncated)
    || (ctx.droppedMcpServers && ctx.droppedMcpServers.length > 0)
  );
}

export function SessionContextBanner({ context, onOpen }: Props) {
  const trimmed = wasTrimmed(context);

  return (
    <button
      type="button"
      onClick={onOpen}
      title="See everything the assistant was given for this chat"
      className={`group w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
        trimmed
          ? 'border-[#FF9800]/40 bg-[#FF9800]/10 hover:bg-[#FF9800]/15 text-fg-2'
          : 'border-edge-dim bg-inset/50 hover:bg-inset text-fg-2'
      }`}
    >
      <span className={`shrink-0 text-xs ${trimmed ? 'text-[#FF9800]' : 'text-fg-dim'}`}>
        {trimmed ? '⚠' : '✓'}
      </span>
      <span className="text-xs leading-snug min-w-0">
        {trimmed
          ? 'This model’s context window is small, so some rules and skills were left out'
          : fullSummary(context)}
      </span>
      {/* WHY the hover colour and no font-medium: "Details" borrows the section-label type
          treatment but it is an ACTION, not a heading over a group — the same family as
          "Copy"/"Clear". section-label-authority.test.ts enforces that distinction, and a
          heading-weight spelling here would fail it. */}
      <span className="ml-auto shrink-0 text-3xs text-fg-dim uppercase tracking-wider group-hover:text-fg transition-colors">
        Details
      </span>
    </button>
  );
}