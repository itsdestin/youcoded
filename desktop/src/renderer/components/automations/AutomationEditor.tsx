// One automation, opened from the Automations page: its settings (the "full builder view",
// Q-make note) and its runs (Q-runs: one line per run, the whole conversation read-only).
//
// Every group below is one answer from the step 4 questions deck, and the theme of all of them
// was "per job, with sensible defaults":
//   What it does            the instruction (Q-make: written in chat or here).
//   When it runs            schedule / something happens / a page button.
//   What it may do          one row per tool, each its own Always allow / Ask first (Q-blocked
//                           note: "always allowed to read emails, ask before writing emails, run
//                           this exact command without asking, and that's it"), plus the broader
//                           settings he asked for, for anything not listed.
//   If it needs your OK     wait or skip (Q-blocked: per job); how long it waits and what it does
//                           with no answer (Q-wait-long: "set ways to proceed … after expiry").
//   If it's late            run once on waking / skip / something else (Q-asleep: per job).
//   Tell me                 three switches (Q-tell: needs you, news, fails; "customizable per job").
//   Model and money         a $5 monthly limit to start (Q-limit); a subscription job has no money
//                           limit but its use is still counted (Q-subscription note).
// Settings save as you change them (guide "Popups and side panels"): no Save on an existing job.
// A new one has one action, Turn on, because nothing should start running half set up.
import React, { useEffect, useState } from 'react';
import type { AutomationRun, AutomationStart, AutomationSummary, AutomationTool } from '../../../shared/automation-types';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Chip, LoadingState, Pill, ProgressBar, SectionLabel, SegmentedTabs, Select, SettingRow, Textarea, TextInput, Toggle, Tooltip } from '../ui';
import { TrashIcon } from '../project-view/icons';
import { ScreenMark } from '../../shoot-mode';
import { automationsBridge, publishAutomations } from './use-automations';
import { OUTCOME, dollarWords, startWords, tokenWords } from './automation-words';
import { PageGlyph } from '../pages/page-icons';

export function blankAutomation(): AutomationSummary {
  return {
    id: `job-new-${Date.now()}`, name: 'New automation', instruction: '',
    owner: { kind: 'alone' }, start: { kind: 'schedule', every: 'day', at: '9:00' },
    model: 'Claude Sonnet', subscription: true, tools: [],
    whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run',
    notify: { needs: true, news: true, fails: true }, limit: 5, enabled: false,
    usage: { dollars: 0, tokens: 0 },
  };
}

const MODELS = [
  { value: 'Claude Sonnet', label: 'Claude Sonnet (your subscription)', sub: true },
  { value: 'Claude Haiku', label: 'Claude Haiku (your subscription)', sub: true },
  { value: 'GPT-5 mini', label: 'GPT-5 mini (OpenRouter)', sub: false },
  { value: 'Gemini Flash', label: 'Gemini Flash (OpenRouter)', sub: false },
];

export function AutomationEditor({ job: initial, isNew = false, tab, onTab, onBack }: {
  job: AutomationSummary; isNew?: boolean; tab: 'settings' | 'runs'; onTab: (t: 'settings' | 'runs') => void; onBack: () => void;
}) {
  // A new job is edited locally until Turn on; an existing one saves each change at once.
  const [draft, setDraft] = useState(initial);
  useEffect(() => { if (!isNew) setDraft(initial); }, [initial, isNew]);
  const job = draft;
  const change = (patch: Partial<AutomationSummary>) => {
    const next = { ...job, ...patch };
    setDraft(next);
    if (!isNew) { const b = automationsBridge(); if (b) void b.save(next).then(publishAutomations); }
  };
  const turnOn = async () => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.save({ ...job, enabled: true }));
    onBack();
  };
  const runNow = async () => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.runNow(job.id));
  };

  return (
    <div className="scroll-mask absolute inset-0 overflow-y-auto">
      <ScreenMark name={isNew ? 'automations/new' : tab === 'runs' ? 'automations/job-runs' : job.subscription ? 'automations/job-subscription' : 'automations/job'} />
      <div className="w-full max-w-5xl mx-auto px-4 py-6 flex flex-col gap-6">
        {/* Way back, then the job's own top card: its name, what starts it, and its switches. */}
        <div><Button variant="ghost" size="sm" onClick={onBack}>&lsaquo; Automations</Button></div>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-3`}>
          <div className="flex items-start gap-3">
            <JobGlyph job={job} />
            <div className="min-w-0 flex-1 flex flex-col gap-1.5">
              {isNew
                ? <TextInput value={job.name} onChange={(e) => change({ name: e.target.value })} aria-label="Name" />
                : <div className="text-base font-semibold text-fg leading-snug break-words">{job.name}</div>}
              <div className="flex items-center gap-1.5 overflow-x-auto scroll-mask-x">
                <Chip>{job.owner.kind === 'page' ? `On ${job.owner.pageName}` : 'On its own'}</Chip>
                <Chip>{startWords(job.start)}</Chip>
                <Chip>{job.model}</Chip>
              </div>
            </div>
            {!isNew && (
              <div className="shrink-0 flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void runNow()}>Run now</Button>
                <Tooltip text={job.enabled ? 'Pause' : 'Turn on'} placement="bottom">
                  <span><Toggle checked={job.enabled} onChange={(on) => change({ enabled: on })} aria-label={job.enabled ? 'Pause' : 'Turn on'} /></span>
                </Tooltip>
              </div>
            )}
          </div>
          {job.waiting && (
            <div className="flex items-center gap-2 text-xs text-fg-2"><Pill tone="warning" dot>Waiting for you</Pill><span className="truncate">{job.waiting.action}</span></div>
          )}
        </div>

        {!isNew && (
          <SegmentedTabs value={tab} onChange={(id) => onTab(id as 'settings' | 'runs')}
            tabs={[{ id: 'settings', label: 'Settings' }, { id: 'runs', label: 'Runs' }]} />
        )}

        {tab === 'runs' && !isNew ? <Runs job={job} /> : (
          // Two columns on a wide window: what it does on the left, how it behaves on the right.
          <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 items-start">
            <div className="flex flex-col gap-4">
              <Group label="What it does">
                <Textarea rows={4} value={job.instruction} placeholder="What should it do each time it runs?" onChange={(e) => change({ instruction: e.target.value })} aria-label="What it does" />
                <div className="text-xs text-fg-muted">Written like a message to the assistant. Easier still: describe it in any chat and the assistant fills this in.</div>
              </Group>
              <Group label="When it runs">
                <StartField start={job.start} onChange={(start) => change({ start })} />
                <FieldLabel>Belongs to</FieldLabel>
                <Select value={job.owner.kind === 'page' ? job.owner.pageId : 'alone'}
                  options={[{ value: 'alone', label: 'Nothing: on its own' }, { value: 'page-money', label: 'Money' }, { value: 'page-recipes', label: 'Recipe notes' }, { value: 'page-weekly-briefing', label: 'Weekly briefing' }]}
                  onChange={(v) => change({ owner: v === 'alone' ? { kind: 'alone' } : { kind: 'page', pageId: v, pageName: v === 'page-money' ? 'Money' : v === 'page-recipes' ? 'Recipe notes' : 'Weekly briefing', pageIcon: v === 'page-money' ? 'money' : 'notes' } })} />
                <div className="text-xs text-fg-muted">A page&rsquo;s jobs show on that page and in its settings, and share its spending limit. Every job is listed here either way.</div>
              </Group>
              <Group label="What it may do">
                <ToolsField tools={job.tools} onChange={(tools) => change({ tools })} />
              </Group>
            </div>
            <div className="flex flex-col gap-4">
              <Group label="If it needs your OK">
                <div className="text-xs text-fg-muted">For anything set to Ask first.</div>
                <SegmentedTabs variant="nested" value={job.whenAsk} onChange={(v) => change({ whenAsk: v as 'wait' | 'skip' })}
                  tabs={[{ id: 'wait', label: 'Wait for you' }, { id: 'skip', label: 'Skip it and keep going' }]} />
                {job.whenAsk === 'wait' ? (<>
                  <FieldLabel>Waits up to</FieldLabel>
                  <Select value={job.waitHours === null ? 'next' : String(job.waitHours)} onChange={(v) => change({ waitHours: v === 'next' ? null : Number(v) })}
                    options={[{ value: 'next', label: 'Until it is due to run again' }, { value: '1', label: '1 hour' }, { value: '4', label: '4 hours' }, { value: '12', label: '12 hours' }, { value: '24', label: '24 hours' }]} />
                  <FieldLabel>If you don&rsquo;t answer in time</FieldLabel>
                  <Select value={job.noAnswer} onChange={(v) => change({ noAnswer: v as AutomationSummary['noAnswer'] })}
                    options={[{ value: 'skip', label: 'Leave that step undone and finish the rest' }, { value: 'stop', label: 'Stop the run' }, { value: 'fallback', label: 'Do something else instead' }]} />
                  {job.noAnswer === 'fallback' && (
                    <Textarea value={job.fallback ?? ''} placeholder="For example: save the reply as a draft and tell me." onChange={(e) => change({ fallback: e.target.value })} aria-label="Do this instead" />
                  )}
                </>) : (
                  <div className="text-xs text-fg-muted">It finishes everything else, and its run says what it left for you, with a button to do it.</div>
                )}
              </Group>
              {job.start.kind !== 'button' && (
                <Group label="If the computer was asleep">
                  <Select value={job.late} onChange={(v) => change({ late: v as AutomationSummary['late'] })}
                    options={[{ value: 'run', label: 'Run once when it wakes' }, { value: 'skip', label: 'Skip that run' }, { value: 'fallback', label: 'Run, but differently when late' }]} />
                  {job.late === 'fallback' && (
                    <Textarea value={job.lateFallback ?? ''} placeholder="For example: only look at today, and tell me it ran late." onChange={(e) => change({ lateFallback: e.target.value })} aria-label="When late, do this" />
                  )}
                  <div className="text-xs text-fg-muted">Automations run in YouCoded on this computer, so nothing runs while it is off or asleep. A week away gives one late run, not seven.</div>
                </Group>
              )}
              <Group label="Tell me">
                {/* SettingRow draws its own box, so the rows sit straight in the card (no nested box around them). */}
                <div className="flex flex-col gap-2">
                  <SettingRow variant="item" title="When it needs you" description="On this computer and your phone."
                    control={<Toggle checked={job.notify.needs} onChange={(v) => change({ notify: { ...job.notify, needs: v } })} aria-label="When it needs you" />} />
                  <SettingRow variant="item" title="When it has news" description="Only when its run says there is something worth telling."
                    control={<Toggle checked={job.notify.news} onChange={(v) => change({ notify: { ...job.notify, news: v } })} aria-label="When it has news" />} />
                  <SettingRow variant="item" title="When it fails or reaches its limit"
                    control={<Toggle checked={job.notify.fails} onChange={(v) => change({ notify: { ...job.notify, fails: v } })} aria-label="When it fails or reaches its limit" />} />
                </div>
              </Group>
              <Group label="Model and spending">
                <Select value={job.model} options={MODELS.map(({ value, label }) => ({ value, label }))}
                  onChange={(v) => { const m = MODELS.find((x) => x.value === v)!; change({ model: v, subscription: m.sub, limit: m.sub ? job.limit : job.limit ?? 5 }); }} />
                <SpendField job={job} onLimit={(limit) => change({ limit })} />
              </Group>
            </div>
          </div>
        )}

        {isNew && (
          // A new job's one action, full width at the foot (guide: one lone button is full width).
          <Button variant="primary" className="w-full py-2.5" onClick={() => void turnOn()}>Turn on</Button>
        )}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel className="px-1">{label}</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>{children}</div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-fg-2 pt-1">{children}</div>;
}

function StartField({ start, onChange }: { start: AutomationStart; onChange: (s: AutomationStart) => void }) {
  return (<>
    <SegmentedTabs variant="nested" value={start.kind}
      onChange={(k) => onChange(k === 'schedule' ? { kind: 'schedule', every: 'day', at: '9:00' } : k === 'event' ? { kind: 'event', event: 'An email arrives in Gmail' } : { kind: 'button', label: 'Run' })}
      tabs={[{ id: 'schedule', label: 'On a schedule' }, { id: 'event', label: 'When something happens' }, { id: 'button', label: 'From a button' }]} />
    {start.kind === 'schedule' && (
      <div className="flex items-center gap-2">
        <Select className="flex-1" value={start.every === 'hour' && (start.hours ?? 1) > 1 ? 'hours' : start.every}
          onChange={(v) => onChange(v === 'hours' ? { kind: 'schedule', every: 'hour', hours: 3 } : { kind: 'schedule', every: v as 'hour' | 'day' | 'weekday' | 'week', at: start.at ?? '9:00', day: start.day })}
          options={[{ value: 'hour', label: 'Every hour' }, { value: 'hours', label: 'Every 3 hours' }, { value: 'day', label: 'Every day' }, { value: 'weekday', label: 'Every weekday' }, { value: 'week', label: 'Every week' }]} />
        {start.every === 'week' && (
          <Select className="w-32" value={start.day ?? 'Monday'} onChange={(day) => onChange({ ...start, day })}
            options={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ value: d, label: d }))} />
        )}
        {start.every !== 'hour' && <TextInput className="w-24" value={start.at ?? ''} onChange={(e) => onChange({ ...start, at: e.target.value })} aria-label="At" />}
      </div>
    )}
    {start.kind === 'event' && (
      <Select value={start.event} onChange={(event) => onChange({ kind: 'event', event })}
        options={[{ value: 'An email arrives in Gmail', label: 'An email arrives in Gmail' }, { value: 'A file appears in a folder', label: 'A file appears in a folder' }, { value: 'A page’s information changes', label: 'A page’s information changes' }, { value: 'A bug report arrives', label: 'A bug report arrives' }]} />
    )}
    {start.kind === 'button' && (<>
      <TextInput value={start.label} onChange={(e) => onChange({ kind: 'button', label: e.target.value })} aria-label="Button words" />
      <div className="text-xs text-fg-muted">The page draws this button. Pressing it never asks first: it can only do what is listed under What it may do.</div>
    </>)}
  </>);
}

/** One row per thing the job may do, each with its own switch (Q-blocked note). Anything not
 *  listed is refused, unless the broader settings under the list say otherwise. */
function ToolsField({ tools, onChange }: { tools: AutomationTool[]; onChange: (t: AutomationTool[]) => void }) {
  const [unlistedSites, setUnlistedSites] = useState<'never' | 'ask'>('never');
  const [unlistedCommands, setUnlistedCommands] = useState<'never' | 'ask'>('never');
  return (<>
    {tools.length === 0 && <div className="text-xs text-fg-muted">Nothing yet, so it can only think and write its report.</div>}
    {tools.length > 0 && (
      <div className={`${CARD_LEVEL_2} flex flex-col py-1`} data-automation-tools>
        {tools.map((t) => (
          <div key={t.id} className="flex items-center gap-2 px-3 py-1.5" data-automation-tool={t.id}>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg truncate">{t.label}</div>
              <div className="text-2xs text-fg-muted truncate">{t.source}{t.exact ? ` · only ${t.exact}` : ''}</div>
            </div>
            <SegmentedTabs variant="pill" value={t.mode} onChange={(m) => onChange(tools.map((x) => (x.id === t.id ? { ...x, mode: m as 'allow' | 'ask' } : x)))}
              tabs={[{ id: 'allow', label: 'Always allow' }, { id: 'ask', label: 'Ask first' }]} />
            <Tooltip text="Take this away" placement="bottom">
              <Button size="icon-sm" variant="ghost" aria-label={`Take away ${t.label}`} className="hover:text-destructive-fg" onClick={() => onChange(tools.filter((x) => x.id !== t.id))}>
                <TrashIcon size={14} />
              </Button>
            </Tooltip>
          </div>
        ))}
      </div>
    )}
    <Button variant="secondary" className="w-full">Add something it may do</Button>
    <FieldLabel>Anything not listed</FieldLabel>
    <div className="flex flex-col gap-2">
      <SettingRow variant="item" title="Other websites" description={unlistedSites === 'never' ? 'Refused.' : 'Asks you first, each new site.'}
        control={<SegmentedTabs variant="pill" value={unlistedSites} onChange={(v) => setUnlistedSites(v as 'never' | 'ask')} tabs={[{ id: 'never', label: 'Never' }, { id: 'ask', label: 'Ask first' }]} />} />
      <SettingRow variant="item" title="Other commands and files" description={unlistedCommands === 'never' ? 'Refused.' : 'Asks you first, each time.'}
        control={<SegmentedTabs variant="pill" value={unlistedCommands} onChange={(v) => setUnlistedCommands(v as 'never' | 'ask')} tabs={[{ id: 'never', label: 'Never' }, { id: 'ask', label: 'Ask first' }]} />} />
    </div>
  </>);
}

function SpendField({ job, onLimit }: { job: AutomationSummary; onLimit: (n: number) => void }) {
  if (job.subscription) {
    return (
      <div className="text-xs text-fg-muted leading-relaxed">
        Runs on your Claude subscription, so it costs nothing extra and has no money limit. This month it used <span className="text-fg-2">{tokenWords(job.usage.tokens)}</span> of your subscription&rsquo;s allowance.
      </div>
    );
  }
  const limit = job.limit ?? 5;
  return (<>
    <FieldLabel>Monthly limit</FieldLabel>
    <div className="flex items-center gap-2">
      <span className="text-sm text-fg-2">$</span>
      <TextInput className="w-24" inputMode="decimal" value={String(limit)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onLimit(n); }} aria-label="Monthly limit in dollars" />
      <span className="text-xs text-fg-muted">a month</span>
    </div>
    <ProgressBar percent={Math.min(100, (job.usage.dollars / Math.max(limit, 0.01)) * 100)} />
    <div className="text-xs text-fg-muted">
      This month: {dollarWords(job.usage.dollars)} of ${limit.toFixed(2)}, {tokenWords(job.usage.tokens)}. At the limit it finishes the step it is on, then stops until next month.
    </div>
  </>);
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
  if (runs.length === 0) return <div className="text-xs text-fg-muted px-1">No runs yet.</div>;
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel className="px-1">Last {runs.length} runs</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-1 flex flex-col`}>
        {runs.map((r) => (
          <div key={r.id} className="flex items-start gap-3 px-3 py-2.5" data-automation-run={r.id}>
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-fg">{r.when}</span>
                <Pill tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].word}</Pill>
              </div>
              <div className="text-xs text-fg-2">{r.summary}</div>
              {r.skipped && r.skipped.map((s) => <div key={s} className="text-xs text-fg-muted">Left for you: {s}</div>)}
              {r.tokens > 0 && (
                <div className="text-2xs text-fg-muted">{r.dollars !== undefined ? `${dollarWords(r.dollars)} · ` : ''}{tokenWords(r.tokens)} &middot; {r.seconds} s</div>
              )}
            </div>
            {r.tokens > 0 && <Button variant="secondary" size="sm" className="shrink-0">Open conversation</Button>}
          </div>
        ))}
      </div>
      <div className="text-xs text-fg-muted px-1">The last 50 runs are kept. A run&rsquo;s conversation opens read-only and never appears in your chat list.</div>
    </section>
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
