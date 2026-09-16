import { useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { useSpecialistSummary, type SpecialistSummary, type HelperView, type AskSegment } from '../hooks/useSpecialists';
import { SpecialistAskBlock } from './specialists/SpecialistAskBlock';
import { SpecialistActions } from './specialists/SpecialistActions';
import { RunStatusLine } from './specialists/RunStatusLine';
import { AgentSections } from './tool-views/ToolBody';
import { friendlyToolDisplay } from './ToolCard';
import { Dialog, Tooltip } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { CheckIcon, FailIcon, QuestionIcon, StoppedIcon } from './Icons';

/**
 * Specialists 1c — the status-bar chip (spec §6 "attention, not vigilance")
 * and the management popup behind it (Destin, round 1: an ask buried inside a
 * Task card is impossible to navigate — the card still shows it, but THIS is
 * where a session's helpers are managed).
 *
 * Round 4 (Destin: "cards with clear hierarchy, useful and intuitive"): one
 * card per helper, top to bottom in the order a person asks the questions —
 * WHO (name, role, what it may do, model) → WHAT (the job) → HOW FAR (elapsed,
 * steps, the tool it is on right now, the last few things it did) → WHAT IT
 * NEEDS (the ask, tinted, with the real buttons) → WHAT YOU CAN DO (note /
 * stop / show in chat). Finished cards swap the progress strip for a report
 * preview. Grouped Needs you → Working → Finished.
 */
export default function SpecialistsChip({ sessionId }: { sessionId: string | null | undefined }) {
  const summary = useSpecialistSummary(sessionId ?? undefined);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  if (summary.helpers.length === 0) return null;

  const { needsYou, working, finished, noun } = summary;
  // Destin (2026-09-05): a Claude Code session says "subagents", because that
  // is the word Claude Code uses for them in its own output — one chip meaning
  // one thing beats one word used two ways. Native hires stay "specialists".
  const plural = `${noun}s`;
  const Noun = noun === 'subagent' ? 'Subagents' : 'Specialists';
  const label = needsYou > 0
    ? `${needsYou} need${needsYou === 1 ? 's' : ''} you`
    : working > 0
      ? `${working} ${working === 1 ? noun : plural}`
      : `${finished} finished`;
  const tooltip = needsYou > 0
    ? `${needsYou} ${noun} ask${needsYou === 1 ? '' : 's'} waiting on you — click to answer`
    : working > 0
      ? `${working} ${working === 1 ? noun : plural} working — click to manage`
      : `${Noun} finished in the background — click to see`;

  return (
    <>
      <Tooltip text={tooltip}>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
        style={needsYou > 0
          // Amber = the same "waiting on you" tone the permission chip family uses.
          ? { backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.4)' }
          : { backgroundColor: 'var(--inset)', color: 'var(--fg-muted)', borderColor: 'var(--edge-dim)' }}
        aria-label={tooltip}
        data-testid="specialists-chip"
      >
        {needsYou > 0 ? <QuestionIcon className="w-3 h-3" /> : working > 0 ? <BrailleSpinner size="xs" /> : <CheckIcon className="w-3 h-3" />}
        <span>{label}</span>
      </button>
      </Tooltip>
      {open && (
        <Dialog
          open
          title={Noun}
          onClose={() => setOpen(false)}
          subtitle={[
            needsYou > 0 ? `${needsYou} waiting on you` : null,
            working > 0 ? `${working} working` : null,
            finished > 0 ? `${finished} finished` : null,
          ].filter(Boolean).join(' · ')}
          size="document"
        >
          <SpecialistManager summary={summary} sessionId={sessionId ?? undefined} onJump={() => setOpen(false)} />
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase px-1 pt-1 pb-1.5';

function SpecialistManager({ summary, sessionId, onJump }: { summary: SpecialistSummary; sessionId?: string; onJump: () => void }) {
  const groups: Array<{ id: HelperView['group']; label: string }> = [
    { id: 'needs-you', label: 'Needs you' },
    { id: 'working', label: 'Working' },
    { id: 'finished', label: 'Finished' },
  ];
  return (
    <div className="space-y-4">
      {groups.map(g => {
        const items = summary.helpers.filter(h => h.group === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id}>
            <h3 className={SECTION_LABEL}>{g.label}</h3>
            <div className="space-y-2">
              {items.map(h => <HelperCard key={h.run.childId} h={h} sessionId={sessionId} onJump={onJump} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Status pill — the one word that answers "what state is this helper in". */
function StatusPill({ h }: { h: HelperView }) {
  const base = 'inline-flex items-center gap-1 text-3xs font-medium px-1.5 py-0.5 rounded-full border';
  if (h.group === 'needs-you') return <span className={`${base} border-amber-500/40 text-amber-500 bg-amber-500/10`}><QuestionIcon className="w-3 h-3" />Needs you</span>;
  // Green, not blue (Destin, 2026-09-05 deck note). The session pills in the
  // header are this app's status vocabulary — StatusDot.tsx STATUS_LABEL reads
  // green: 'Working', blue: 'Response Ready' — so a blue "Working" pill here
  // said the OPPOSITE of the colour he reads on every session all day.
  //
  // The WORD stays on a theme text colour and the green lives in the ring and
  // tint, which is SessionStrip's STATUS_PILL pattern and for the same measured
  // reason: #4CAF50 as text over this pill's own fill measures 1.97:1 on light,
  // 1.81:1 on creme and 1.50:1 on meadow-mist (floor is 4.5:1). Green text
  // passes only on the three dark themes. Do not "fix" this back to
  // text-green-400 — re-measure first.
  if (h.run.status === 'running') return <span className={`${base} border-green-400/40 text-fg bg-green-400/15`}><BrailleSpinner size="xs" />{h.run.stale ? 'May be stuck' : 'Working'}</span>;
  if (h.run.status === 'interrupted') return <span className={`${base} border-edge text-fg-muted`}><StoppedIcon className="w-3 h-3" />Stopped</span>;
  // Fix: `danger` was never a real token (no --color-danger anywhere in globals.css,
  // confirmed by building the stylesheet and finding zero `danger` output) — this
  // pill rendered with NO color at all. `destructive` is the app's real semantic
  // token for this state (see globals.css comment above --color-destructive-fg).
  if (h.run.status === 'failed' || h.tool.specialistReport?.status === 'failed') return <span className={`${base} border-destructive/40 text-destructive-fg bg-destructive/10`}><FailIcon className="w-3 h-3" />Failed</span>;
  return <span className={`${base} border-edge text-fg-muted`}><CheckIcon className="w-3 h-3" />Finished</span>;
}

function HelperCard({ h, sessionId, onJump }: { h: HelperView; sessionId?: string; onJump: () => void }) {
  const { run, tool } = h;
  const first = run.title.split(' ')[0];
  const done = h.group === 'finished';
  const jump = () => { jumpToCard(h.parentToolCallId); onJump(); };
  const attention = h.group === 'needs-you';

  return (
    <div
      className={`rounded-lg border ${attention ? 'border-amber-500/40' : 'border-edge'} bg-inset/50 overflow-hidden ${done ? 'opacity-80' : ''}`}
      data-testid={`helper-card-${run.childId}`}
    >
      {/* ── WHO / WHAT / HOW FAR ─────────────────────────────────────────── */}
      <div className="px-3 pt-2.5 pb-2 space-y-1.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="min-w-0 flex-1 text-2xs text-fg-muted leading-snug">
            {/* The name is the link to the card — dotted underline says "out-link"
                (Destin, round 7); no separate Show-in-chat button. */}
            <Tooltip text="Show this helper's card in the conversation">
            <button
              type="button"
              onClick={jump}
              className="text-sm font-semibold text-fg text-left align-baseline underline decoration-dotted decoration-fg-muted underline-offset-2 hover:decoration-fg"
            >
              {run.title}
            </button>
            </Tooltip>
            {/* No role tag: "Wren the Whistling Worker" already says worker (Destin, round 8). */}
            {/* A CC subagent has no model line (Claude Code does not report which
                model ran it), so its TYPE — Explore / Plan / general-purpose —
                takes that slot: with `description` used as the name above, the
                type is what tells two same-shaped helpers apart. */}
            {h.agentTypeLabel && h.agentTypeLabel !== run.title ? ` · ${h.agentTypeLabel}` : ''}
            {run.model ? ` · on ${run.model.label}` : ''}
            {run.background && run.status === 'running' ? ' · in the background' : ''}
          </div>
          {/* Top-right: Note / Stop while running, else the status pill. */}
          {/* Send-a-note / Stop go through the `specialists:*` channels, which
              only the native engine implements — a CC subagent gets the status
              pill instead. Offering dead buttons is worse than offering none. */}
          {run.status === 'running' && sessionId && h.kind === 'native'
            ? <div className="shrink-0"><SpecialistActions sessionId={sessionId} run={run} compact /></div>
            : !attention && <StatusPill h={h} />}
        </div>
        {run.description && <div className="text-xs text-fg-2">{run.description}</div>}
        <RunStatusLine run={run} report={tool.specialistReport} elapsedUnknown={h.elapsedUnknown} />
        {/* The chat card's own Briefing / Activity / Report sections, verbatim
            (Destin, round 9: one representation of a helper's work). Ask
            buttons inside Activity are suppressed — the band below has them. */}
        <AgentSections tool={tool} sessionId={sessionId} suppressAsk accordion />
      </div>

      {/* ── WHAT IT NEEDS — the bottom of the card, request and buttons on
             one line (Destin, round 6). */}
      {h.asks.map(seg => {
        const { label } = friendlyToolDisplay(segToTool(seg));
        const subject = askSubject(seg.input);
        return (
          <div key={seg.requestId} className="border-t border-amber-500/30 bg-amber-500/[0.06] px-3 py-2" data-testid="helper-card-ask">
            <SpecialistAskBlock
              segment={seg}
              sessionId={sessionId}
              specialistName={first}
              // Task 12: the popup already has this helper's run record (`run`,
              // destructured from `h` above) — pass its status straight through
              // so the held-ask line can tell a finished helper apart from a
              // running one.
              runStatus={run.status}
              compact
              leading={
                <div className="text-xs leading-snug">
                  <span className="font-medium text-fg">{first} wants to: </span>
                  <span className="text-fg-2">{label}</span>
                  {subject && subject !== label && <div className="text-2xs font-mono text-fg-dim break-all">{subject}</div>}
                </div>
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** The exact thing being approved, in full — a command, a path, a URL — not
 *  the card's abbreviated "· cache/" detail. */
function askSubject(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function segToTool(seg: AskSegment) {
  return { toolUseId: seg.toolUseId, toolName: seg.toolName, input: seg.input, status: seg.status };
}

/** Scroll the launching Task card into view and flash it. ToolCard stamps
 *  `data-tool-use-id` on its root for exactly this. */
export function jumpToCard(toolUseId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('specialist-jump-flash');
  setTimeout(() => el.classList.remove('specialist-jump-flash'), 1600);
}
