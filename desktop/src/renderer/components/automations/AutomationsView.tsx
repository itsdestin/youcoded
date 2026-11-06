// Automations — the built-in page's body (pages-finish step 4, design stage).
//
// WHY a built-in page (step 4 questions, Q-home: a new main area, "the main area could probably
// be a built in page tho"): it lists, pins and opens like Office, so it needs no new top-bar
// button of its own, and a person who never uses automations is not handed a fourth main area.
//
// Layout follows Office's start screen (OfficeHome): small labels over sections on the page's
// canvas, one filled button (New automation). Order of what you see:
//   1. Waiting for you — only when something waits (Q-blocked note: "include a visual indication
//      that something … is waiting"). Each waiting run is a card with its own Allow (filled) and
//      Don't allow (outlined), the guide's "one filled per row in a list of actions".
//   2. The jobs, grouped: those standing alone first, then each page's (Q-belongs: a job may
//      belong to a page or stand alone; every job shows here either way).
// A job opens in place (AutomationEditor): its settings and its runs. Rows, not raised cards —
// a job is scanned and switched more than it is "opened" (guide: rows for lists).
import React, { useEffect, useState } from 'react';
import type { AutomationSummary } from '../../../shared/automation-types';
import { Button, CARD_LEVEL_2, EmptyState, ErrorState, LoadingState, Pill, SectionLabel, Toggle, Tooltip } from '../ui';
import { ScreenMark } from '../../shoot-mode';
import { automationsBridge, publishAutomations, refreshAutomations, useAutomations } from './use-automations';
import { OUTCOME, dollarWords, startWords, tokenWords } from './automation-words';
import { AutomationEditor, JobGlyph, blankAutomation } from './AutomationEditor';

type View = { kind: 'list' } | { kind: 'job'; id: string; tab: 'settings' | 'runs' } | { kind: 'new'; job: AutomationSummary };

// Photo-only (`shoot`): PageHost owns the screen names (this view is not mounted until the page
// opens), so it leaves the view to start on here and opens the page.
// `shoot` opens the plain `automations` screen first, so the view may already be showing: it jumps.
let startAt: View | null = null;
let jump: ((v: View) => void) | null = null;
export function openAutomationsAt(v: 'job' | 'job-runs' | 'job-subscription' | 'new'): void {
  const to: View = v === 'job' ? { kind: 'job', id: 'job-email', tab: 'settings' }
    : v === 'job-runs' ? { kind: 'job', id: 'job-money', tab: 'runs' }
    : v === 'job-subscription' ? { kind: 'job', id: 'job-tidy', tab: 'settings' }
    : { kind: 'new', job: blankAutomation() };
  if (jump) jump(to); else startAt = to;
}

export function AutomationsView({ visible }: { visible: boolean }) {
  const { jobs, loaded, failed } = useAutomations();
  // WHY cleared in an effect, not the initializer: React's strict mode runs an initializer twice, and the second would see null.
  const [view, setView] = useState<View>(() => startAt ?? { kind: 'list' });
  useEffect(() => { startAt = null; jump = setView; return () => { jump = null; }; }, []);
  // Fresh list each time the page is shown, as the Pages library does.
  useEffect(() => { if (visible) void refreshAutomations(); }, [visible]);
  if (!loaded) return <LoadingState what="automations" />;
  if (failed) return <div className="p-6 max-w-xl mx-auto"><ErrorState message="The list of automations could not be read." onRetry={() => void refreshAutomations()} /></div>;

  if (view.kind === 'job') {
    const job = jobs.find((j) => j.id === view.id);
    if (job) return <AutomationEditor job={job} tab={view.tab} onTab={(tab) => setView({ ...view, tab })} onBack={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'new') {
    return <AutomationEditor job={view.job} isNew tab="settings" onTab={() => {}} onBack={() => setView({ kind: 'list' })} />;
  }

  const waiting = jobs.filter((j) => j.waiting);
  const alone = jobs.filter((j) => j.owner.kind === 'alone');
  const byPage = new Map<string, AutomationSummary[]>();
  for (const j of jobs) {
    if (j.owner.kind !== 'page') continue;
    const list = byPage.get(j.owner.pageName) ?? [];
    list.push(j);
    byPage.set(j.owner.pageName, list);
  }
  const paid = jobs.reduce((s, j) => s + (j.subscription ? 0 : j.usage.dollars), 0);
  const subTokens = jobs.reduce((s, j) => s + (j.subscription ? j.usage.tokens : 0), 0);
  const open = (id: string) => setView({ kind: 'job', id, tab: 'settings' });

  return (
    <div className="scroll-mask absolute inset-0 overflow-y-auto">
      <ScreenMark name={jobs.length === 0 ? 'automations/first-run' : 'automations'} />
      <div className="w-full max-w-4xl mx-auto px-4 py-6 flex flex-col gap-7">
        {/* The screen's Large heading row: heading left, its one description under it, its tool right (guide "Full screens"). */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium text-fg">Automations</h2>
            <div className="text-xs text-fg-muted">
              {jobs.length === 0
                ? 'Jobs that run for you on a schedule, when something happens, or from a button on a page.'
                // Q-subscription note: "track tokens used per job by each model/harness so users can see where usage is going".
                : `This month: ${dollarWords(paid)} on paid models, ${tokenWords(subTokens)} on your Claude subscription.`}
            </div>
          </div>
          <Button variant="primary" size="sm" className="shrink-0" onClick={() => setView({ kind: 'new', job: blankAutomation() })}>New automation</Button>
        </div>

        {jobs.length === 0 && (
          <EmptyState message="No automations yet. Press New automation, or ask in any chat: &ldquo;every morning, check my spending&rdquo;." />
        )}

        {waiting.length > 0 && (
          <section className="flex flex-col gap-3" data-automations-waiting>
            <SectionLabel className="px-1">Waiting for you</SectionLabel>
            {waiting.map((j) => <WaitingCard key={j.id} job={j} onOpen={() => open(j.id)} />)}
          </section>
        )}

        {alone.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionLabel className="px-1">On their own</SectionLabel>
            <JobRows jobs={alone} onOpen={open} />
          </section>
        )}
        {[...byPage.entries()].map(([name, list]) => (
          <section key={name} className="flex flex-col gap-2">
            <SectionLabel className="px-1">On {name}</SectionLabel>
            <JobRows jobs={list} onOpen={open} />
          </section>
        ))}
      </div>
    </div>
  );
}

/** A run that stopped for a yes. What it wants, the exact thing it would send, and how long it
 *  waits — so Allow is an informed answer, not a guess (Q-blocked: nothing happens without your yes). */
function WaitingCard({ job, onOpen }: { job: AutomationSummary; onOpen: () => void }) {
  const w = job.waiting!;
  const answer = async (allow: boolean) => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.answer(job.id, allow));
  };
  return (
    <div className="bg-panel border border-edge rounded-lg p-4 flex flex-col gap-3 card-raised" data-waiting-job={job.id}>
      <div className="flex items-start gap-3">
        <JobGlyph job={job} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{w.action}</div>
          <div className="text-xs text-fg-muted">{job.name} &middot; {w.asked}</div>
        </div>
        <Pill tone="warning" dot>Waiting for you</Pill>
      </div>
      {w.detail && <div className={`${CARD_LEVEL_2} px-3 py-2 text-sm text-fg-2 whitespace-pre-wrap select-text`}>{w.detail}</div>}
      {/* Text left, buttons right on one line when they fit; at phone width the buttons share the full width (guide "Buttons"). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 text-xs text-fg-muted">{w.until}</div>
        <div className="flex items-center gap-2 max-sm:[&>*]:flex-1">
          <Button variant="secondary" size="sm" onClick={onOpen}>See the run</Button>
          <Button variant="secondary" size="sm" onClick={() => void answer(false)}>Don&rsquo;t allow</Button>
          <Button variant="primary" size="sm" onClick={() => void answer(true)}>Allow</Button>
        </div>
      </div>
    </div>
  );
}

function JobRows({ jobs, onOpen }: { jobs: AutomationSummary[]; onOpen: (id: string) => void }) {
  // Short lists (a person's own jobs); a chunked reveal comes with the real list if it can grow past 50.
  return <div className="flex flex-col">{jobs.map((j) => <JobRow key={j.id} job={j} onOpen={() => onOpen(j.id)} />)}</div>;
}

const JobRow = React.memo(function JobRow({ job, onOpen }: { job: AutomationSummary; onOpen: () => void }) {
  const last = job.lastRun;
  const setEnabled = async (on: boolean) => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.setEnabled(job.id, on));
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-automation-row={job.id}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      className="flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer text-left hover:bg-inset active:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none"
    >
      <JobGlyph job={job} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-sm truncate ${job.enabled ? 'text-fg' : 'text-fg-muted'}`}>{job.name}</span>
          {job.waiting && <Pill tone="warning" dot>Waiting for you</Pill>}
          {!job.enabled && <Pill>Paused</Pill>}
        </div>
        <div className="text-2xs text-fg-muted truncate">
          {startWords(job.start)}{job.enabled && job.next ? ` · next ${job.next.charAt(0).toLowerCase()}${job.next.slice(1)}` : ''}
        </div>
        {last && !job.waiting && (
          <div className="text-2xs text-fg-muted truncate">
            {last.when}: {last.summary}
          </div>
        )}
      </div>
      {last && !job.waiting && last.outcome !== 'done' && <Pill tone={OUTCOME[last.outcome].tone}>{OUTCOME[last.outcome].word}</Pill>}
      {/* WHY stopPropagation: the switch sits inside the row, which opens the job. */}
      <Tooltip text={job.enabled ? 'Pause' : 'Turn on'} placement="bottom">
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Toggle checked={job.enabled} onChange={(on) => void setEnabled(on)} aria-label={job.enabled ? `Pause ${job.name}` : `Turn on ${job.name}`} />
        </span>
      </Tooltip>
    </div>
  );
});
