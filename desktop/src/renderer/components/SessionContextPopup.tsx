import { useState } from 'react';
import { Dialog, Button } from './ui';
import { useEscClose } from '../hooks/use-esc-close';
import { FilepathToken } from './FilepathToken';
import type { SessionContext } from '../state/chat-types';

// SessionContextPopup — the session-start "what did the assistant begin with?"
// panel (Step 3, 2026-08-17, broadened from "context truncation" to "context
// transparency").
//
// Every session — local or cloud — shows this ONCE at session start, giving a
// full accounting of the context the assistant began with: the model + context
// window, a summary line, the system prompt, project instructions
// (CLAUDE.md, as-truncated), the skills and tools that were loaded, and any MCP
// servers dropped for budget. When everything was fully loaded, it says so
// plainly; when something was cut, the truncation is called out per surface.
//
// Visual hierarchy (per the accessibility standard — explainer popup, not raw
// numbers):
//   1. Model + window + one plain-language summary line
//   2. System prompt (collapsible)
//   3. Project instructions with a FilepathToken outlink to the real CLAUDE.md
//   4. Skills (each with a FilepathToken outlink to its SKILL.md)
//   5. Tools as chips
//   6. Dropped MCP servers (amber, when any)
//   7. "Manage Assistant Settings" — STUB, opens a broader management menu later
//
// TODO(plumbing): the data is claimed via the SESSION_CONTEXT reducer action
// (workbench MOCK_ONLY — see mock-only.ts). The real host channel wiring the
// actual harness facts (fitProjectInstructions / fitInjection /
// droppedMcpServers) is the Step-3 backend task.

interface Props {
  open: boolean;
  onClose: () => void;
  /** The session's starting context (from SessionChatState.sessionContext). */
  context: SessionContext | null;
  /** Session id for FilepathToken outlinks. */
  sessionId: string;
}

/** Plain-language summary when everything loaded fully. */
function fullSummary(ctx: SessionContext): string {
  const parts: string[] = [];
  if (ctx.skills?.length) parts.push(`${ctx.skills.length} skill${ctx.skills.length === 1 ? '' : 's'}`);
  if (ctx.tools?.length) parts.push(`${(ctx.tools?.length ?? 0)} tools`);
  if (ctx.projectInstructions) parts.push('project instructions');
  if (parts.length === 0) return 'Started a fresh session.';
  return `Started with the full project context — ${parts.join(', ')} loaded.`;
}

/** True when any surface was truncated or dropped. */
function wasTrimmed(ctx: SessionContext): boolean {
  if (ctx.projectInstructions?.truncated) return true;
  if (ctx.skills?.some((s) => s.truncated)) return true;
  if (ctx.droppedMcpServers?.length) return true;
  return false;
}

export default function SessionContextPopup({ open, onClose, context, sessionId }: Props) {
  useEscClose(open, onClose);

  // Collapsible sections, all open by default except the system prompt (longest).
  const [showSystem, setShowSystem] = useState(false);
  const [showSkills, setShowSkills] = useState(true);
  const [showTools, setShowTools] = useState(true);

  if (!open) return null;
  if (!context) return null;

  const trimmed = wasTrimmed(context);
  const headerLine = trimmed
    ? (context.summary ?? 'Context was trimmed to fit the model’s window.')
    : (context.summary ?? fullSummary(context));

  return (
    <Dialog
      open
      onClose={onClose}
      title="Session context"
      subtitle="What the assistant began this session with"
      size="document"
      scrollBody
    >
      {/* 1. Header — model, window, summary */}
      <section>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-fg">
            {context.modelLabel ?? 'This model'}
          </span>
          {context.contextWindowTokens != null && (
            <span className="text-3xs text-fg-muted bg-inset rounded px-1.5 py-0.5">
              {context.contextWindowTokens.toLocaleString()} token window
            </span>
          )}
          {!trimmed && (
            <span className="text-3xs text-[#4CAF50] bg-[#4CAF50]/10 rounded px-1.5 py-0.5">
              Full context loaded
            </span>
          )}
        </div>
        <p className={`mt-2 text-[12.5px] leading-relaxed ${trimmed ? 'text-[#FF9800]' : 'text-fg-2'}`}>
          {trimmed && <span className="font-medium">⚠ </span>}
          {headerLine}
        </p>
      </section>

      {/* 2. System prompt */}
      {context.systemPrompt != null && (
        <section>
          <SectionHeader
            title="System prompt"
            expanded={showSystem}
            onToggle={() => setShowSystem((v) => !v)}
            meta={context.systemPrompt.length.toLocaleString() + ' chars'}
          />
          {showSystem && (
            <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
              {context.systemPrompt}
            </pre>
          )}
        </section>
      )}

      {/* 3. Project instructions (CLAUDE.md) — truncated or not, with outlink */}
      {context.projectInstructions && (
        <section>
          <SectionHeader
            title="Project instructions"
            expanded
            onToggle={() => {}}
            meta={
              context.projectInstructions.truncated
                ? (context.projectInstructions.note ?? 'truncated')
                : 'full'
            }
          />
          <div className="mt-2 flex items-center gap-2 text-xs text-fg-2">
            <FilepathToken path={context.projectInstructions.path} sessionId={sessionId} variant="inline" label={context.projectInstructions.path} />
            {context.projectInstructions.truncated && (
              <span className="text-[#FF9800]">— read as outline</span>
            )}
          </div>
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
            {context.projectInstructions.truncated
              ? context.projectInstructions.text + '\n\n… (outlined to fit the window — open the full file above)'
              : context.projectInstructions.text}
          </pre>
        </section>
      )}

      {/* 4. Skills */}
      {context.skills && context.skills.length > 0 && (
        <section>
          <SectionHeader
            title={`Skills loaded (${context.skills.length})`}
            expanded={showSkills}
            onToggle={() => setShowSkills((v) => !v)}
          />
          {showSkills && (
            <ul className="mt-2 space-y-1">
              {context.skills.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-xs">
                  <span className="text-fg-2 shrink-0 w-3 text-center">{s.truncated ? '⚠' : '✓'}</span>
                  {s.path ? (
                    <FilepathToken path={s.path} sessionId={sessionId} variant="inline" label={s.label} />
                  ) : (
                    <span className="text-fg-2">{s.label}</span>
                  )}
                  {s.truncated && (
                    <span className="text-[#FF9800] text-2xs">({s.note ?? 'body cut'})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 5. Tools */}
      {context.tools && context.tools.length > 0 && (
        <section>
          <SectionHeader
            title={`Tools (${context.tools.length})`}
            expanded={showTools}
            onToggle={() => setShowTools((v) => !v)}
          />
          {showTools && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {context.tools.map((t) => (
                <span key={t} className="text-3xs text-fg-2 bg-inset/60 border border-edge-dim rounded-md px-2 py-0.5">
                  {t}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 6. Dropped MCP servers — the one surface that is never "fine" */}
      {context.droppedMcpServers && context.droppedMcpServers.length > 0 && (
        <section>
          <div className="text-2xs font-medium text-[#FF9800] tracking-wider uppercase mb-1.5">
            Not attached — MCP servers dropped to fit the tools budget
          </div>
          <ul className="space-y-1">
            {context.droppedMcpServers.map((server) => (
              <li key={server} className="text-xs text-fg-2 flex items-center gap-2">
                <span className="text-[#FF9800]">⛔</span> {server}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 7. Manage Assistant Settings — STUB: opens a broader management menu later */}
      <div className="border-t border-edge pt-4">
        <Button
          variant="secondary"
          size="md"
          className="w-full"
          onClick={() => {
            // TODO(Step 4+): open the broader "assistant management" surface.
            // Stubbed per Destin — present now so the affordance exists; the
            // destination is a later feature.
          }}
        >
          Manage Assistant Settings
        </Button>
        <p className="text-2xs text-fg-muted mt-1.5 leading-snug">
          Coming soon — open the full assistant settings, model, and context management.
        </p>
      </div>
    </Dialog>
  );
}

/** Consistent collapsible section label — the panel's clear-hierarchy spine. */
function SectionHeader({ title, meta, expanded, onToggle }: {
  title: string;
  meta?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 text-left group"
      aria-expanded={expanded}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 8 8"
        className={`shrink-0 text-fg-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
        aria-hidden
      >
        <path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span className="text-2xs font-medium text-fg-muted tracking-wider uppercase group-hover:text-fg-2 transition-colors">
        {title}
      </span>
      {meta && <span className="text-3xs text-fg-faint ml-auto">{meta}</span>}
    </button>
  );
}