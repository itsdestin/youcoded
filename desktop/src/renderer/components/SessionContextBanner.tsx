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
  const parts: string[] = [];
  if (ctx.skills?.length) parts.push(`${ctx.skills.length} skill${ctx.skills.length === 1 ? '' : 's'}`);
  if (ctx.tools?.length) parts.push(`${ctx.tools.length} tool${ctx.tools?.length === 1 ? '' : 's'}`);
  if (ctx.projectInstructions) parts.push('project instructions');
  if (ctx.droppedMcpServers?.length) parts.push(`${ctx.droppedMcpServers.length} MCP server${ctx.droppedMcpServers.length === 1 ? '' : 's'} dropped`);
  return parts.length ? parts.join(', ') : 'a fresh session';
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
      title="View the full session context — system prompt, instructions, skills, tools"
      className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
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
          ? (context.summary ?? 'Context was trimmed to fit this model’s window')
          : `Started with the full context — ${fullSummary(context)}`}
      </span>
      <span className="ml-auto shrink-0 text-3xs text-fg-dim uppercase tracking-wider">
        View
      </span>
    </button>
  );
}