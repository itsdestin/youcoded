// Automation details — one automation's popup, opened from its card (pages-finish step 4, round 2).
//
// WHY the detail-page shape (guide "Detail pages"; Destin, A-list: "how would i manage/edit
// existing automations?"): a card opens a popup titled by kind, like Plugin details — the subject
// in the top card (name, switch, chips, Run now), then labelled cards in two columns.
//
// Round 2 copy rules, from Destin's review of round 1:
//   - Labels are statements, never questions (A-job: "headers, and labels, should be statements,
//     not questions or open-ended curiosity statements"): Instruction, Schedule, Permissions…
//   - One container per thing (A-runs: "a single concept/item/run/button should always have its
//     own container"): each permission and each run is its own box.
//   - No explanations of how it works on the screens (A-runs): that is the (i) on the page title.
// Settings save as you change them (guide "Popups"); a new automation is kept apart until Create.
import React, { useEffect, useState } from 'react';
import type { AutomationRun, AutomationStart, AutomationSummary, AutomationTool } from '../../../shared/automation-types';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Callout, Chip, LoadingState, Menu, MenuItem, MenuNote, MenuRadioItem, Pill, PillButton, SectionLabel, SegmentedTabs, Select, SettingRow, Textarea, TextInput, Toggle, Tooltip } from '../ui';
import { Dialog } from '../ui/Dialog';
import ModelPicker, { type ModelChoice } from '../model/ModelPicker';
import { ChipRow } from '../marketplace/FactChips';
import { PageGlyph } from '../pages/page-icons';
import { automationsBridge, publishAutomations } from './use-automations';
import { OUTCOME, dollarWords, scheduleWords, tokenWords } from './automation-words';

export type DetailsTab = 'settings' | 'runs';

export function blankAutomation(): AutomationSummary {
  return {
    id: `job-new-${Date.now()}`, name: '', instruction: '',
    owner: { kind: 'alone' }, start: { kind: 'schedule', every: 'day', at: '9:00' },
    model: 'Claude Sonnet', subscription: true, tools: [],
    whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run',
    notify: { needs: true, news: true, fails: true }, limit: 5, enabled: true,
    usage: { dollars: 0, tokens: 0 },
  };
}

// WHY the app's own model picker (round 2 B-sub: "use the same model selector used on other
// surfaces"; A-sub: "the underlying engine for any automation should be easily interchangeable"):
// a job names a model, nothing else depends on which service runs it; changing it only changes
// how it is paid for, so only the Spending card follows. Design stage: the job keeps the label.
function choiceOf(model: string): ModelChoice | null {
  const alias = /^Claude (\w+)/.exec(model)?.[1]?.toLowerCase();
  return alias ? { runtime: 'claude', alias } : null;
}

const PAGES = [
  { value: 'alone', label: 'None' },
  { value: 'page-money', label: 'Money', icon: 'money' as const },
  { value: 'page-recipes', label: 'Recipe notes', icon: 'notes' as const },
  { value: 'page-weekly-briefing', label: 'Weekly briefing', icon: 'notes' as const },
];

export function AutomationDetails({ job, isNew, tab, onTab, onClose, addMenuOpen, onAddMenu }: {
  job: AutomationSummary | null; isNew: boolean; tab: DetailsTab; onTab: (t: DetailsTab) => void; onClose: () => void;
  addMenuOpen: boolean; onAddMenu: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<AutomationSummary | null>(job);
  useEffect(() => { setDraft(job); }, [job]);
  const change = (patch: Partial<AutomationSummary>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!isNew) { const b = automationsBridge(); if (b) void b.save(next).then(publishAutomations); }
  };
  const create = async () => {
    const b = automationsBridge();
    if (b && draft) publishAutomations(await b.save({ ...draft, name: draft.name.trim() || 'New automation' }));
    onClose();
  };
  return (
    <Dialog screen="automations/details" open={job !== null} onClose={onClose} size="wide" title={isNew ? 'New automation' : 'Automation details'}
      footer={isNew ? <Button variant="primary" className="w-full py-2.5" onClick={() => void create()}>Create</Button> : undefined}>
      {draft && (
        <div className="flex flex-col gap-4" data-automation-details={draft.id}>
          <TopCard job={draft} isNew={isNew} onChange={change} />
          {!isNew && (
            // The Library's tab strip (round 2 B-details: "i still dont love … the settings/runs toggle").
            <SegmentedTabs variant="pill" value={tab} onChange={(t) => onTab(t as DetailsTab)}
              tabs={[{ id: 'settings', label: 'Settings' }, { id: 'runs', label: <>Runs <span className="text-fg-muted text-2xs">{draft.lastRun ? 6 : 0}</span></> }]} />
          )}
          {tab === 'runs' && !isNew ? <Runs job={draft} /> : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 items-start">
              <div className="flex flex-col gap-4">
                <Group label="Instruction">
                  <Textarea rows={4} value={draft.instruction} placeholder="Check yesterday's spending and tell me if anything looks unusual." onChange={(e) => change({ instruction: e.target.value })} aria-label="Instruction" />
                </Group>
                <Group label="Schedule"><StartField start={draft.start} onChange={(start) => change({ start })} /></Group>
                <Group label="Permissions">
                  <ToolsField tools={draft.tools} onChange={(tools) => change({ tools })} menuOpen={addMenuOpen} onMenu={onAddMenu} />
                </Group>
              </div>
              <div className="flex flex-col gap-4">
                <Group label="Page">
                  <Select value={draft.owner.kind === 'page' ? draft.owner.pageId : 'alone'} options={PAGES.map(({ value, label }) => ({ value, label }))}
                    onChange={(v) => { const p = PAGES.find((x) => x.value === v)!; change({ owner: v === 'alone' ? { kind: 'alone' } : { kind: 'page', pageId: v, pageName: p.label, pageIcon: p.icon ?? 'notes' } }); }} />
                </Group>
                <Group label="Model">
                  <ModelPicker value={choiceOf(draft.model)} runsOn="host" emptyLabel={draft.model} triggerClassName=""
                    onSelect={(c, label) => change({ model: label?.model ?? draft.model, subscription: c.runtime === 'claude' || /chatgpt/i.test(label?.provider ?? ''), limit: draft.limit ?? 5 })} />
                </Group>
                {/* A new job on a plan has nothing used yet and no limit, so the card would say nothing. */}
                {!(isNew && draft.subscription) && <Group label={draft.subscription ? 'Usage' : 'Spending'}><SpendField job={draft} onLimit={(limit) => change({ limit })} /></Group>}
                <Group label="Approvals">
                  <SegmentedTabs variant="nested" value={draft.whenAsk} onChange={(v) => change({ whenAsk: v as 'wait' | 'skip' })}
                    tabs={[{ id: 'wait', label: 'Wait for me' }, { id: 'skip', label: 'Skip and continue' }]} />
                  {draft.whenAsk === 'wait' && (<>
                    <Field label="Wait up to">
                      <Select value={draft.waitHours === null ? 'next' : String(draft.waitHours)} onChange={(v) => change({ waitHours: v === 'next' ? null : Number(v) })}
                        options={[{ value: 'next', label: 'Its next run' }, { value: '1', label: '1 hour' }, { value: '4', label: '4 hours' }, { value: '12', label: '12 hours' }, { value: '24', label: '24 hours' }]} />
                    </Field>
                    <Field label="Then">
                      <Select value={draft.noAnswer} onChange={(v) => change({ noAnswer: v as AutomationSummary['noAnswer'] })}
                        options={[{ value: 'skip', label: 'Skip that step' }, { value: 'stop', label: 'Stop the run' }, { value: 'fallback', label: 'Do something else' }]} />
                    </Field>
                    {draft.noAnswer === 'fallback' && <Textarea value={draft.fallback ?? ''} placeholder="Save the reply as a draft." onChange={(e) => change({ fallback: e.target.value })} aria-label="Instead" />}
                  </>)}
                </Group>
                {draft.start.kind !== 'button' && (
                  <Group label="Missed runs">
                    <Select value={draft.late} onChange={(v) => change({ late: v as AutomationSummary['late'] })}
                      options={[{ value: 'run', label: 'Run once when the computer wakes' }, { value: 'skip', label: 'Skip them' }, { value: 'fallback', label: 'Run differently' }]} />
                    {draft.late === 'fallback' && <Textarea value={draft.lateFallback ?? ''} placeholder="Only look at today." onChange={(e) => change({ lateFallback: e.target.value })} aria-label="When late" />}
                  </Group>
                )}
                <Group label="Notifications">
                  <SettingRow variant="item" title="Needs me"
                    control={<Toggle checked={draft.notify.needs} onChange={(v) => change({ notify: { ...draft.notify, needs: v } })} aria-label="Needs me" />} />
                  <SettingRow variant="item" title="Has news"
                    control={<Toggle checked={draft.notify.news} onChange={(v) => change({ notify: { ...draft.notify, news: v } })} aria-label="Has news" />} />
                  <SettingRow variant="item" title="Fails or reaches its limit"
                    control={<Toggle checked={draft.notify.fails} onChange={(v) => change({ notify: { ...draft.notify, fails: v } })} aria-label="Fails or reaches its limit" />} />
                </Group>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The subject card (no label above it): name, its switch, the chip row, then a waiting run as the
 *  amber notice with its answer buttons inside, and Run now full width at the foot. */
function TopCard({ job, isNew, onChange }: { job: AutomationSummary; isNew: boolean; onChange: (p: Partial<AutomationSummary>) => void }) {
  const answer = async (allow: boolean) => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.answer(job.id, allow));
  };
  const runNow = async () => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.runNow(job.id));
  };
  return (
    <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-3`}>
      <div className="flex items-start gap-3">
        <JobGlyph job={job} />
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          {isNew
            ? <TextInput value={job.name} placeholder="Name" onChange={(e) => onChange({ name: e.target.value })} aria-label="Name" />
            : <div className="flex items-center gap-2"><span className="text-base font-semibold text-fg leading-snug break-words">{job.name}</span>{!job.enabled && <Pill>Paused</Pill>}</div>}
          <div className="flex min-w-0"><ChipRow>
            {job.owner.kind === 'page' && <Chip>{job.owner.pageName}</Chip>}
            <Chip>{scheduleWords(job.start)}</Chip>
            <Chip>{job.model}</Chip>
          </ChipRow></div>
        </div>
        {/* Round 2 B-new: no switch while creating — Create turns it on. */}
        {!isNew && <Tooltip text={job.enabled ? 'Pause' : 'Turn on'} placement="bottom">
          <span><Toggle checked={job.enabled} onChange={(on) => onChange({ enabled: on })} aria-label={job.enabled ? 'Pause' : 'Turn on'} /></span>
        </Tooltip>}
      </div>
      {job.waiting && (
        <Callout tone="warning" actionsPlacement="below"
          actions={<>
            <Button variant="secondary" size="sm" onClick={() => void answer(false)}>Don&rsquo;t allow</Button>
            <Button variant="primary" size="sm" onClick={() => void answer(true)}>Allow</Button>
          </>}>
          <div className="flex flex-col gap-2">
            <span>{job.waiting.action}</span>
            {job.waiting.detail && <div className={`${CARD_LEVEL_2} px-3 py-2 text-xs text-fg-2 whitespace-pre-wrap select-text`}>{job.waiting.detail}</div>}
          </div>
        </Callout>
      )}
      {!isNew && <Button variant="secondary" className="w-full" onClick={() => void runNow()}>Run now</Button>}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>{children}</div>
    </section>
  );
}

/** A named field: the name above the control (guide "Text and numbers"). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><div className="text-xs text-fg-2">{label}</div>{children}</div>;
}

function StartField({ start, onChange }: { start: AutomationStart; onChange: (s: AutomationStart) => void }) {
  return (<>
    <SegmentedTabs variant="nested" value={start.kind}
      onChange={(k) => onChange(k === 'schedule' ? { kind: 'schedule', every: 'day', at: '9:00' } : k === 'event' ? { kind: 'event', event: 'An email arrives in Gmail' } : { kind: 'button', label: 'Run' })}
      tabs={[{ id: 'schedule', label: 'Time' }, { id: 'event', label: 'Event' }, { id: 'button', label: 'Button' }]} />
    {start.kind === 'schedule' && (
      <div className="flex items-center gap-2">
        <Select className="flex-1" value={start.every === 'hour' && (start.hours ?? 1) > 1 ? 'hours' : start.every}
          onChange={(v) => onChange(v === 'hours' ? { kind: 'schedule', every: 'hour', hours: 3 } : { kind: 'schedule', every: v as 'hour' | 'day' | 'weekday' | 'week', at: start.at ?? '9:00', day: start.day })}
          options={[{ value: 'hour', label: 'Hourly' }, { value: 'hours', label: 'Every 3 hours' }, { value: 'day', label: 'Daily' }, { value: 'weekday', label: 'Weekdays' }, { value: 'week', label: 'Weekly' }]} />
        {start.every === 'week' && (
          <Select className="w-32" value={start.day ?? 'Monday'} onChange={(day) => onChange({ ...start, day })}
            options={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ value: d, label: d }))} />
        )}
        {start.every !== 'hour' && <TextInput className="w-24" value={start.at ?? ''} onChange={(e) => onChange({ ...start, at: e.target.value })} aria-label="Time" />}
      </div>
    )}
    {start.kind === 'event' && (
      <Select value={start.event} onChange={(event) => onChange({ kind: 'event', event })}
        options={['An email arrives in Gmail', 'A file appears in a folder', 'A page’s information changes', 'A bug report arrives'].map((v) => ({ value: v, label: v }))} />
    )}
    {start.kind === 'button' && (
      <Field label="Button text"><TextInput value={start.label} onChange={(e) => onChange({ kind: 'button', label: e.target.value })} aria-label="Button text" /></Field>
    )}
  </>);
}

// The Add menu, grouped by where a permission comes from (step 4 review Q-add, drawn this round:
// "hard to visualize what you're asking"). Only connected services are listed.
const ADDABLE: { group: string; items: { label: string; source: string; exact?: string }[] }[] = [
  { group: 'This page', items: [{ label: 'Read its information', source: 'This page' }, { label: 'Change its information', source: 'This page' }] },
  { group: 'Gmail', items: [{ label: 'Read your email', source: 'Gmail' }, { label: 'Write a draft reply', source: 'Gmail' }, { label: 'Send an email', source: 'Gmail' }] },
  { group: 'Your computer', items: [{ label: 'See the files in a folder…', source: 'Your computer' }, { label: 'Move files within a folder…', source: 'Your computer' }, { label: 'Run one command…', source: 'Your computer' }] },
  { group: 'Internet', items: [{ label: 'Visit one website…', source: 'Internet' }, { label: 'Send you a notification', source: 'YouCoded' }] },
];

/** Each permission is its own box (one container per thing), with its two-way switch and its bin. */
function ToolsField({ tools, onChange, menuOpen, onMenu }: { tools: AutomationTool[]; onChange: (t: AutomationTool[]) => void; menuOpen: boolean; onMenu: (o: boolean) => void }) {
  const [sites, setSites] = useState<'never' | 'ask'>('never');
  const [commands, setCommands] = useState<'never' | 'ask'>('never');
  const add = (label: string, source: string) => onChange([...tools, { id: `t-${Date.now()}`, label, source, mode: 'ask' }]);
  // Photo-only state opens with the menu open; bring it into view so its picture shows the menu.
  const menuRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { if (menuOpen) menuRef.current?.scrollIntoView({ block: 'center' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on open only
  return (<>
    {tools.map((t) => (
      <div key={t.id} className={`${CARD_LEVEL_2} flex items-center gap-2 px-3 py-2`} data-automation-tool={t.id}>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg truncate">{t.label}</div>
          <div className="text-2xs text-fg-muted truncate">{t.exact ?? t.source}</div>
        </div>
        <ModeMenu mode={t.mode} name={t.label}
          onMode={(m) => onChange(tools.map((x) => (x.id === t.id ? { ...x, mode: m } : x)))}
          onRemove={() => onChange(tools.filter((x) => x.id !== t.id))} />
      </div>
    ))}
    <div ref={menuRef}><Menu open={menuOpen} onOpenChange={onMenu} label="Add a permission" className="min-w-72"
      trigger={<Button variant="secondary" className="w-full" onClick={() => onMenu(!menuOpen)}>Add a permission</Button>}>
      {ADDABLE.map((g) => (
        <React.Fragment key={g.group}>
          <MenuNote><span className="text-2xs text-fg-muted">{g.group}</span></MenuNote>
          {g.items.map((i) => <MenuItem key={i.label} onSelect={() => add(i.label.replace(/…$/, ''), i.source)}>{i.label}</MenuItem>)}
        </React.Fragment>
      ))}
    </Menu></div>
    <SettingRow variant="item" title="Other websites" control={<UnlistedMenu value={sites} name="Other websites" onChange={setSites} />} />
    <SettingRow variant="item" title="Other commands and files" control={<UnlistedMenu value={commands} name="Other commands and files" onChange={setCommands} />} />
  </>);
}

/** Round 2 B-add ("these allow/ask toggles … don't seem to match the styling used for similar elements
 *  elsewhere"): a state you change is the shared status pill that opens a small menu (`PillButton` +
 *  `Menu`, guide "Lists and menus": a few choices dropping from a pill), with Remove as its last row. */
function ModeMenu({ mode, name, onMode, onRemove }: { mode: 'allow' | 'ask'; name: string; onMode: (m: 'allow' | 'ask') => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen} align="right" label={name}
      trigger={<PillButton tone={mode === 'allow' ? 'ok' : 'warning'} open={open} onClick={() => setOpen((o) => !o)} aria-label={`${name}: ${mode === 'allow' ? 'Always allowed' : 'Asks first'}`}>{mode === 'allow' ? 'Always allowed' : 'Asks first'}</PillButton>}>
      <MenuRadioItem checked={mode === 'allow'} onSelect={() => onMode('allow')}>Always allowed</MenuRadioItem>
      <MenuRadioItem checked={mode === 'ask'} onSelect={() => onMode('ask')}>Asks first</MenuRadioItem>
      <MenuItem onSelect={onRemove}>Remove</MenuItem>
    </Menu>
  );
}

function UnlistedMenu({ value, name, onChange }: { value: 'never' | 'ask'; name: string; onChange: (v: 'never' | 'ask') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen} align="right" label={name}
      trigger={<PillButton open={open} onClick={() => setOpen((o) => !o)} aria-label={`${name}: ${value === 'never' ? 'Never' : 'Asks first'}`}>{value === 'never' ? 'Never' : 'Asks first'}</PillButton>}>
      <MenuRadioItem checked={value === 'never'} onSelect={() => onChange('never')}>Never</MenuRadioItem>
      <MenuRadioItem checked={value === 'ask'} onSelect={() => onChange('ask')}>Asks first</MenuRadioItem>
    </Menu>
  );
}

function SpendField({ job, onLimit }: { job: AutomationSummary; onLimit: (n: number) => void }) {
  // A subscription run costs nothing extra, so it has no money limit; its use is still counted.
  if (job.subscription) return <div className="text-sm text-fg">{tokenWords(job.usage.tokens)} <span className="text-xs text-fg-muted">this month</span></div>;
  const limit = job.limit ?? 5;
  // One setting row (round 2 B-details: "i still dont love the styling of the spending limit box"):
  // the limit at the right, what's used under the title.
  return (
    <SettingRow variant="item" title="Monthly limit" description={`${dollarWords(job.usage.dollars)} used`}
      control={<div className="flex items-center gap-1"><span className="text-xs text-fg-2">$</span>
        <TextInput className="w-16" inputMode="decimal" value={String(limit)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onLimit(n); }} aria-label="Monthly limit in dollars" /></div>} />
  );
}

function Runs({ job }: { job: AutomationSummary }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  useEffect(() => {
    let live = true;
    const b = automationsBridge();
    void (b ? b.runs(job.id) : Promise.resolve([])).then((r) => { if (live) setRuns(r); });
    return () => { live = false; };
  }, [job.id]);
  if (runs === null) return <LoadingState what="runs" variant="inline" />;
  if (runs.length === 0) return <div className="text-xs text-fg-muted">No runs yet.</div>;
  return (
    // One box per run (A-runs: "each day should probably be its own clearly divided subcard").
    <div className="flex flex-col gap-2">
      {runs.map((r) => (
        <div key={r.id} className={`${CARD_LEVEL_1} p-3 flex flex-col gap-1.5`} data-automation-run={r.id}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{r.when}</span>
            <Pill tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].word}</Pill>
            <div className="flex-1" />
            {r.tokens > 0 && <span className="text-2xs text-fg-muted">{r.dollars !== undefined ? `${dollarWords(r.dollars)} · ` : ''}{tokenWords(r.tokens)}</span>}
          </div>
          {/* The summary and its one action share a line (guide "Buttons": text left, buttons right). */}
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-xs text-fg-2">{r.summary}</div>
            {r.tokens > 0 && <Button variant="secondary" size="sm" className="shrink-0">Open conversation</Button>}
          </div>
          {r.skipped?.map((s) => <Callout key={s} tone="warning" compact>{s}</Callout>)}
        </div>
      ))}
    </div>
  );
}

/** What starts the job, as its icon: a clock, a bolt for an event, the page's own glyph for a button. */
export function JobGlyph({ job }: { job: AutomationSummary }) {
  const icon = job.start.kind === 'button' && job.owner.kind === 'page' ? job.owner.pageIcon : job.start.kind === 'event' ? 'automation' : 'timer';
  return (
    <span aria-hidden="true" className="shrink-0 w-9 h-9 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-2">
      <PageGlyph icon={icon} className="w-5 h-5" />
    </span>
  );
}
