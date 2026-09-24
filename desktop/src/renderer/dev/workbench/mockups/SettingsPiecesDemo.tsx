import React from 'react';
import { Button, Dialog, Toggle, Checkbox, InputGroup, SettingRow, RowStatus, StatusStrip, ProgressBar, ChevronDown } from '../../../components/ui';
import { Callout } from '../../../components/ui/Callout';
import { ThemeBg } from '../../../components/ThemeBg';

/** WHY (design-guide review, 2026-09-24): Destin turned down every screen in fix
 *  batch 1. The shallow fixes (no capitals, one box removed) left the pieces he
 *  actually objected to, and none of those pieces has a guide rule yet: a fold-out
 *  "Show details", an error inside a setting, small follow-up actions drawn as
 *  underlined text, a status on a list item, the button inside a text box, a
 *  consent checkbox and a status card holding boxes. Each export below is ONE of
 *  those pieces in a small real popup, drawn with the real shared parts; only
 *  that piece changes between candidates. Dev-only (compare registry → live panes). */

function Frame({ children, height = 440 }: { children: React.ReactNode; height?: number }) {
  return (
    <div className="relative p-3" style={{ height }}>
      <ThemeBg />
      {children}
    </div>
  );
}

function Popup({ title, children, height }: { title: string; children: React.ReactNode; height?: number }) {
  const [open, setOpen] = React.useState(true);
  return (
    <Frame height={height}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open popup</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} size="prompt">
        <div className="space-y-4">{children}</div>
      </Dialog>
    </Frame>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-fg-muted">{children}</p>;
}

// ---- 1. Fold-out sections ("Show details", "Sync log", "Advanced") --------------

export type FoldStyle = 'triangle' | 'chevron-left' | 'row' | 'button';

function Fold({ style, label, children }: { style: FoldStyle; label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const body = open && <div className="mt-2 text-2xs text-fg-muted space-y-1">{children}</div>;
  if (style === 'row') {
    // Like Local models' "Advanced": a whole boxed row, arrow on the right.
    return (
      <div>
        <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center justify-between rounded-lg bg-inset/50 px-3 py-2.5 text-xs font-medium text-fg hover:bg-inset">
          {label}
          <ChevronDown className={`w-3 h-3 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} />
        </button>
        {body}
      </div>
    );
  }
  if (style === 'button') {
    return (
      <div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          <span className="inline-flex items-center gap-1">{label}<ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} /></span>
        </Button>
        {body}
      </div>
    );
  }
  // Today: two different small grey text styles, a ▸ triangle and a › arrow.
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 text-2xs text-fg-muted hover:text-fg">
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>{style === 'triangle' ? '▸' : '›'}</span>
        {label}
      </button>
      {body}
    </div>
  );
}

const LOG = ['2:14 pm · pushed 3 conversations', '2:02 pm · pulled Encyclopedia', '1:40 pm · pushed memory'];

export function FoldDemo({ style }: { style: FoldStyle }) {
  return (
    <Popup title="Backup & Sync">
      <SettingRow variant="item" title="GitHub" description={<RowStatus dotClassName="bg-green-500">Synced 2 minutes ago</RowStatus>} control={<Toggle checked onChange={() => {}} aria-label="GitHub" />} />
      <Fold style={style} label="Sync log">{LOG.map((l) => <p key={l}>{l}</p>)}</Fold>
      <Fold style={style} label="Advanced"><p>Sync every 5 minutes · keep 30 days of history</p></Fold>
    </Popup>
  );
}

// ---- 2. An error inside a setting ("Couldn't sync") -----------------------------

export type ErrorStyle = 'today' | 'box-under' | 'whole-card';

export function SettingErrorDemo({ style }: { style: ErrorStyle }) {
  const msg = 'Sync hit an unexpected problem. It will keep retrying; if it keeps failing, report it from Settings → Development.';
  let block: React.ReactNode;
  if (style === 'today') {
    block = (
      <div className="rounded-xl bg-inset/50 border border-edge-dim p-3 space-y-2">
        <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-sm font-medium text-fg flex-1">Couldn&apos;t sync</span><Toggle checked onChange={() => {}} aria-label="Sync" /></div>
        <p className="text-xs text-destructive-fg">{msg}</p>
        <div className="flex items-center justify-between"><span className="text-2xs text-fg-muted">▸ Show details</span><Button size="sm">Try again</Button></div>
      </div>
    );
  } else if (style === 'box-under') {
    // The setting keeps its normal row; the problem sits in the tinted danger box
    // you chose for warnings, with its action on the right.
    block = (
      <div className="space-y-2">
        <SettingRow variant="item" title="Sync with GitHub" description={<RowStatus dotClassName="bg-red-500">Couldn&apos;t sync</RowStatus>} control={<Toggle checked onChange={() => {}} aria-label="Sync" />} />
        <Callout tone="danger" title="Couldn't sync">{msg}</Callout>
        <div className="flex justify-end gap-2"><Button variant="secondary" size="sm">Show details</Button><Button size="sm">Try again</Button></div>
      </div>
    );
  } else {
    block = (
      <div className="rounded-lg p-3 border bg-destructive/10 border-destructive/50 space-y-2">
        <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-xs font-medium text-fg flex-1">Couldn&apos;t sync</span><Toggle checked onChange={() => {}} aria-label="Sync" /></div>
        <p className="text-xs text-fg-2">{msg}</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" size="sm">Show details</Button><Button size="sm">Try again</Button></div>
      </div>
    );
  }
  return (
    <Popup title="Backup & Sync">
      {block}
      <div className="space-y-1.5"><Label>Additional backups</Label>
        <SettingRow variant="item" title="Google Drive" description={<RowStatus dotClassName="bg-green-500">Backed up 5 minutes ago</RowStatus>} control={<Toggle checked onChange={() => {}} aria-label="Google Drive" />} />
      </div>
    </Popup>
  );
}

// ---- 3. Small follow-up actions ("Back up all now", "Sync now", "Clear") --------

export type FollowStyle = 'link' | 'outlined-right' | 'outlined-full' | 'row';

export function FollowUpDemo({ style }: { style: FollowStyle }) {
  const rows = (
    <>
      <SettingRow variant="item" title="Google Drive" description={<RowStatus dotClassName="bg-green-500">Backed up 5 minutes ago</RowStatus>} control={<Toggle checked onChange={() => {}} aria-label="Google Drive" />} />
      <SettingRow variant="item" title="iCloud" description={<RowStatus dotClassName="bg-green-500">Backed up 1 hour ago</RowStatus>} control={<Toggle checked onChange={() => {}} aria-label="iCloud" />} />
    </>
  );
  let action: React.ReactNode;
  if (style === 'link') action = <button type="button" className="text-xs text-fg-2 underline">Back up all now</button>;
  if (style === 'outlined-right') action = <div className="flex justify-end"><Button variant="secondary" size="sm">Back up all now</Button></div>;
  if (style === 'outlined-full') action = <Button variant="secondary" size="md" className="w-full">Back up all now</Button>;
  if (style === 'row') action = <SettingRow variant="item" title="Back up all now" description="Every backup above, right away." control={<Button variant="secondary" size="sm">Back up</Button>} />;
  return (
    <Popup title="Backup & Sync">
      <div className="space-y-1.5"><Label>Additional backups</Label>{rows}{action}</div>
      <div className="space-y-1.5"><Label>This computer</Label>
        <SettingRow variant="item" title="Back up when closing" description="Save a copy each time YouCoded quits." control={<Toggle checked={false} onChange={() => {}} aria-label="Back up when closing" />} />
      </div>
    </Popup>
  );
}

// ---- 4. A status on a list item ("Download interrupted", "Damaged") -------------

export type ItemStatusStyle = 'banner' | 'pill' | 'box';

function ModelCard({ name, detail, children, top, pill }: { name: string; detail: string; children?: React.ReactNode; top?: React.ReactNode; pill?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-inset/50 border border-edge-dim overflow-hidden">
      {top}
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0"><p className="text-xs font-medium text-fg flex items-center gap-2">{name}{pill}</p><p className="text-3xs text-fg-muted">{detail}</p></div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ItemStatusDemo({ style }: { style: ItemStatusStyle }) {
  const tint = (tone: 'amber' | 'red') => (tone === 'amber' ? 'bg-amber-500/15 border-amber-500/30' : 'bg-destructive/15 border-destructive/50');
  const pill = (tone: 'amber' | 'red', text: string) => <span className={`rounded-full border px-2 text-2xs font-normal text-fg-2 ${tint(tone)}`}>{text}</span>;
  const banner = (tone: 'amber' | 'red', text: string) => <div className={`text-center text-3xs py-0.5 ${tone === 'amber' ? 'bg-amber-500 text-black' : 'bg-red-400 text-black'}`}>{text}</div>;
  const actions = (a: string) => <div className="flex justify-end gap-2"><Button variant="danger-outline" size="sm">Delete</Button><Button size="sm">{a}</Button></div>;
  return (
    <Popup title="Local models" height={520}>
      <div className="space-y-2">
        <ModelCard name="Qwen3.5-9B" detail="8.9 GB · highest quality">
          <div className="flex justify-end gap-2"><Button variant="secondary" size="sm">Settings</Button><Button variant="danger-outline" size="sm">Delete</Button></div>
        </ModelCard>
        <ModelCard
          name="Qwen3.8-Flash"
          detail="66% — 74.2 of 113 GB"
          top={style === 'banner' ? banner('amber', 'Download interrupted') : undefined}
          pill={style === 'pill' ? pill('amber', 'Download interrupted') : undefined}
        >
          <ProgressBar percent={66} aria-label="Download progress" />
          {style === 'box' && <Callout tone="warning">Download interrupted. Resume picks up where it stopped.</Callout>}
          {actions('Resume')}
        </ModelCard>
        <ModelCard
          name="Gemma-4-12b"
          detail="7.4 GB"
          top={style === 'banner' ? banner('red', 'Damaged') : undefined}
          pill={style === 'pill' ? pill('red', 'Damaged') : undefined}
        >
          {style === 'box' && <Callout tone="danger">This file is damaged. Download it again to use it.</Callout>}
          {actions('Download again')}
        </ModelCard>
      </div>
    </Popup>
  );
}

// ---- 5. The button inside a text box (Remote Access "Set") ----------------------

export type InboxStyle = 'outlined' | 'filled' | 'ghost' | 'arrow';

export function InboxButtonDemo({ style }: { style: InboxStyle }) {
  const [v, setV] = React.useState('correct horse');
  const btn = style === 'arrow'
    ? <Button variant="primary" size="icon" aria-label="Set password">→</Button>
    : <Button variant={style === 'filled' ? 'primary' : style === 'ghost' ? 'ghost' : 'secondary'} size="sm">Set</Button>;
  return (
    <Popup title="Remote Access" height={360}>
      <div className="space-y-1.5"><Label>Access</Label>
        <SettingRow variant="item" title="Allow remote access" description="Use YouCoded from a phone or another computer." control={<Toggle checked onChange={() => {}} aria-label="Allow remote access" />} />
        <div className="rounded-lg bg-inset/50 px-3 py-2.5 space-y-2">
          <div><p className="text-xs font-medium text-fg">Password</p><p className="text-3xs text-fg-muted">At least 8 characters. Changing it signs out every device.</p></div>
          <InputGroup size="md">
            <InputGroup.Field type="password" value={v} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setV(e.target.value)} aria-label="Password" />
            {btn}
          </InputGroup>
        </div>
      </div>
    </Popup>
  );
}

// ---- 6. Consent checkbox ("I understand…") --------------------------------------

export type ConsentStyle = 'today' | 'boxed-left' | 'boxed-right' | 'switch';

export function ConsentDemo({ style }: { style: ConsentStyle }) {
  const [ok, setOk] = React.useState(false);
  const text = 'I understand, and I use Skip Permissions at my own risk.';
  let row: React.ReactNode;
  if (style === 'today') {
    row = <label className="flex items-start gap-2 text-xs text-fg-2"><Checkbox checked={ok} onChange={setOk} aria-label={text} className="mt-0.5" />{text}</label>;
  } else if (style === 'switch') {
    row = <SettingRow variant="item" title={text} control={<Toggle checked={ok} onChange={setOk} aria-label={text} />} />;
  } else {
    row = (
      <label className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-xs text-fg cursor-pointer ${ok ? 'border-accent bg-accent/10' : 'border-edge-dim bg-inset/50'} ${style === 'boxed-right' ? 'flex-row-reverse justify-between' : ''}`}>
        <Checkbox checked={ok} onChange={setOk} aria-label={text} />
        <span className="flex-1">{text}</span>
      </label>
    );
  }
  return (
    <Popup title="Skip Permissions Mode" height={400}>
      <p className="text-xs text-fg-2">The assistant will not ask before taking actions or running commands. Be careful with smaller models.</p>
      {row}
      <div className="flex flex-col gap-2">
        <Button variant="danger" size="lg" className="w-full py-1.5" disabled={!ok}>Turn it on</Button>
        <Button variant="secondary" size="lg" className="w-full py-1.5">Cancel</Button>
      </div>
    </Popup>
  );
}

// ---- 7. A status card holding boxes (top of Remote Access / Backup & Sync) ------

export type StatusCardStyle = 'nested' | 'strip-only' | 'plain-intro';

export function StatusCardDemo({ style }: { style: StatusCardStyle }) {
  const intro = 'Remote access lets you use YouCoded from any device — phone, tablet or another computer.';
  const strip = <StatusStrip tone="idle" action={<Button size="sm">Set up</Button>}>Not set up yet.</StatusStrip>;
  let top: React.ReactNode;
  if (style === 'nested') {
    top = <div className="rounded-xl border border-edge-dim bg-inset/30 p-3 space-y-2"><p className="text-xs text-fg-2">{intro}</p>{strip}</div>;
  } else if (style === 'strip-only') {
    top = <StatusStrip tone="idle" detail={intro} action={<Button size="sm">Set up</Button>}>Not set up yet.</StatusStrip>;
  } else {
    top = <div className="space-y-2"><p className="text-xs text-fg-2">{intro}</p>{strip}</div>;
  }
  return (
    <Popup title="Remote Access" height={380}>
      {top}
      <div className="space-y-1.5"><Label>Server</Label>
        <SettingRow variant="item" title="Allow remote access" description="Use YouCoded from a phone or another computer." control={<Toggle checked={false} onChange={() => {}} aria-label="Allow remote access" />} />
      </div>
    </Popup>
  );
}
