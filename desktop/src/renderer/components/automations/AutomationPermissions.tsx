// An automation's permissions: the list, and adding one by hand (pages-finish step 4, 2026-11-12 round).
//
// WHY one kind of command permission, written per job (Destin, plan-d Q-changing "case-by-case"; plan-f rejected
// three fixed widths as "contrived"; the 2026-11-08 "fence" was dropped as overcomplicated): a permission is a
// plain-words line ("Run whisper on files in Recordings") over what it matches (`whisper ~/Recordings/*`). The
// assistant normally drafts the list when the automation is made; this file is the by-hand path:
//   - the Add menu lists KINDS (this page, a folder, a command, a website, Describe it…), never services that
//     are not connected yet (Gmail waits for step 5) and never notifications (all built together later);
//   - a kind that needs a detail opens a small form in the Add button's place;
//   - "Describe it…" has the assistant write ONE permission and shows it back before it is added (plan-d
//     Q-describe).
// Each permission is its own box (one container per thing), with the shared status pill for its mode.
import React, { useEffect, useState } from 'react';
import type { AutomationSummary, AutomationTool } from '../../../shared/automation-types';
import { Button, CARD_LEVEL_2, Menu, MenuItem, MenuNote, MenuRadioItem, PillButton, SegmentedTabs, SettingRow, Textarea, TextInput } from '../ui';

/** What the by-hand form is collecting; `describe-result` shows what the assistant wrote. */
export type AddStep = null | 'folder' | 'command' | 'site' | 'describe' | 'describe-result';

type Draft = { id?: string; label: string; exact: string; access: 'read' | 'change' };
const EMPTY: Draft = { label: '', exact: '', access: 'read' };

// Photo-only fills, so each form's picture shows it in use.
const SAMPLE: Record<Exclude<AddStep, null>, Draft> = {
  folder: { label: '', exact: '~/Recordings', access: 'read' },
  command: { label: 'Turn recordings into text', exact: 'whisper ~/Recordings/*', access: 'read' },
  site: { label: '', exact: 'bestbuy.com', access: 'read' },
  describe: { label: 'Turn my voice memos into text files next to them', exact: '', access: 'read' },
  'describe-result': { label: 'Turn recordings into text', exact: 'whisper ~/Recordings/*', access: 'read' },
};

function toolFrom(step: Exclude<AddStep, null | 'describe'>, d: Draft): AutomationTool {
  const id = d.id ?? `t-${Date.now()}`;
  if (step === 'folder') return { id, kind: 'folder', label: d.access === 'read' ? 'See the files in a folder' : 'Change the files in a folder', source: 'Your computer', exact: d.exact.trim(), mode: 'ask' };
  if (step === 'site') return { id, kind: 'site', label: 'Visit a website', source: 'Internet', exact: d.exact.trim(), mode: 'ask' };
  return { id, kind: 'command', label: d.label.trim() || 'Run a command', source: 'Your computer', exact: d.exact.trim(), mode: 'ask' };
}

export function PermissionsField({ tools, unlisted, onChange, onUnlisted, menuOpen, onMenu, startStep = null }: {
  tools: AutomationTool[]; unlisted: AutomationSummary['unlisted']; onChange: (t: AutomationTool[]) => void;
  onUnlisted: (u: AutomationSummary['unlisted']) => void; menuOpen: boolean; onMenu: (o: boolean) => void;
  /** Photo-only: the form a picture opens on. */
  startStep?: AddStep;
}) {
  const [step, setStep] = useState<AddStep>(startStep);
  const [draft, setDraft] = useState<Draft>(startStep ? SAMPLE[startStep] : EMPTY);
  const begin = (s: Exclude<AddStep, null>, from: Draft = EMPTY) => { setDraft(from); setStep(s); };
  const close = () => { setStep(null); setDraft(EMPTY); };
  const addNow = (label: string, source: string, kind: AutomationTool['kind']) => onChange([...tools, { id: `t-${Date.now()}`, kind, label, source, mode: 'ask' }]);
  const commit = (s: Exclude<AddStep, null | 'describe'>) => {
    const tool = toolFrom(s === 'describe-result' ? 'command' : s, draft);
    // An edited permission keeps its place and its mode.
    onChange(draft.id ? tools.map((t) => (t.id === draft.id ? { ...tool, mode: t.mode } : t)) : [...tools, tool]);
    close();
  };
  const edit = (t: AutomationTool) => begin(t.kind === 'folder' ? 'folder' : t.kind === 'site' ? 'site' : 'command',
    { id: t.id, label: t.kind === 'command' ? t.label : '', exact: t.exact ?? '', access: /^Change/.test(t.label) ? 'change' : 'read' });
  // Photo-only states open on the menu or a form; bring it into view so its picture shows it.
  const formRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { if (menuOpen || startStep) formRef.current?.scrollIntoView?.({ block: 'center' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on open only
  return (<>
    {tools.map((t) => (
      <div key={t.id} className={`${CARD_LEVEL_2} flex items-center gap-2 px-3 py-2`} data-automation-tool={t.id}>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg truncate">{t.label}</div>
          <div className={`text-2xs text-fg-muted truncate${t.kind === 'command' ? ' font-mono' : ''}`}>{t.exact ?? t.source}</div>
        </div>
        <ModeMenu mode={t.mode} name={t.label}
          onMode={(m) => onChange(tools.map((x) => (x.id === t.id ? { ...x, mode: m } : x)))}
          onEdit={t.kind === 'folder' || t.kind === 'site' || t.kind === 'command' ? () => edit(t) : undefined}
          onRemove={() => onChange(tools.filter((x) => x.id !== t.id))} />
      </div>
    ))}
    <div ref={formRef}>
      {step === null ? (
        <Menu open={menuOpen} onOpenChange={onMenu} label="Add a permission" className="min-w-72"
          trigger={<Button variant="secondary" className="w-full" onClick={() => onMenu(!menuOpen)}>Add a permission</Button>}>
          <MenuNote><span className="text-2xs text-fg-muted">This page</span></MenuNote>
          <MenuItem onSelect={() => addNow('Read this page’s information', 'This page', 'page-read')}>Read its information</MenuItem>
          <MenuItem onSelect={() => addNow('Change this page’s information', 'This page', 'page-write')}>Change its information</MenuItem>
          <MenuNote><span className="text-2xs text-fg-muted">Your computer</span></MenuNote>
          <MenuItem onSelect={() => begin('folder')}>A folder…</MenuItem>
          <MenuItem onSelect={() => begin('command')}>A command…</MenuItem>
          <MenuNote><span className="text-2xs text-fg-muted">Internet</span></MenuNote>
          <MenuItem onSelect={() => begin('site')}>A website…</MenuItem>
          <MenuNote><span className="text-2xs text-fg-muted">Something else</span></MenuNote>
          <MenuItem onSelect={() => begin('describe')}>Describe it…</MenuItem>
        </Menu>
      ) : (
        <div className={`${CARD_LEVEL_2} p-3 flex flex-col gap-2`} data-automation-add={step}>
          {step === 'folder' && (<>
            <Named label="Folder"><TextInput value={draft.exact} placeholder="~/Recordings" onChange={(e) => setDraft({ ...draft, exact: e.target.value })} aria-label="Folder" /></Named>
            <SegmentedTabs variant="nested" value={draft.access} onChange={(a) => setDraft({ ...draft, access: a as Draft['access'] })}
              tabs={[{ id: 'read', label: 'See files' }, { id: 'change', label: 'See and change files' }]} />
          </>)}
          {step === 'site' && (
            <Named label="Website"><TextInput value={draft.exact} placeholder="bestbuy.com" onChange={(e) => setDraft({ ...draft, exact: e.target.value })} aria-label="Website" /></Named>
          )}
          {step === 'command' && (<>
            <Named label="Name"><TextInput value={draft.label} placeholder="Turn recordings into text" onChange={(e) => setDraft({ ...draft, label: e.target.value })} aria-label="Name" /></Named>
            <Named label="Command" hint="* stands for any part that changes">
              <TextInput className="font-mono" value={draft.exact} placeholder="whisper ~/Recordings/*" onChange={(e) => setDraft({ ...draft, exact: e.target.value })} aria-label="Command" />
            </Named>
          </>)}
          {step === 'describe' && (
            <Named label="What it may do"><Textarea rows={2} value={draft.label} placeholder="Turn my voice memos into text files next to them" onChange={(e) => setDraft({ ...draft, label: e.target.value })} aria-label="What it may do" /></Named>
          )}
          {step === 'describe-result' && (
            // What the assistant wrote, shown back as the box it will become (plan-d Q-describe: "writes one exact
            // permission and shows it back").
            <div className="flex flex-col gap-1">
              <div className="text-xs text-fg-2">Written for you</div>
              <div className="rounded-md bg-inset border border-edge-dim px-3 py-2">
                <div className="text-sm text-fg">{draft.label}</div>
                <div className="text-2xs text-fg-muted font-mono">{draft.exact}</div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={close}>Cancel</Button>
            {step === 'describe'
              // Design stage: the fake answers at once with one sample permission.
              ? <Button variant="primary" size="sm" disabled={!draft.label.trim()} onClick={() => begin('describe-result', SAMPLE['describe-result'])}>Write it</Button>
              : step === 'describe-result'
                ? <><Button variant="secondary" size="sm" onClick={() => begin('command', draft)}>Edit</Button><Button variant="primary" size="sm" onClick={() => commit('describe-result')}>Add</Button></>
                : <Button variant="primary" size="sm" disabled={!draft.exact.trim()} onClick={() => commit(step)}>{draft.id ? 'Save' : 'Add'}</Button>}
          </div>
        </div>
      )}
    </div>
    <SettingRow variant="item" title="Other websites" control={<ChoicePill name="Other websites" value={unlisted.sites} choices={UNLISTED} onChange={(sites) => onUnlisted({ ...unlisted, sites })} />} />
    <SettingRow variant="item" title="Other commands and files" control={<ChoicePill name="Other commands and files" value={unlisted.commands} choices={UNLISTED} onChange={(commands) => onUnlisted({ ...unlisted, commands })} />} />
  </>);
}

const UNLISTED: ['never' | 'ask', string][] = [['never', 'Never'], ['ask', 'Asks first']];

/** A named field: the name above the control (guide "Text and numbers"), with at most one short hint. */
function Named({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2"><span className="text-xs text-fg-2">{label}</span>{hint && <span className="text-2xs text-fg-muted">{hint}</span>}</div>
      {children}
    </div>
  );
}

/** Round 2 B-add ("these allow/ask toggles … don't seem to match the styling used for similar elements
 *  elsewhere"): a state you change is the shared status pill that opens a small menu (`PillButton` +
 *  `Menu`, guide "Lists and menus"), with Edit (where there is a detail to edit) and Remove as its last rows. */
function ModeMenu({ mode, name, onMode, onEdit, onRemove }: { mode: 'allow' | 'ask'; name: string; onMode: (m: 'allow' | 'ask') => void; onEdit?: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen} align="right" label={name}
      trigger={<PillButton tone={mode === 'allow' ? 'ok' : 'warning'} open={open} onClick={() => setOpen((o) => !o)} aria-label={`${name}: ${mode === 'allow' ? 'Always allowed' : 'Asks first'}`}>{mode === 'allow' ? 'Always allowed' : 'Asks first'}</PillButton>}>
      <MenuRadioItem checked={mode === 'allow'} onSelect={() => onMode('allow')}>Always allowed</MenuRadioItem>
      <MenuRadioItem checked={mode === 'ask'} onSelect={() => onMode('ask')}>Asks first</MenuRadioItem>
      {onEdit && <MenuItem onSelect={onEdit}>Edit</MenuItem>}
      <MenuItem onSelect={onRemove}>Remove</MenuItem>
    </Menu>
  );
}

/** A value you change: the shared pill that opens a small menu of its choices (guide "Lists and
 *  menus"), the same control as a permission's mode. */
export function ChoicePill<T extends string>({ name, value, choices, onChange }: { name: string; value: T; choices: [T, string][]; onChange: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  const word = choices.find(([v]) => v === value)?.[1] ?? value;
  return (
    <Menu open={open} onOpenChange={setOpen} align="right" label={name}
      trigger={<PillButton open={open} onClick={() => setOpen((o) => !o)} aria-label={`${name}: ${word}`}>{word}</PillButton>}>
      {choices.map(([v, w]) => <MenuRadioItem key={v} checked={v === value} onSelect={() => onChange(v)}>{w}</MenuRadioItem>)}
    </Menu>
  );
}
