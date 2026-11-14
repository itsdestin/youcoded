// An automation's permissions: the list, and adding one by hand (pages-finish step 4, 2026-11-12 round).
//
// WHY one kind of command permission, written per job (Destin, plan-d Q-changing "case-by-case"; plan-f rejected
// three fixed widths as "contrived"; the 2026-11-08 "fence" was dropped as overcomplicated): a permission is a
// plain-words line ("Run whisper on files in Recordings") over what it matches (`whisper ~/Recordings/*`). The
// assistant normally drafts the list when the automation is made; this file is the by-hand path:
//   - the Add menu lists KINDS (this page, a folder, a command, a website, Describe it…), never services that
//     are not connected yet (Gmail waits for step 5) and never notifications (all built together later);
//   - a kind that needs a detail opens ONE control in the Add button's place: the folder chooser Page settings
//     uses, or a field with its action inside it (round 4: no bespoke forms);
//   - "Describe it…" has the assistant write ONE permission and shows it back before it is added (plan-d
//     Q-describe).
// Each permission is its own box (one container per thing), with the shared status pill for its mode.
import React, { useEffect, useState } from 'react';
import type { AutomationSummary, AutomationTool } from '../../../shared/automation-types';
import { Button, CARD_LEVEL_2, CloseButton, InputGroup, Menu, MenuItem, MenuNote, MenuRadioItem, PillButton, SettingRow } from '../ui';
import { FolderField } from '../pages/page-connections';
import { getCapabilities } from '../../platform';

/** What the by-hand form is collecting; `describe-result` shows what the assistant wrote. */
export type AddStep = null | 'folder-read' | 'folder-change' | 'command' | 'site' | 'describe' | 'describe-result';
type Step = Exclude<AddStep, null>;

type Draft = { id?: string; label: string; exact: string };
const EMPTY: Draft = { label: '', exact: '' };

// Photo-only fills, so each form's picture shows it in use.
const SAMPLE: Partial<Record<Step, Draft>> = {
  command: { label: '', exact: 'whisper ~/Recordings/*' },
  site: { label: '', exact: 'bestbuy.com' },
  describe: { label: 'Turn my voice memos into text files next to them', exact: '' },
  'describe-result': { label: 'Turn recordings into text', exact: 'whisper ~/Recordings/*' },
};

const TITLE: Record<Step, string> = {
  'folder-read': 'See the files in a folder', 'folder-change': 'Change the files in a folder',
  command: 'Command', site: 'Website', describe: 'What it may do', 'describe-result': 'Written for you',
};

function toolFrom(step: Step, d: Draft): AutomationTool {
  const id = d.id ?? `t-${Date.now()}`;
  if (step === 'folder-read' || step === 'folder-change') return { id, kind: 'folder', label: TITLE[step], source: 'Your computer', exact: d.exact.trim(), mode: 'ask', ...(step === 'folder-change' ? { change: true } : {}) };
  if (step === 'site') return { id, kind: 'site', label: 'Visit a website', source: 'Internet', exact: d.exact.trim(), mode: 'ask' };
  // A command typed by hand has no name of its own; one the assistant wrote keeps the name it gave.
  return { id, kind: 'command', label: d.label.trim() || 'Run a command', source: 'Your computer', exact: d.exact.trim(), mode: 'ask' };
}

/** The computer's own Choose folder window, the one Page settings → Files opens. */
async function chooseFolderInOs(): Promise<string | null> {
  const r = await (window as unknown as { claude?: { pages?: { chooseFolder?: () => Promise<{ ok: true; display: string } | { ok: false }> } } }).claude?.pages?.chooseFolder?.();
  return r?.ok ? r.display : null;
}

export function PermissionsField({ tools, unlisted, onChange, onUnlisted, menuOpen, onMenu, startStep = null, chooseFolder = chooseFolderInOs }: {
  tools: AutomationTool[]; unlisted: AutomationSummary['unlisted']; onChange: (t: AutomationTool[]) => void;
  onUnlisted: (u: AutomationSummary['unlisted']) => void; menuOpen: boolean; onMenu: (o: boolean) => void;
  /** Photo-only: the form a picture opens on. */
  startStep?: AddStep;
  chooseFolder?: () => Promise<string | null>;
}) {
  const [step, setStep] = useState<AddStep>(startStep);
  const [draft, setDraft] = useState<Draft>((startStep && SAMPLE[startStep]) || EMPTY);
  const begin = (s: Step, from: Draft = EMPTY) => { setDraft(from); setStep(s); };
  const close = () => { setStep(null); setDraft(EMPTY); };
  const addNow = (label: string, source: string, kind: AutomationTool['kind']) => onChange([...tools, { id: `t-${Date.now()}`, kind, label, source, mode: 'ask' }]);
  const commit = (s: Step, d: Draft = draft) => {
    const tool = toolFrom(s === 'describe-result' ? 'command' : s, d);
    // An edited permission keeps its place and its mode.
    onChange(d.id ? tools.map((t) => (t.id === d.id ? { ...tool, mode: t.mode } : t)) : [...tools, tool]);
    close();
  };
  const edit = (t: AutomationTool) => begin(t.kind === 'folder' ? (/^Change/.test(t.label) ? 'folder-change' : 'folder-read') : t.kind === 'site' ? 'site' : 'command',
    { id: t.id, label: t.kind === 'command' && t.label !== 'Run a command' ? t.label : '', exact: t.exact ?? '' });
  // Photo-only states open on the menu or a form; bring it into view so its picture shows it.
  const formRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { if (menuOpen || startStep) formRef.current?.scrollIntoView?.({ block: 'center' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on open only
  const folderStep = step === 'folder-read' || step === 'folder-change';
  return (<>
    {tools.map((t) => (
      <div key={t.id} className={`${CARD_LEVEL_2} flex items-center gap-2 px-3 py-2`} data-automation-tool={t.id}>
        <ToolWords label={t.label} detail={t.exact ?? t.source} mono={t.kind === 'command'} />
        <ModeMenu mode={t.mode} name={t.label}
          onMode={(m) => onChange(tools.map((x) => (x.id === t.id ? { ...x, mode: m } : x)))}
          onEdit={t.kind === 'folder' || t.kind === 'site' || t.kind === 'command' ? () => edit(t) : undefined}
          onRemove={() => onChange(tools.filter((x) => x.id !== t.id))} />
      </div>
    ))}
    <div ref={formRef}>
      {step === null ? (
        // WHY as wide as its button (Destin, round 4 D-addmenu: "why did this popup/dropdown get narrower?"): its
        // width used to follow its longest row, so shorter rows shrank it.
        <Menu open={menuOpen} onOpenChange={onMenu} label="Add a permission" className="w-full"
          trigger={<Button variant="secondary" className="w-full" onClick={() => onMenu(!menuOpen)}>Add a permission</Button>}>
          <MenuNote><span className="text-2xs text-fg-muted">This page</span></MenuNote>
          <MenuItem onSelect={() => addNow('Read this page’s information', 'This page', 'page-read')}>Read its information</MenuItem>
          <MenuItem onSelect={() => addNow('Change this page’s information', 'This page', 'page-write')}>Change its information</MenuItem>
          <MenuNote><span className="text-2xs text-fg-muted">Your computer</span></MenuNote>
          <MenuItem onSelect={() => begin('folder-read')}>See the files in a folder…</MenuItem>
          <MenuItem onSelect={() => begin('folder-change')}>Change the files in a folder…</MenuItem>
          <MenuItem onSelect={() => begin('command')}>Run a command…</MenuItem>
          <MenuNote><span className="text-2xs text-fg-muted">Internet</span></MenuNote>
          <MenuItem onSelect={() => begin('site')}>Visit a website…</MenuItem>
          <MenuNote><span className="text-2xs text-fg-muted">Something else</span></MenuNote>
          <MenuItem onSelect={() => begin('describe')}>Describe it…</MenuItem>
        </Menu>
      ) : (
        // One shape for every kind (round 4: the first forms were each a different stack of fields and buttons;
        // D-describe: the action "could be inside the text box with an x in the top right in-line with" its
        // label): the label with the app's × on its line, then ONE control — the folder chooser Page settings
        // already uses, or a field with its action inside it (InputGroup).
        <div className={`${CARD_LEVEL_2} pl-3 pr-2 pt-1.5 pb-3 flex flex-col gap-1.5`} data-automation-add={step}>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-fg-2">{TITLE[step]}</span>
            <CloseButton size="icon-sm" label="Cancel" onClick={close} />
          </div>
          <div className="pr-1">
            {folderStep && (
              // Choosing adds it at once: the folder IS the whole permission.
              <FolderField folder={draft.exact || undefined} canChoose={getCapabilities().openInOs}
                onChoose={async () => { const f = await chooseFolder(); if (f) commit(step, { ...draft, exact: f }); return undefined; }} />
            )}
            {(step === 'site' || step === 'command' || step === 'describe') && (
              <InputGroup size="sm">
                <InputGroup.Field autoFocus className={step === 'command' ? 'font-mono' : ''} aria-label={TITLE[step]}
                  value={step === 'describe' ? draft.label : draft.exact}
                  placeholder={step === 'site' ? 'bestbuy.com' : step === 'command' ? 'whisper ~/Recordings/*' : 'Turn my voice memos into text'}
                  onChange={(e) => setDraft(step === 'describe' ? { ...draft, label: e.target.value } : { ...draft, exact: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (step === 'describe' ? draft.label : draft.exact).trim()) { if (step === 'describe') begin('describe-result', SAMPLE['describe-result']); else commit(step); } }} />
                {step === 'describe'
                  // Design stage: the fake answers at once with one sample permission.
                  ? <Button size="sm" variant="primary" disabled={!draft.label.trim()} onClick={() => begin('describe-result', SAMPLE['describe-result'])}>Write it</Button>
                  : <Button size="sm" variant="primary" disabled={!draft.exact.trim()} onClick={() => commit(step)}>{draft.id ? 'Save' : 'Add'}</Button>}
              </InputGroup>
            )}
            {step === 'describe-result' && (
              // What the assistant wrote, drawn as the line it will become (plan-d Q-describe: "writes one exact
              // permission and shows it back"), with its two actions where a line's pill sits.
              <div className="flex items-center gap-2">
                <ToolWords label={draft.label} detail={draft.exact} mono />
                <Button variant="secondary" size="sm" onClick={() => begin('command', draft)}>Edit</Button>
                <Button variant="primary" size="sm" onClick={() => commit('describe-result')}>Add</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
    <SettingRow variant="item" title="Other websites" control={<ChoicePill name="Other websites" value={unlisted.sites} choices={UNLISTED} onChange={(sites) => onUnlisted({ ...unlisted, sites })} />} />
    <SettingRow variant="item" title="Other commands and files" control={<ChoicePill name="Other commands and files" value={unlisted.commands} choices={UNLISTED} onChange={(commands) => onUnlisted({ ...unlisted, commands })} />} />
  </>);
}

/** A permission's two lines: what it does, and what it covers (a command in the code face). */
function ToolWords({ label, detail, mono }: { label: string; detail: string; mono?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-sm text-fg truncate">{label}</div>
      <div className={`text-2xs text-fg-muted truncate${mono ? ' font-mono' : ''}`}>{detail}</div>
    </div>
  );
}

const UNLISTED: ['never' | 'ask', string][] = [['never', 'Never'], ['ask', 'Asks first']];

/** Round 2 B-add ("these allow/ask toggles … don't seem to match the styling used for similar elements
 *  elsewhere"): a state you change is the shared status pill that opens a small menu (`PillButton` +
 *  `Menu`, guide "Lists and menus"), with Edit (where there is a detail to edit) and Remove as its last rows. */
function ModeMenu({ mode, name, onMode, onEdit, onRemove }: { mode: 'allow' | 'ask'; name: string; onMode: (m: 'allow' | 'ask') => void; onEdit?: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    // WHY w-max (UX review U3): hung from a short pill, the menu was only as wide as the pill and wrapped
    // "Always allowed" onto two lines.
    <Menu open={open} onOpenChange={setOpen} align="right" label={name} className="w-max"
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
    <Menu open={open} onOpenChange={setOpen} align="right" label={name} className="w-max"
      trigger={<PillButton open={open} onClick={() => setOpen((o) => !o)} aria-label={`${name}: ${word}`}>{word}</PillButton>}>
      {choices.map(([v, w]) => <MenuRadioItem key={v} checked={v === value} onSelect={() => onChange(v)}>{w}</MenuRadioItem>)}
    </Menu>
  );
}
