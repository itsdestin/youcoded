import React, { useEffect, useState } from 'react';
import { Button, ChevronDown, PluginIcon, SettingRow, Toggle, Tooltip } from '../../../components/ui';
import { SkillIcon, ToolIcon } from '../../../components/marketplace/type-icons';

// WHY this fixture lives in the renderer: the visual review uses the same theme tokens
// and controls as the app, but these examples never write to an installed plugin.
type Part = { name: string; kind: string; active?: boolean };
type Plugin = { name: string; defaultOn: boolean; bundled?: boolean; parts?: Part[] };
const RESEARCH: Plugin = { name: 'Research Kit', defaultOn: false, parts: [
  { name: 'Find sources', kind: 'Skill' },
  { name: 'Summarize sources', kind: 'Skill' },
  { name: 'Research sources', kind: 'Tool connection', active: true },
] };
// WHY: the post-install screen promises "Choices save as you make them". A
// module-level store keeps that promise inside one workbench page load, so
// closing and reopening the panel, or visiting the project's Skills & tools
// tab, shows the same switches. It is still sample state: nothing is written.
type Choice = { enabled: boolean; parts: boolean[]; chosen: boolean };
const previewChoices = new Map<string, Choice>();
const previewInstalled: Plugin[] = [];
const choiceKey = (project: string, plugin: Plugin) => `${project}::${plugin.name}`;

const BUNDLED: Plugin[] = [
  { name: 'Chat Search', defaultOn: true, bundled: true },
  { name: 'Page Builder', defaultOn: true, bundled: true },
  { name: 'Marketplace Publisher', defaultOn: true, bundled: true },
  { name: 'Theme Builder', defaultOn: false, bundled: true },
];

function PluginRow({ plugin, project, locked = false, initiallyOpen = false, flat = false, projectTab = false, onEnabledChange }: { plugin: Plugin; project: string; locked?: boolean; initiallyOpen?: boolean; flat?: boolean; projectTab?: boolean; onEnabledChange?: (enabled: boolean) => void }) {
  const saved = locked ? undefined : previewChoices.get(choiceKey(project, plugin));
  const [enabled, setEnabled] = useState(saved?.enabled ?? (locked || plugin.defaultOn));
  const [hasChosenParts, setHasChosenParts] = useState(saved?.chosen ?? false);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [parts, setParts] = useState(() => saved?.parts ?? (plugin.parts ?? []).map(() => false));
  const [pending, setPending] = useState<{ kind: 'master' | 'part'; index?: number } | null>(null);
  useEffect(() => {
    if (!locked) previewChoices.set(choiceKey(project, plugin), { enabled, parts, chosen: hasChosenParts });
  }, [locked, project, plugin, enabled, parts, hasChosenParts]);
  const hasActivePart = plugin.parts?.some(part => part.active) ?? false;
  // WHY: the decision is ONE confirmation naming every part that connects or runs
  // on its own; a hardcoded sample name would be wrong for any other plugin.
  const risky = pending?.kind === 'part' && pending.index !== undefined
    ? [plugin.parts![pending.index].name]
    : (plugin.parts ?? []).filter(part => part.active).map(part => part.name);
  const riskCopy = `${risky.join(', ')} can connect to outside services or run on ${risky.length > 1 ? 'their' : 'its'} own when a new conversation in ${project} begins. Only turn this on if you trust ${plugin.name}.`;
  const toggleMaster = (next: boolean) => {
    if (next && hasActivePart && !enabled) { setPending({ kind: 'master' }); return; }
    setEnabled(next);
    if (next && !hasChosenParts) { setParts(current => current.map(() => true)); setHasChosenParts(true); }
    onEnabledChange?.(next);
  };
  const togglePart = (index: number, next: boolean) => {
    if (next && plugin.parts?.[index].active) { setPending({ kind: 'part', index }); return; }
    setParts(current => current.map((value, i) => i === index ? next : value));
    setHasChosenParts(true);
  };
  const confirm = () => {
    if (pending?.kind === 'master') {
      setEnabled(true);
      onEnabledChange?.(true);
      // WHY: first enable chooses the plugin's parts; a pause preserves even an
      // intentionally all-off set of individual choices.
      if (!hasChosenParts) { setParts(current => current.map(() => true)); setHasChosenParts(true); }
    }
    if (pending?.kind === 'part' && pending.index !== undefined) {
      const index = pending.index;
      setParts(current => current.map((value, i) => i === index ? true : value));
      setHasChosenParts(true);
    }
    setPending(null);
  };
  const masterControl = locked ? (
    // A disabled switch cannot receive pointer hover, so the app's Tooltip anchors to a focusable wrapper.
    <Tooltip text="Included with Your Assistant; can't turn off here. Other projects have their own choices.">
      <span tabIndex={0} aria-label={`${plugin.name} is always available in Your Assistant`} className="inline-flex shrink-0 cursor-help opacity-60 grayscale">
        <Toggle checked disabled onChange={() => {}} aria-label={`${plugin.name} always on in ${project}`} />
      </span>
    </Tooltip>
  ) : <Toggle checked={enabled} onChange={toggleMaster} aria-label={`${plugin.name} in ${project}`} />;
  // WHY: the source label alone hid whether a bundled item is actually on; describe both.
  const description = locked ? 'Always on in Your Assistant' : plugin.bundled ? `Built in · Automatic use ${enabled ? 'on' : 'off'}` : enabled ? 'Automatic use on in new conversations' : 'Automatic use off · Turn on to include its skills';
  if (projectTab) {
    // WHY: a tab is a different surrounding surface than the previously approved
    // standalone install sketch. Match ContextTab's full-width callout, group
    // headers, font scale and one-row-per-item rhythm without undoing the sketch.
    return <section className="rounded-lg border border-edge-dim bg-panel overflow-hidden">
      <SettingRow variant="nav" className="!bg-transparent" icon={<PluginIcon />} title={plugin.name}
        description={description} descriptionClassName={WRAP}
        accessory={plugin.parts?.length ? <Button variant="ghost" size="icon" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${plugin.name} items`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90'}`} /></Button> : undefined}
        control={masterControl} />
      {!!plugin.parts?.length && expanded && <div className="space-y-2 px-3 pb-3 sm:pl-12">{plugin.parts.map((part, index) => {
        const control = <Toggle checked={parts[index]} disabled={!enabled} onChange={next => togglePart(index, next)} aria-label={`${part.name} in ${project}`} />;
        const status = !enabled ? 'Paused with plugin' : `Automatic use ${parts[index] ? 'on' : 'off'}`;
        return <SettingRow key={part.name} variant="nav" className="!bg-inset/50 border border-edge-dim" icon={part.active ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
          title={part.name} description={`${part.kind} · ${status}${part.active ? ' · Needs local setup' : ''}`} descriptionClassName={WRAP} control={control} />;
      })}</div>}
      {pending && <div role="alertdialog" aria-label="Confirm automatic connection" className="mx-3 mb-3 rounded-lg border border-edge bg-inset p-3">
        <div className="text-sm font-medium text-fg">Allow automatic connections?</div>
        <p className="mt-1 text-xs text-fg-2">{riskCopy}</p>
        <div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={confirm}>Enable</Button><Button size="sm" variant="secondary" onClick={() => setPending(null)}>Cancel</Button></div>
      </div>}
    </section>;
  }
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
        const description = `${part.kind} · ${!enabled ? 'Paused with plugin' : `Automatic use ${parts[index] ? 'on' : 'off'}`}${part.active ? ' · Needs local setup' : ''}`;
        return flat ? <SettingRow key={part.name} variant="item" title={part.name} description={description} control={control} /> : <div key={part.name} className="flex min-h-12 items-center justify-between gap-3 py-2">
          <div className="min-w-0"><div className="text-sm text-fg">{part.name}</div><div className="text-xs text-fg-muted">{description}</div></div>{control}
        </div>;
      })}</div>}
    </>}
    {pending && <div role="alertdialog" aria-label="Confirm automatic connection" className="mt-4 rounded-lg border border-edge bg-inset p-3">
      <div className="text-sm font-medium text-fg">Allow automatic connections?</div>
      <p className="mt-1 text-xs text-fg-2">{riskCopy}</p>
      <div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={confirm}>Enable</Button><Button size="sm" variant="secondary" onClick={() => setPending(null)}>Cancel</Button></div>
    </div>}
  </section>;
}

// WHY: SettingRow's nav density truncates descriptions to one line, which on a
// 390px phone cut "Add the skill file here…" mid-word. These rows carry the
// only explanation of what to do, so they wrap instead.
const WRAP = 'text-fg-muted !whitespace-normal';

// WHY: "Set up locally" had no destination. No YouCoded screen manages tool
// connections today, so the honest preview is a short explanation plus the two
// things a user could actually do; which one ships is a question for Destin.
function NeedsSetupRow({ icon, title, kind, need, actions }: { icon: React.ReactNode; title: string; kind: string; need: string; actions: string[] }) {
  const [open, setOpen] = useState(false);
  return <div className="rounded-lg border border-edge-dim bg-panel">
    <SettingRow variant="nav" className="!bg-transparent" icon={icon} title={title} description={`${kind} · Not on this device`} descriptionClassName={WRAP}
      accessory={<Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>Set up here</Button>} />
    {open && <div className="mx-3 mb-3 rounded-lg border border-edge-dim bg-inset p-3">
      <p className="text-xs text-fg-2">{need}</p>
      <div className="mt-3 flex flex-wrap gap-2">{actions.map((label, index) => <Button key={label} size="sm" variant={index === 0 ? 'primary' : 'secondary'}>{label}</Button>)}</div>
    </div>}
  </div>;
}

function FreshProjectRow({ name, plugin, initiallyOpen = false }: { name: string; plugin: Plugin; initiallyOpen?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [active, setActive] = useState(() => previewChoices.get(choiceKey(name, plugin))?.enabled ?? plugin.defaultOn);
  // WHY: reuse the group anatomy of AssistantTurnBubble: one outlined parent,
  // a shared header, and children lifted inside a symmetric inset body.
  return <section className="overflow-hidden rounded-lg border border-edge bg-panel">
    <SettingRow title={name} className="!bg-transparent hover:!bg-inset/50" description={`Automatic use ${active ? 'on' : 'off'} in new conversations`} expanded={expanded} onClick={() => setExpanded(value => !value)} />
    {/* WHY: collapsing a project must not remount the fixture and erase its choices. */}
    <div className={expanded ? 'px-2 pb-2' : 'hidden'}><PluginRow plugin={plugin} project={name} initiallyOpen flat onEnabledChange={setActive} /></div>
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

// WHY: render this design inside the real ProjectView hero, tabs and scroll model;
// local sample data cannot install or change an actual plugin on either platform.
export function ProjectSkillsTabDemo({ projectName }: { projectName: string }) {
  const assistant = projectName === 'Your Assistant';
  // WHY: sibling Projects tabs fill this column and use one explainer, micro-labels
  // and full-width rows. The narrow centered settings stack read as a foreign page.
  return <div className="flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-1 pb-4 min-w-0 max-sm:h-auto max-sm:overflow-visible">
    <div className="flex-1 overflow-auto max-sm:overflow-visible flex flex-col content-start p-2 -m-2">
      {/* WHY: Destin approved the full-width Projects rows but explicitly rejected
          the About bubble; keep only the essential behavior in quiet inline copy. */}
      <p className="mb-4 px-1 text-xs text-fg-muted leading-relaxed shrink-0">Changes apply to new conversations in {projectName}. To call an off skill yourself, type / in chat.</p>
      <section aria-label="Included plugins" className="mb-5 shrink-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1"><span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Built into YouCoded</span><span className="text-xs text-fg-muted">{assistant ? 'Included here · Cannot turn off · Other projects choose separately' : 'Ready to choose for this project'}</span></div>
        <div className="flex flex-col gap-2">{BUNDLED.map(plugin => <PluginRow key={plugin.name} plugin={plugin} project={projectName} locked={assistant} projectTab />)}</div>
      </section>
      <section aria-label="Installed plugins" className="mb-5 shrink-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1"><span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Added on this device</span><span className="text-xs text-fg-muted">Choose which parts can be used automatically</span></div>
        <div className="flex flex-col gap-2">
          <PluginRow plugin={RESEARCH} project={projectName} initiallyOpen projectTab />
          {/* WHY: a plugin set up from the Marketplace preview appears here with the same switches. */}
          {previewInstalled.map(plugin => <PluginRow key={plugin.name} plugin={plugin} project={projectName} projectTab />)}
        </div>
      </section>
      <section id="project-tools-needing-setup" aria-label="Items needing setup on this device" className="mb-5 shrink-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1"><span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Needs setup on this device</span><span className="text-xs text-fg-muted">Project choices are saved; these items cannot run here yet</span></div>
        <div className="flex flex-col gap-2">
          <NeedsSetupRow icon={<SkillIcon size={17} />} title="Writing helper" kind="Personal skill"
            need="This project has Writing helper turned on, but its skill file was added on another device. Personal skill files don't sync yet."
            actions={['Ask assistant to add it', 'Choose skill file']} />
          <NeedsSetupRow icon={<ToolIcon size={17} />} title="Library search" kind="Tool connection (MCP server)"
            need="This project has Library search turned on. Its connection and any sign-in stay on the device where they were set up, so it needs setting up here too."
            actions={['Ask assistant to set it up']} />
        </div>
      </section>
    </div>
  </div>;
}

export function ProjectPluginControlsDemo({ arrangement, previewPlugin, previewProjects, titleInParent = false }: { arrangement: 'fresh' | 'library'; previewPlugin?: Plugin; previewProjects?: string[]; titleInParent?: boolean }) {
  const plugin = previewPlugin ?? RESEARCH;
  useEffect(() => {
    if (previewPlugin && !previewInstalled.some(p => p.name === previewPlugin.name)) previewInstalled.push(previewPlugin);
  }, [previewPlugin]);
  const projects = previewProjects ?? ['Your Assistant', 'Personal', 'School notes'];
  if (arrangement === 'fresh') return <main className="mx-auto max-w-[820px] space-y-4 p-4 text-fg">
    <div>{!titleInParent && <h2 className="text-lg font-semibold">{plugin.name}</h2>}<p className="text-xs text-fg-muted">Installed on this device. Choose where the assistant can use it automatically in new conversations.</p></div>
    <div className="space-y-2">{projects.map((name, index) => <FreshProjectRow key={name} name={name} plugin={plugin} initiallyOpen={index === 0} />)}</div>
    <p className="text-xs text-fg-muted">Choices save as you make them. Leave now and finish later in Projects.</p>
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
