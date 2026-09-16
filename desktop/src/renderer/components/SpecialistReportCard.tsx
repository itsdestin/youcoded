import React, { useState } from 'react';
import { ChatMessage } from '../../shared/types';
import type { InjectedMeta } from '../state/chat-types';
import MarkdownContent from './MarkdownContent';
import { CheckIcon, FailIcon, ChevronIcon } from './Icons';
import { formatBubbleTime } from '../utils/format-time';

interface Props {
  message: ChatMessage;
  /** TranscriptEvent.data.injected — which host mechanism wrote this turn. */
  injected: string;
  /** Structured header (who/what/status/steps). Absent on older events and
   *  on plain host follow-up notes — the card then falls back to the prose. */
  meta?: InjectedMeta;
  sessionId: string;
  showTimestamps: boolean;
}

// The prose runNotice() injects opens with a status sentence the model needs
// ("[Background specialist finished] Kai (explorer) completed the task you
// delegated ("…", started 2m ago, 3 steps).") followed by a blank line and the
// report body. With `meta` in hand the header already says all of that, so the
// expanded body starts at the report itself; without meta the whole text is
// the body and the first line doubles as the header.
function splitPreamble(text: string): { first: string; rest: string } {
  const idx = text.indexOf('\n\n');
  if (idx === -1) return { first: text.trim(), rest: '' };
  return { first: text.slice(0, idx).trim(), rest: text.slice(idx + 2) };
}

/**
 * A host-injected user-ROLE turn (2026-08-16) — today a background
 * specialist's delivered report or a host follow-up note (harness-session.ts
 * runNotice, `injected: 'specialist-report'`). The parent model reads it as
 * its next turn, so on the wire it is a user message; but in the chat it is an
 * EVENT ("Briar finished the task"), not something anyone said. Destin (1b
 * hands-on): "these reports just shouldn't be rendering at all in chat, they
 * are intended as messages for the assistant and should only register as a
 * 'task completion' toolcard or something."
 *
 * So: a compact, COLLAPSED row in the tool-card style — status icon, "<title>
 * finished/failed", the delegated description, step count, chevron — and the
 * report body only on expand, rendered as markdown. Never the user's accent
 * bubble, never a full-width message.
 */
export default React.memo(function SpecialistReportCard({ message, injected, meta, sessionId, showTimestamps }: Props) {
  const [expanded, setExpanded] = useState(false);
  // G-1: `meta` is now a union; this card renders the SPECIALIST shape. A
  // shell-complete turn only reaches it when its Bash card is not on the
  // timeline (the reducer folds it otherwise) — then it degrades to prose.
  // A shell-running mark (2026-09-16) ALWAYS degrades to prose: it is a
  // still-running note, not a report, and has no title/status to draw.
  const spec = meta?.kind === 'shell' || meta?.kind === 'shell-running' ? undefined : meta;
  const { first, rest } = splitPreamble(message.content);
  const failed = spec ? spec.status === 'failed' : /^\[Background specialist failed\]/.test(first);
  const label = spec
    ? `${spec.title} ${failed ? 'failed' : 'finished'}`
    : (injected === 'specialist-report' ? 'Note for the assistant' : 'System message');
  // Detail: what they were asked + how long it took, when known.
  const detailParts: string[] = [];
  if (spec?.description) detailParts.push(spec.description);
  if (spec && spec.steps !== undefined) detailParts.push(`${spec.steps} step${spec.steps === 1 ? '' : 's'}`);
  if (!spec) detailParts.push(first.replace(/^\[[^\]]*\]\s*/, ''));
  const detail = detailParts.join(' · ');
  const body = spec ? (rest || first) : message.content;

  return (
    <div className="px-4 py-1" data-testid="specialist-report-card" data-injected={injected} data-status={failed ? 'failed' : 'completed'}>
      <div className="border border-edge rounded-lg overflow-hidden max-w-[85%] bg-inset/40">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
          aria-expanded={expanded}
          title={expanded ? 'Hide the report' : 'Show the report'}
        >
          {/* Fix: `danger` isn't a real CSS token (no --color-danger exists), so this
              icon rendered in plain text color instead of red on failure. `destructive-fg`
              is the app's real token for destructive/error TEXT. */}
          <span className={`shrink-0 inline-flex ${failed ? 'text-destructive-fg' : 'text-fg-muted'}`}>
            {failed ? <FailIcon className="w-3.5 h-3.5" /> : <CheckIcon className="w-3.5 h-3.5" />}
          </span>
          <span className="text-fg-faint text-xs select-none">|</span>
          <span className="text-xs font-medium text-fg-2 shrink-0">{label}</span>
          {detail && <span className="text-xs text-fg-muted truncate flex-1 min-w-0">{detail}</span>}
          <span data-testid="specialist-report-chevron" className="shrink-0 inline-flex ml-auto">
            <ChevronIcon className="w-3.5 h-3.5 text-fg-muted" expanded={expanded} />
          </span>
        </button>
        {expanded && (
          <div className="px-4 py-3 border-t border-edge-dim text-sm">
            <MarkdownContent content={body} sessionId={sessionId} />
            {showTimestamps && (
              <div className="bubble-timestamp text-4xs text-fg-muted text-right mt-1 -mb-0.5 select-none leading-none">
                {formatBubbleTime(message.timestamp)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
