// "Check this automation" — what you see after asking for one in chat ("every morning, check my
// spending"). Pages-finish step 4, design stage.
//
// WHY a check before anything runs (Q-make: "with chat and/or a full builder view"; the deck's
// recommended "ask, then check"): a job set up only by talking would get its permissions without
// you ever seeing a switch. So the assistant drafts it, and this popup shows every part, with the
// two parts that matter most open for editing right here: what it may do (each its own switch)
// and the spending limit, already filled at $5 (Q-limit note: "default to 5 with a changeable
// popup"). Everything else opens the full builder.
//
// Shape: an action popup that also edits (guide "Popups and side panels"): its editing cards are
// open when it opens, nothing it edits is saved until Turn on, and the ✕ leaves everything as it
// was. Its buttons act on the whole popup, so they sit on the pinned footer line.
import React, { useState } from 'react';
import type { AutomationSummary } from '../../../shared/automation-types';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Chip, SectionLabel, SegmentedTabs, TextInput } from '../ui';
import { Dialog } from '../ui/Dialog';
import { useScreenOpen } from '../../shoot-mode';
import { automationsBridge, publishAutomations } from './use-automations';
import { startWords } from './automation-words';
import { JobGlyph } from './AutomationEditor';

/** The draft the assistant hands over in the workbench: the morning money check, before it is on. */
function sampleDraft(): AutomationSummary {
  return {
    id: 'job-draft', name: 'Morning money check',
    instruction: 'Look at yesterday’s spending on the Money page. If anything looks unusual, write a short note at the top and tell me.',
    owner: { kind: 'page', pageId: 'page-money', pageName: 'Money', pageIcon: 'money' },
    start: { kind: 'schedule', every: 'day', at: '7:00' }, model: 'GPT-5 mini', subscription: false,
    tools: [
      { id: 'd-read', label: 'Read this page’s information', source: 'Money', mode: 'allow' },
      { id: 'd-note', label: 'Write a note on this page', source: 'Money', mode: 'allow' },
      { id: 'd-notify', label: 'Send you a notification', source: 'YouCoded', mode: 'allow' },
    ],
    whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run',
    notify: { needs: true, news: true, fails: true }, limit: 5, enabled: false, usage: { dollars: 0, tokens: 0 },
  };
}

// WHY memo: it is mounted always and shown only while a draft is open, so the shell's redraws
// (a session switch) must not rebuild it closed (performance rule 2; busy-app render budget).
export const AutomationCheckDialog = React.memo(function AutomationCheckDialog({ onOpenBuilder }: { onOpenBuilder?: (job: AutomationSummary) => void }) {
  const [draft, setDraft] = useState<AutomationSummary | null>(null);
  useScreenOpen('chat/automation-check', () => setDraft(sampleDraft()));
  const close = () => setDraft(null);
  const turnOn = async () => {
    if (!draft) return;
    const b = automationsBridge();
    if (b) publishAutomations(await b.save({ ...draft, enabled: true }));
    close();
  };
  return (
    <Dialog screen="chat/automation-check" open={draft !== null} onClose={close} size="panel" title="Check this automation"
      subtitle="Nothing runs until you turn it on."
      footer={draft && (
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="w-full py-2.5" onClick={() => void turnOn()}>Turn on</Button>
          <Button variant="secondary" className="w-full py-2.5" onClick={() => { onOpenBuilder?.(draft); close(); }}>Change something else</Button>
        </div>
      )}>
      {draft && <CheckBody draft={draft} onChange={setDraft} />}
    </Dialog>
  );
});

function CheckBody({ draft, onChange }: { draft: AutomationSummary; onChange: (d: AutomationSummary) => void }) {
  return (
    <div className="flex flex-col gap-4">
      {/* The subject card, no label (guide: the popup's own subject). */}
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
        <div className="flex items-start gap-3">
          <JobGlyph job={draft} />
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <div className="text-base font-semibold text-fg leading-snug">{draft.name}</div>
            <div className="flex items-center gap-1.5 overflow-x-auto scroll-mask-x">
              <Chip>{draft.owner.kind === 'page' ? `On ${draft.owner.pageName}` : 'On its own'}</Chip>
              <Chip>{startWords(draft.start)}</Chip>
              <Chip>{draft.model}</Chip>
            </div>
          </div>
        </div>
        <div className="text-xs text-fg-2 leading-relaxed">{draft.instruction}</div>
      </div>

      <section className="flex flex-col gap-2">
        <SectionLabel>What it may do</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
          <div className={`${CARD_LEVEL_2} flex flex-col py-1`}>
            {draft.tools.map((t) => (
              // Stacked: the popup is narrow (420px), and a name cut to "Read this …" hides what is being allowed.
              <div key={t.id} className="flex flex-col gap-1.5 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-fg truncate">{t.label}</div>
                  <div className="text-2xs text-fg-muted truncate">{t.source}</div>
                </div>
                <SegmentedTabs variant="nested" value={t.mode}
                  onChange={(m) => onChange({ ...draft, tools: draft.tools.map((x) => (x.id === t.id ? { ...x, mode: m as 'allow' | 'ask' } : x)) })}
                  tabs={[{ id: 'allow', label: 'Always allow' }, { id: 'ask', label: 'Ask first' }]} />
              </div>
            ))}
          </div>
          <div className="text-xs text-fg-muted">Nothing else. If it needs your OK, it waits and notifies you.</div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel>Spending limit</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-2">$</span>
            <TextInput className="w-24" inputMode="decimal" value={String(draft.limit ?? 5)}
              onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange({ ...draft, limit: n }); }} aria-label="Monthly limit in dollars" />
            <span className="text-xs text-fg-muted">a month</span>
          </div>
          <div className="text-xs text-fg-muted">At the limit it finishes the step it is on, then stops until next month and tells you.</div>
        </div>
      </section>
    </div>
  );
}
