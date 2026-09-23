import React, { useState } from 'react';
import { Button, ChevronDown, SettingRow, Toggle, Tooltip } from '../../../components/ui';

// WHY this fixture lives in the renderer: the visual review uses the same theme tokens
// and controls as the app, but these examples never write to an installed plugin.
type Part = { name: string; kind: string; active?: boolean };
type Plugin = { name: string; defaultOn: boolean; bundled?: boolean; parts?: Part[] };
const RESEARCH: Plugin = { name: 'Research Kit', defaultOn: false, parts: [
  { name: 'Find sources', kind: 'Skill' },
  { name: 'Summarize sources', kind: 'Skill' },
  { name: 'Research sources', kind: 'MCP server', active: true },
] };
const BUNDLED: Plugin[] = [
  { name: 'Chat Search', defaultOn: true, bundled: true },
  { name: 'Page Builder', defaultOn: true, bundled: true },
  { name: 'Marketplace Publisher', defaultOn: true, bundled: true },
  { name: 'Theme Builder', defaultOn: false, bundled: true },
];

function PluginRow({ plugin, project, locked = false, initiallyOpen = false, flat = false }: { plugin: Plugin; project: string; locked?: boolean; initiallyOpen?: boolean; flat?: boolean }) {
  const [enabled, setEnabled] = useState(locked || plugin.defaultOn);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [parts, setParts] = useState(() => (plugin.parts ?? []).map(() => false));
  const [pending, setPending] = useState<{ kind: 'master' | 'part'; index?: number } | null>(null);
  const hasActivePart = plugin.parts?.some(part => part.active) ?? false;
  const toggleMaster = (next: boolean) => {
    if (next && hasActivePart && !enabled) { setPending({ kind: 'master' }); return; }
    setEnabled(next);
  };
  const togglePart = (index: number, next: boolean) => {
    if (next && plugin.parts?.[index].active) { setPending({ kind: 'part', index }); return; }
    setParts(current => current.map((value, i) => i === index ? next : value));
  };
  const confirm = () => {
    if (pending?.kind === 'master') {
      setEnabled(true);
      // A first enable selects all parts; after a master pause, preserve choices.
      setParts(current => current.some(Boolean) ? current : current.map(() => true));
    }
    if (pending?.kind === 'part' && pending.index !== undefined) {
      const index = pending.index;
      setParts(current => current.map((value, i) => i === index ? true : value));
    }
    setPending(null);
  };
  const masterControl = locked ? (
    // A disabled switch cannot receive pointer hover, so the app's Tooltip anchors to a focusable wrapper.
    <Tooltip text="Always available in Your Assistant">
      <span tabIndex={0} aria-label={`${plugin.name} is always available in Your Assistant`} className="inline-flex shrink-0 cursor-help opacity-60 grayscale">
        <Toggle checked disabled onChange={() => {}} aria-label={`${plugin.name} always on in ${project}`} />
      </span>
    </Tooltip>
  ) : <Toggle checked={enabled} onChange={toggleMaster} aria-label={`${plugin.name} in ${project}`} />;
  const description = locked ? 'Included with Your Assistant' : plugin.bundled ? 'Included with YouCoded' : enabled ? 'Automatic use on' : 'Automatic use off';
  // WHY: mirror YouCoded's existing collapsible group anatomy (outer card,
  // shared header/background, inset body with separate item cards).
  return <section className={flat ? 'overflow-hidden rounded-lg border border-edge bg-well' : 'rounded-lg border border-edge bg-panel p-4'}>
    {flat ? <SettingRow variant="item" className="!bg-transparent" title={plugin.name} description={description}
      accessory={<Button variant="ghost" size="icon" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${plugin.name} items`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
      </Button>}
      control={masterControl} /> : <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><div className="text-sm font-semibold text-fg">{plugin.name}</div><div className="mt-0.5 text-xs text-fg-muted">{description}</div></div>
      {masterControl}
    </div>}
    {!!plugin.parts?.length && <>
      {!flat && <Button variant="ghost" size="sm" className="mt-3" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        {expanded ? 'Hide' : 'Show'} {plugin.parts.length} items
      </Button>}
      {expanded && <div className={flat ? 'space-y-1 px-2 pb-2' : 'mt-2 divide-y divide-edge-dim border-t border-edge-dim'}>{plugin.parts.map((part, index) => {
        // WHY: pausing the master preserves item choices, but cannot activate a single item accidentally.
        const control = <Toggle checked={parts[index]} disabled={!enabled} onChange={next => togglePart(index, next)} aria-label={`${part.name} in ${project}`} />;
        const description = `${part.kind}${part.active ? ' · Set up on this device if needed' : ''}`;
        return flat ? <SettingRow key={part.name} variant="item" title={part.name} description={description} control={control} /> : <div key={part.name} className="flex min-h-12 items-center justify-between gap-3 py-2">
          <div className="min-w-0"><div className="text-sm text-fg">{part.name}</div><div className="text-xs text-fg-muted">{description}</div></div>{control}
        </div>;
      })}</div>}
    </>}
    {pending && <div role="alertdialog" aria-label="Confirm automatic connection" className="mt-4 rounded-lg border border-edge bg-inset p-3">
      <div className="text-sm font-medium text-fg">Allow automatic connections?</div>
      <p className="mt-1 text-xs text-fg-2">Research sources can connect to its configured server when a new conversation begins. Review what it can access before enabling it in {project}.</p>
      <div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={confirm}>Enable</Button><Button size="sm" variant="secondary" onClick={() => setPending(null)}>Cancel</Button></div>
    </div>}
  </section>;
}

function FreshProjectRow({ name }: { name: string }) {
  const [expanded, setExpanded] = useState(name === 'Your Assistant');
  // WHY: reuse the group anatomy of AssistantTurnBubble: one outlined parent,
  // a shared header, and children lifted inside a symmetric inset body.
  return <section className="overflow-hidden rounded-lg border border-edge bg-panel">
    <SettingRow title={name} className="!bg-transparent hover:!bg-inset/50" description="Set up for this project" expanded={expanded} onClick={() => setExpanded(value => !value)} />
    {expanded && <div className="px-2 pb-2"><PluginRow plugin={RESEARCH} project={name} initiallyOpen flat /></div>}
  </section>;
}

function ProjectCard({ name, assistant = false }: { name: string; assistant?: boolean }) {
  const [expanded, setExpanded] = useState(assistant);
  const plugins = [...BUNDLED, RESEARCH];
  return <section className="rounded-xl border border-edge bg-canvas p-4">
    <Button variant="ghost" className="w-full justify-between" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="text-base font-semibold">{name}</span>
      <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
    </Button>
    {expanded && <div className="mt-3 space-y-2">{plugins.map(plugin => <PluginRow key={plugin.name} plugin={plugin} project={name} locked={assistant && !!plugin.bundled} initiallyOpen={false} />)}</div>}
  </section>;
}

export function ProjectPluginControlsDemo({ arrangement }: { arrangement: 'fresh' | 'library' }) {
  if (arrangement === 'fresh') return <main className="mx-auto max-w-[820px] space-y-4 bg-canvas p-4 text-fg">
    <div><h2 className="text-lg font-semibold">Research Kit</h2><p className="mt-1 text-xs text-fg-muted">Choose where this download is available. Changes apply to new conversations.</p></div>
    <div className="space-y-2"><FreshProjectRow name="Your Assistant" /><FreshProjectRow name="Personal" /><FreshProjectRow name="School notes" /></div>
    <p className="text-xs text-fg-muted">You can leave now and set this up later in Projects.</p>
  </main>;
  return <main className="mx-auto max-w-[820px] space-y-3 bg-canvas p-4 text-fg">
    <header className="border-b border-edge pb-3"><p className="text-xs text-fg-muted">Projects</p><h2 className="mt-1 text-lg font-semibold">Skills & tools by project</h2>
      <p className="mt-1 text-xs text-fg-muted">Changes apply to new conversations. Closing this page keeps anything you installed.</p>
    </header>
    <ProjectCard name="Your Assistant" assistant />
    <ProjectCard name="Personal" />
    <p className="px-1 text-xs text-fg-muted">Incognito conversations have no automatically available skills.</p>
  </main>;
}
