import React from 'react';
import { Button, Dialog, TextInput, Radio, RadioGroup } from '../../../components/ui';
import { ThemeBg } from '../../../components/ThemeBg';

/** WHY (design-guide review, 2026-09-24): Destin's stated rule — "the dark button
 *  always on the right, the light button directly to its left; a single button
 *  often full width; sometimes stacked, sometimes side by side" — has to be seen
 *  on real popups before it goes into the guide. Every popup here is the real
 *  shared <Dialog> with real <Button>s; only the ARRANGEMENT of the action row
 *  differs between candidates. Dev-only (compare registry → live panes). */

export type PairLayout = 'today' | 'right' | 'halves' | 'stacked' | 'stacked-bottom';
export type SingleLayout = 'full' | 'right' | 'center';
export type DangerLayout = 'danger-right' | 'danger-left';
export type CardLayout = 'today' | 'flipped';

function Frame({ children, height = 520 }: { children: React.ReactNode; height?: number }) {
  return (
    <div className="relative p-4" style={{ height }}>
      <ThemeBg />
      {children}
    </div>
  );
}

function PairRow({ layout, cancel, main }: { layout: PairLayout; cancel: string; main: string }) {
  if (layout === 'today') {
    // Today's "Create a page" footer: bare-text Cancel on the left, a wide filled button filling the rest.
    return (
      <div className="flex items-center gap-2 pt-2">
        <Button variant="ghost" size="lg" className="py-1.5">{cancel}</Button>
        <Button variant="primary" size="lg" className="flex-1 py-1.5">{main}</Button>
      </div>
    );
  }
  if (layout === 'right') {
    return (
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" size="md">{cancel}</Button>
        <Button variant="primary" size="md">{main}</Button>
      </div>
    );
  }
  if (layout === 'halves') {
    return (
      <div className="grid grid-cols-2 gap-2 pt-2">
        <Button variant="secondary" size="lg" className="py-1.5">{cancel}</Button>
        <Button variant="primary" size="lg" className="py-1.5">{main}</Button>
      </div>
    );
  }
  const filled = <Button key="m" variant="primary" size="lg" className="w-full py-1.5">{main}</Button>;
  const outlined = <Button key="c" variant="secondary" size="lg" className="w-full py-1.5">{cancel}</Button>;
  return (
    <div className="flex flex-col gap-2 pt-2">
      {layout === 'stacked-bottom' ? [outlined, filled] : [filled, outlined]}
    </div>
  );
}

export function PairDialogDemo({ layout, size = 'panel' }: { layout: PairLayout; size?: 'prompt' | 'panel' | 'document' }) {
  const [open, setOpen] = React.useState(true);
  return (
    <Frame>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open popup</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create a page" size={size}>
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">Describe what the page should do and the assistant builds it.</p>
          <TextInput className="w-full" placeholder="Page name" defaultValue="Week planner" aria-label="Page name" />
          <TextInput className="w-full" placeholder="What should it show?" aria-label="Description" />
          <PairRow layout={layout} cancel="Cancel" main="Create page" />
        </div>
      </Dialog>
    </Frame>
  );
}

export function SingleDialogDemo({ layout }: { layout: SingleLayout }) {
  const [open, setOpen] = React.useState(true);
  const row = layout === 'full'
    ? <Button variant="primary" size="lg" className="w-full py-1.5">Review ticket</Button>
    : <div className={`flex ${layout === 'right' ? 'justify-end' : 'justify-center'}`}><Button variant="primary" size="md">Review ticket</Button></div>;
  return (
    <Frame>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open popup</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Submit a ticket" size="panel">
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">Tickets are public on GitHub. Review details before sharing.</p>
          <TextInput className="w-full" placeholder="A short summary" aria-label="Title" />
          <TextInput className="w-full" placeholder="What happened?" aria-label="Description" />
          <div className="pt-2">{row}</div>
        </div>
      </Dialog>
    </Frame>
  );
}

export function DangerDialogDemo({ layout }: { layout: DangerLayout }) {
  const [open, setOpen] = React.useState(true);
  const cancel = <Button key="c" variant="secondary" size="md">Cancel</Button>;
  const remove = <Button key="r" variant="danger" size="md">Remove project</Button>;
  return (
    <Frame height={380}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open popup</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Remove this project?" size="prompt" destructive>
        <div className="space-y-3">
          <p className="text-xs text-fg-2">youcoded leaves your Projects list. Its files and conversations stay on this computer.</p>
          <div className="flex justify-end gap-2 pt-2">{layout === 'danger-right' ? [cancel, remove] : [remove, cancel]}</div>
        </div>
      </Dialog>
    </Frame>
  );
}

const DAYS = [
  { id: 'fri', label: 'Friday afternoon' },
  { id: 'sat', label: 'Saturday morning' },
  { id: 'sun', label: 'Sunday evening' },
] as const;

/** An assistant question in the chat, shaped like the real question card: a short
 *  prompt, choices, and its two actions — only the action order changes. */
export function QuestionCardDemo({ layout }: { layout: CardLayout }) {
  const [pick, setPick] = React.useState('sat');
  return (
    <Frame height={300}>
      <div className="max-w-md rounded-lg border border-edge bg-inset p-3 space-y-3">
        <p className="text-sm text-fg">Which day should the weekly review run?</p>
        <RadioGroup options={DAYS.map((d) => d.id)} value={pick} onChange={setPick} aria-label="Day" className="space-y-1.5">
          {DAYS.map((d) => (
            <label key={d.id} className="flex items-center gap-2 text-xs text-fg-2">
              <Radio checked={pick === d.id} onChange={() => setPick(d.id)} aria-label={d.label} />
              {d.label}
            </label>
          ))}
        </RadioGroup>
        {layout === 'today' ? (
          <div className="flex gap-2">
            <Button variant="primary" size="sm">Submit</Button>
            <Button variant="ghost" size="sm">Dismiss</Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm">Dismiss</Button>
            <Button variant="primary" size="sm">Submit</Button>
          </div>
        )}
      </div>
    </Frame>
  );
}

/** The permission row's three status-coloured buttons, drawn with the exact
 *  classes ToolCard uses (they are hand-built there too), in today's order and
 *  mirrored so the affirmative ends on the right. */
export function PermissionRowDemo({ layout }: { layout: CardLayout }) {
  const cls = (tone: string) => `px-3 py-1 text-xs font-medium rounded-lg transition-colors ${tone}`;
  const yes = <button key="y" className={cls('bg-green-400/60 hover:bg-green-400/80 text-green-100')}>Yes</button>;
  const always = <button key="a" className={cls('bg-blue-400/60 hover:bg-blue-400/80 text-blue-100')}>Always Allow</button>;
  const no = <button key="n" className={cls('bg-red-400/60 hover:bg-red-400/80 text-red-100')}>No</button>;
  return (
    <Frame height={200}>
      <div className="max-w-md rounded-lg border border-edge overflow-hidden">
        <div className="px-3 py-2 text-xs text-fg-2">Running a command · <span className="text-fg-muted">rm -rf desktop/dist</span></div>
        <div className={`px-3 py-2 border-t border-edge bg-inset/30 flex gap-2 ${layout === 'flipped' ? 'justify-end' : ''}`}>
          {layout === 'today' ? [yes, always, no] : [no, always, yes]}
        </div>
      </div>
    </Frame>
  );
}
