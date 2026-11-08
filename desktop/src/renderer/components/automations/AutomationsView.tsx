// Automations — the built-in page's body (pages-finish step 4, design round 2).
//
// WHY cards (Destin, step 4 review A-list: "much closer to marketplace or command drawer styling,
// with card for individual automations (but they can keep toggles on them)"): the Library's layout —
// Large headings over a grid of raised cards — with the switch where a Library card has its star.
// A card opens Automation details (AutomationDetails.tsx), the way a Library card opens Plugin
// details: that answers "how would i manage/edit existing automations?".
//
// Copy is minimal (same review: "if two pieces of text on one screen say the same thing, one
// should be removed"). How automations work in general lives behind the one (i) by the title,
// not in lines scattered across screens (A-runs note).
import React, { useEffect, useState } from 'react';
import type { AutomationSummary } from '../../../shared/automation-types';
import { AnchorTip, Button, Callout, Chip, EmptyState, ErrorState, LoadingState, Pill, Toggle, Tooltip } from '../ui';
import { ChipRow } from '../marketplace/FactChips';
import { ScreenMark } from '../../shoot-mode';
import { automationsBridge, publishAutomations, refreshAutomations, useAutomations } from './use-automations';
import { OUTCOME, scheduleWords } from './automation-words';
import { AutomationDetails, JobGlyph, blankAutomation, type DetailsTab } from './AutomationDetails';

type Open = { job: AutomationSummary; isNew: boolean; tab: DetailsTab; atEnd?: boolean } | null;
type Pending = 'new' | { id: string; tab: DetailsTab; addMenu: boolean; atEnd?: boolean } | null;

// Photo-only (`shoot`): PageHost owns the screen names (this view mounts only once the page
// opens), so it leaves what to open here; a view already showing picks it up at once.
let startAt: Pending = null;
let jump: ((v: Pending) => void) | null = null;
export function openAutomationsAt(v: 'details' | 'runs' | 'subscription' | 'add-menu' | 'new' | 'lower'): void {
  const to: Pending = v === 'new' ? 'new'
    : { id: v === 'subscription' || v === 'lower' ? 'job-weekly' : v === 'runs' ? 'job-money' : 'job-email', tab: v === 'runs' ? 'runs' : 'settings', addMenu: v === 'add-menu', atEnd: v === 'lower' };
  if (jump) jump(to); else startAt = to;
}

export function AutomationsView({ visible }: { visible: boolean }) {
  const { jobs, loaded, failed } = useAutomations();
  const [open, setOpen] = useState<Open>(null);
  const [addMenu, setAddMenu] = useState(false);
  // WHY cleared in an effect: strict mode runs an initializer twice, and the second would see null.
  const [pending, setPending] = useState<Pending>(() => startAt);
  useEffect(() => { startAt = null; jump = setPending; return () => { jump = null; }; }, []);
  useEffect(() => { if (visible) void refreshAutomations(); }, [visible]);
  // A photo-only request resolves once the list has loaded.
  useEffect(() => {
    if (!pending || !loaded) return;
    if (pending === 'new') setOpen({ job: blankAutomation(), isNew: true, tab: 'settings' });
    else {
      const job = jobs.find((j) => j.id === pending.id);
      setAddMenu(pending.addMenu);
      if (job) setOpen({ job, isNew: false, tab: pending.tab, atEnd: pending.atEnd });
    }
    setPending(null);
  }, [pending, loaded, jobs]);

  if (!loaded) return <LoadingState what="automations" />;
  if (failed) return <div className="p-6 max-w-xl mx-auto"><ErrorState message="Your automations couldn't be read." onRetry={() => void refreshAutomations()} /></div>;

  // WHY grouped by state, not by page (round 2 B-list: "tf is 'on their own'?"): the headings are
  // plain states anyone reads at once; a job's page is a chip on its card instead.
  const waiting = jobs.filter((j) => j.waiting);
  const on = jobs.filter((j) => !j.waiting && j.enabled);
  const paused = jobs.filter((j) => !j.waiting && !j.enabled);
  const openJob = (job: AutomationSummary) => setOpen({ job, isNew: false, tab: 'settings' });
  // The open job follows the live list, so a change saved in the popup shows on its card.
  const shown = open && !open.isNew ? jobs.find((j) => j.id === open.job.id) ?? open.job : open?.job ?? null;

  return (
    <div className="scroll-mask absolute inset-0 overflow-y-auto">
      <ScreenMark name={jobs.length === 0 ? 'automations/first-run' : 'automations'} />
      <div className="w-full max-w-6xl mx-auto px-4 py-6 flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-fg">Automations</h2>
          <AnchorTip label="About automations" title="Automations" align="start" widthClass="w-80">
            Jobs that run for you on a schedule, when something happens, or from a button on a page.
            They run in YouCoded on this computer, so only while it is on. Each run is kept, and its
            conversation opens read-only from the job; runs never appear in your chats.
          </AnchorTip>
          <div className="flex-1" />
          <Button variant="primary" size="sm" onClick={() => setOpen({ job: blankAutomation(), isNew: true, tab: 'settings' })}>New automation</Button>
        </div>

        {jobs.length === 0 && <EmptyState message="No automations yet." />}

        {waiting.length > 0 && <Group label="Waiting for you" jobs={waiting} onOpen={openJob} />}
        {on.length > 0 && <Group label="On" jobs={on} onOpen={openJob} />}
        {paused.length > 0 && <Group label="Paused" jobs={paused} onOpen={openJob} />}
      </div>
      <AutomationDetails job={shown} isNew={open?.isNew ?? false} tab={open?.tab ?? 'settings'} atEnd={open?.atEnd ?? false} addMenuOpen={addMenu} onAddMenu={setAddMenu}
        onTab={(tab) => setOpen((o) => (o ? { ...o, tab } : o))} onClose={() => { setOpen(null); setAddMenu(false); }} />
    </div>
  );
}

function Group({ label, jobs, onOpen }: { label: string; jobs: AutomationSummary[]; onOpen: (j: AutomationSummary) => void }) {
  // A person's own short list; a chunked reveal comes with the real list if it can pass 50.
  return (
    <section className="flex flex-col gap-3">
      {/* The Large heading, as the Library's Favorites / Installed. */}
      <h3 className="text-base font-medium text-fg px-1">{label}</h3>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {jobs.map((j) => <AutomationCard key={j.id} job={j} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

/** One automation: the Library card's order (name and its control on the top line, one chip row,
 *  the description, a details line) with the switch in the star's place. A run waiting for you is
 *  the slim amber box inside the card (guide "Status and notices": a request waiting on the user). */
const AutomationCard = React.memo(function AutomationCard({ job, onOpen }: { job: AutomationSummary; onOpen: (j: AutomationSummary) => void }) {
  const last = job.lastRun;
  const setEnabled = async (on: boolean) => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.setEnabled(job.id, on));
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-automation-card={job.id}
      onClick={() => onOpen(job)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(job); } }}
      className="bg-panel border border-edge rounded-lg p-4 text-left flex flex-col gap-2 cursor-pointer card-interactive card-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none"
    >
      <div className="flex items-start gap-3">
        <JobGlyph job={job} />
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-sm font-medium truncate ${job.enabled ? 'text-fg' : 'text-fg-muted'}`}>{job.name}</span>
          </div>
          <div className="flex min-w-0"><ChipRow>
            {job.links.map((l) => <Chip key={l.id}>{l.name}</Chip>)}
            <Chip>{scheduleWords(job.start)}</Chip>
            <Chip>{job.model}</Chip>
          </ChipRow></div>
        </div>
        {/* WHY stopPropagation: the switch sits on the card, which opens the job. */}
        <Tooltip text={job.enabled ? 'Pause' : 'Turn on'} placement="bottom">
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Toggle checked={job.enabled} onChange={(on) => void setEnabled(on)} aria-label={job.enabled ? `Pause ${job.name}` : `Turn on ${job.name}`} />
          </span>
        </Tooltip>
      </div>
      <div className="text-xs text-fg-2 line-clamp-2">{job.instruction}</div>
      {job.waiting ? (
        <Callout tone="warning" compact>{job.waiting.action}</Callout>
      ) : last && (
        // The details line: the last run's result (only when it isn't plain Done) and its date at the
        // bottom right (guide "Cards"). What it did is in Runs, so the card doesn't repeat it.
        <div className="flex items-center gap-2 text-2xs text-fg-muted min-w-0">
          {last.outcome !== 'done' && <Pill tone={OUTCOME[last.outcome].tone}>{OUTCOME[last.outcome].word}</Pill>}
          <span className="flex-1" />
          <span className="shrink-0">{last.when}</span>
        </div>
      )}
    </div>
  );
});
