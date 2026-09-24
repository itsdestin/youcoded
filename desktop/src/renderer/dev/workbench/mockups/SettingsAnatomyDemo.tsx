import React from 'react';
import { Button, Dialog, TextInput, Toggle, Select, SegmentedTabs, SettingRow, RowStatus } from '../../../components/ui';
import { ThemeBg } from '../../../components/ThemeBg';

/** WHY (design-guide review, 2026-09-24): Destin finds Settings cluttered, and the
 *  audit found "a label with a control" laid out five ways (hint above, hint
 *  below, control right, boxed radios, no label). One realistic popup — modelled
 *  on Remote Access, one of the messiest today — drawn with the real Dialog,
 *  SettingRow, Toggle, TextInput, Select and SegmentedTabs, so each layout
 *  question can be answered by looking. Only the arrangement varies.
 *  Dev-only (compare registry → live panes). */

export type ControlLayout = 'below' | 'beside' | 'mixed';
export type ChoiceStyle = 'segmented' | 'radios' | 'select';
export type Nesting = 'nested' | 'flat';
export type Spacing = 'compact' | 'roomy';

const KEEP_AWAKE = [
  { value: 'off', label: 'Off' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: '8h', label: '8 hours' },
  { value: 'always', label: 'Always' },
] as const;

function Label({ children }: { children: React.ReactNode }) {
  // The decided small section label: 12px medium, grey, normal case.
  return <p className="text-xs font-medium text-fg-muted">{children}</p>;
}

/** Title + hint, then the control on its own line — the "FieldRow" shape. */
function Below({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-inset/50 px-3 py-2.5 space-y-2">
      <div>
        <p className="text-xs font-medium text-fg">{title}</p>
        <p className="text-3xs text-fg-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Choice({ style, value, onChange }: { style: ChoiceStyle; value: string; onChange: (v: string) => void }) {
  if (style === 'segmented') {
    return <SegmentedTabs variant="contained" tabs={KEEP_AWAKE.map((o) => ({ id: o.value, label: o.label }))} value={value} onChange={onChange} aria-label="Keep awake" />;
  }
  if (style === 'select') {
    return <Select options={KEEP_AWAKE} value={value} onChange={onChange} aria-label="Keep awake" className="w-full" />;
  }
  return (
    <div className="space-y-1" role="radiogroup" aria-label="Keep awake">
      {KEEP_AWAKE.map((o) => (
        <SettingRow key={o.value} variant="item" title={o.label} selected={value === o.value} onSelect={() => onChange(o.value)} radioLabel={o.label} />
      ))}
    </div>
  );
}

export function SettingsAnatomyDemo({
  layout = 'mixed', choice = 'select', nesting = 'flat', spacing = 'compact',
}: { layout?: ControlLayout; choice?: ChoiceStyle; nesting?: Nesting; spacing?: Spacing }) {
  const [open, setOpen] = React.useState(true);
  const [on, setOn] = React.useState(true);
  const [awake, setAwake] = React.useState('4h');
  const [drive, setDrive] = React.useState(true);
  const section = spacing === 'roomy' ? 'space-y-6' : 'space-y-4';
  const inner = spacing === 'roomy' ? 'space-y-2' : 'space-y-1.5';

  const allow = layout === 'below'
    ? <Below title="Allow remote access" hint="Use YouCoded from a phone or another computer's browser."><Toggle checked={on} onChange={setOn} aria-label="Allow remote access" /></Below>
    : <SettingRow variant="item" title="Allow remote access" description="Use YouCoded from a phone or another computer's browser." control={<Toggle checked={on} onChange={setOn} aria-label="Allow remote access" />} />;

  const password = layout === 'beside'
    ? <SettingRow variant="item" title="Password" description="Needed to sign in from another device." control={<TextInput type="password" defaultValue="hunter22" aria-label="Password" className="w-36" />} />
    : <Below title="Password" hint="Needed to sign in from another device."><TextInput type="password" defaultValue="hunter22" aria-label="Password" className="w-full" /></Below>;

  const keepAwake = layout === 'beside' && choice === 'select'
    ? <SettingRow variant="item" title="Keep awake" description="Stop this computer sleeping while you're away." control={<Select options={KEEP_AWAKE} value={awake} onChange={setAwake} aria-label="Keep awake" className="w-32" />} />
    : <Below title="Keep awake" hint="Stop this computer sleeping while you're away."><Choice style={choice} value={awake} onChange={setAwake} /></Below>;

  const destinations = (
    <>
      <SettingRow variant="item" title="GitHub" description={<RowStatus dotClassName="bg-green-500">Backed up 2 minutes ago</RowStatus>} />
      <SettingRow variant="item" title="Google Drive" description={<RowStatus dotClassName="bg-green-500">Backed up 5 minutes ago</RowStatus>} control={<Toggle checked={drive} onChange={setDrive} aria-label="Google Drive" />} />
    </>
  );
  const backups = nesting === 'nested' ? (
    // Today's Backup & Sync shape: an outer card holding a status line and inner cards.
    <div className="rounded-lg border border-edge-dim bg-inset/50 p-3 space-y-2">
      <p className="text-xs font-medium text-fg">Backups <span className="ml-1 rounded-full border border-edge-dim px-1.5 text-3xs text-fg-muted">optional</span></p>
      <p className="text-3xs text-fg-muted">A second copy on top of GitHub.</p>
      <div className="rounded-lg border border-edge-dim bg-panel p-2 space-y-1.5">{destinations}</div>
      <button type="button" className="w-full rounded-lg border border-dashed border-edge-dim py-1.5 text-xs text-fg-muted">+ Add a backup</button>
    </div>
  ) : (
    <div className={inner}>
      <Label>Backups</Label>
      {destinations}
      <Button variant="secondary" size="md" className="w-full">Add a backup</Button>
    </div>
  );

  return (
    <div className="relative p-4" style={{ height: 760 }}>
      <ThemeBg />
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open popup</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Remote Access" size="panel">
        <div className={section} style={spacing === 'roomy' ? { padding: '4px 4px' } : undefined}>
          <div className={inner}>
            <Label>Access</Label>
            {allow}
            {password}
          </div>
          <div className={inner}>
            <Label>This computer</Label>
            {keepAwake}
          </div>
          {backups}
        </div>
      </Dialog>
    </div>
  );
}
