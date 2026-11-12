// An automation's Advanced settings (pages-finish step 4): what a run does when it needs an OK, gets no answer,
// was missed, or is still going when the next is due.
//
// WHY fold-out cards, all closed, each with a plain sentence and a pro and a con per choice (Destin, plan deck
// round 3 C-rules). WHY this second attempt at how they LOOK (2026-11-12): his last word on the lower half was
// "too busy and unclear with poor visual hierarchy". Round 1 put the whole answer in each closed title as one
// sentence ("Waits until its next run for your OK"), so four long sentences sat in a column with nothing to tell
// the subject from the answer, and each opened choice ran its pro and con together on one grey line. Now:
//   - a closed card is a short subject on the left ("Needs your OK") and the current answer on the right, quieter;
//   - an opened card's choices are each their own box (one container per thing), the chosen one outlined, with
//     the pro and the con on their own lines.
import React from 'react';
import type { AutomationSummary } from '../../../shared/automation-types';
import { CARD_LEVEL_2, FoldRow, Radio, RadioGroup, SettingRow, Textarea, TextInput } from '../ui';
import { ChoicePill } from './AutomationPermissions';

type Option<T extends string> = { value: T; label: string; short: string; pro: string; con: string };

function waitShort(h: number | null): string { return h === null ? 'Waits until its next run' : `Waits up to ${h} hour${h === 1 ? '' : 's'}`; }

export function AdvancedSettings({ job, onChange, openFirst = false }: { job: AutomationSummary; onChange: (p: Partial<AutomationSummary>) => void; openFirst?: boolean }) {
  return (<>
    <OptionFold defaultOpen={openFirst} subject="Needs your OK" about="A run reaches something set to Asks first."
      value={job.whenAsk} onChange={(v) => onChange({ whenAsk: v })}
      options={[
        { value: 'wait', label: 'Wait for me', short: waitShort(job.waitHours), pro: 'Nothing on the Asks first list happens without you.', con: 'The run sits paused until you answer.' },
        { value: 'skip', label: 'Skip it and carry on', short: 'Skips that step', pro: 'Runs never stall.', con: 'Those steps only happen when you run it yourself.' },
      ]}>
      {job.whenAsk === 'wait' && (
        <SettingRow variant="item" title="Wait up to" control={<ChoicePill name="Wait up to" value={job.waitHours === null ? 'next' : String(job.waitHours)} onChange={(v) => onChange({ waitHours: v === 'next' ? null : Number(v) })}
          choices={[['next', 'Its next run'], ['1', '1 hour'], ['4', '4 hours'], ['12', '12 hours'], ['24', '24 hours']]} />} />
      )}
    </OptionFold>
    {job.whenAsk === 'wait' && (
      <OptionFold subject="No answer" about="The wait runs out and you haven’t answered."
        value={job.noAnswer} onChange={(v) => onChange({ noAnswer: v })}
        options={[
          { value: 'skip', label: 'Skip that step', short: 'Skips that step', pro: 'The rest of the run still gets done.', con: 'The skipped step is only noted in its run.' },
          { value: 'stop', label: 'Stop the run', short: 'Stops the run', pro: 'Nothing half-finished carries on.', con: 'Everything after that step is lost for this run.' },
          { value: 'fallback', label: 'Do this instead', short: 'Does something else', pro: 'You choose a safe stand-in, like saving a draft.', con: 'One more thing to write.' },
        ]}>
        {job.noAnswer === 'fallback' && <Textarea value={job.fallback ?? ''} placeholder="Save the reply as a draft." onChange={(e) => onChange({ fallback: e.target.value })} aria-label="Do this instead" />}
      </OptionFold>
    )}
    {job.start.kind !== 'button' && (<>
      {/* Plan deck S-start note: another time, or other instructions (which can also change what it makes). */}
      <OptionFold subject="Missed run" about="A run was due while the computer was off or YouCoded was closed."
        value={job.late} onChange={(v) => onChange({ late: v })}
        options={[
          { value: 'run', label: 'Run once on wake', short: 'Runs once on wake', pro: 'You still get it, a bit late.', con: 'It may run at a busy moment.' },
          { value: 'later', label: 'Run at another time', short: `Runs at ${job.lateAt ?? '18:00'}`, pro: 'It waits for a time that suits you.', con: 'You wait longer for it.' },
          { value: 'fallback', label: 'Run with other instructions', short: 'Runs with other instructions', pro: 'A late run can do something different, like a shorter summary.', con: 'One more thing to write.' },
          { value: 'skip', label: 'Skip it', short: 'Skips it', pro: 'Nothing runs late.', con: 'That run never happens.' },
        ]}>
        {job.late === 'later' && <TextInput className="w-24" value={job.lateAt ?? '18:00'} onChange={(e) => onChange({ lateAt: e.target.value })} aria-label="Run at" />}
        {job.late === 'fallback' && <Textarea value={job.lateFallback ?? ''} placeholder="Only look at today, and save a summary instead of emailing me." onChange={(e) => onChange({ lateFallback: e.target.value })} aria-label="Other instructions" />}
      </OptionFold>
      {/* Plan deck Q-overlap: "this should depend on the specific job". */}
      <OptionFold subject="Still running" about="Its next run is due and the last one hasn’t finished."
        value={job.overlap} onChange={(v) => onChange({ overlap: v })}
        options={[
          { value: 'skip-new', label: 'Skip the new run', short: 'Skips the new run', pro: 'Never two at once.', con: 'That turn is missed.' },
          { value: 'stop-old', label: 'Stop the old run', short: 'Stops the old run', pro: 'You always get the newest run.', con: 'The old run’s work is cut short.' },
          { value: 'both', label: 'Run both', short: 'Runs both', pro: 'Nothing is missed.', con: 'Two runs may do the same thing twice.' },
        ]} />
    </>)}
  </>);
}

/** One advanced setting as a fold-out card. Closed: the subject, and the current answer at the right. Open: a
 *  sentence on when it applies, then each choice in its own box, and any follow-up field for the chosen one. */
function OptionFold<T extends string>({ subject, about, value, onChange, options, defaultOpen = false, children }: {
  subject: string; about: string; value: T; onChange: (v: T) => void;
  options: Option<T>[]; defaultOpen?: boolean; children?: React.ReactNode;
}) {
  const now = options.find((o) => o.value === value);
  return (
    <FoldRow defaultOpen={defaultOpen}
      title={<span className="flex items-baseline gap-3 min-w-0"><span className="shrink-0">{subject}</span><span className="flex-1 min-w-0 truncate text-right font-normal text-fg-muted">{now?.short}</span></span>}>
      <div className="flex flex-col gap-2">
        <div className="text-xs text-fg-muted">{about}</div>
        <RadioGroup options={options.map((o) => o.value)} value={value} onChange={(v) => onChange(v as T)} aria-label={subject} className="flex flex-col gap-1.5">
          {options.map((o) => (
            <button key={o.value} type="button" onClick={() => onChange(o.value)}
              className={`${CARD_LEVEL_2} flex items-start gap-2 text-left px-3 py-2 state-layer${value === o.value ? ' border-accent' : ''}`}>
              <Radio checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5" />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-fg">{o.label}</span>
                <span className="text-2xs text-fg-2 flex gap-1.5"><span aria-hidden="true" className="w-2 shrink-0 text-center">+</span><span>{o.pro}</span></span>
                <span className="text-2xs text-fg-muted flex gap-1.5"><span aria-hidden="true" className="w-2 shrink-0 text-center">−</span><span>{o.con}</span></span>
              </span>
            </button>
          ))}
        </RadioGroup>
        {children}
      </div>
    </FoldRow>
  );
}
