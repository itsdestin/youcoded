// SkillsToolsTab — the production Projects → Skills & tools tab (T4,
// project-plugin-controls). Replaces the workbench-only ProjectSkillsTabDemo
// fixture with real data from `project-extensions:get/set` — same approved
// anatomy (full-width SettingRow groups, wrapping descriptions, popups for
// risk and setup) as the mockup this file supersedes:
// dev/workbench/mockups/ProjectPluginControls.tsx (`ProjectSkillsTabDemo`,
// `PluginRow` with `projectTab`, `NeedsSetupRow`, the risk Dialog). Kept
// mounted while hidden, like FilesTab (performance.md rule 2): `hidden` +
// `React.memo` + stable props + no own context read, so switching tabs never
// re-fetches and the tab is instant the second time it's shown. Your
// Assistant's locked rows are out of scope here (deferred to that project).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ChevronDown, Dialog, ErrorState, LoadingState, EmptyState, PluginIcon, SettingRow, Toggle } from '../ui';
import { SkillIcon, ToolIcon } from '../marketplace/type-icons';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import type { ProjectExtensionsChange, ProjectExtensionsGetResult } from '../../../shared/types';

// The two Result types (get/set) share the same `view` shape (shared/types.ts:
// `ProjectExtensionsSetResult = ProjectExtensionsGetResult`); its row/group
// shapes aren't separately exported (knip flags an export nothing outside
// view.ts names by type — see that file's own header), so derive them here
// instead of duplicating the interfaces.
type SkillsToolsView = Extract<ProjectExtensionsGetResult, { ok: true }>['view'];
type PluginGroup = SkillsToolsView['builtIn'][number];
type PartRow = PluginGroup['parts'][number];
type NeedsSetupRowData = SkillsToolsView['needsSetup'][number];

// SettingRow's nav density truncates descriptions to one line, which on a
// narrow phone cuts explanatory copy mid-word (R21). These rows carry the
// only explanation of what a row means or what to do about it, so they wrap.
const WRAP = 'text-fg-muted !whitespace-normal';

export interface SkillsToolsTabProps {
  hidden: boolean;
  project: CentralIndexProject;
  /** Reuses App's own new-conversation path (createSession's initialInput
   *  param) — "Ask assistant to set it up" starts a session in this project
   *  with a prefilled request. initialInput is optional only so this prop's
   *  type stays assignable from ProjectHero's plain `(cwd) => void` handler. */
  onNewConversation: (cwd: string, initialInput?: string) => void;
}

type LoadState =
  | { kind: 'loading' }
  // Android's `SessionService.kt` (and any future non-desktop backend)
  // answers every project-extensions:* channel `not-implemented-on-mobile`,
  // same convention as artifacts:* — B-2 defers Android entirely. Android's
  // Projects screen doesn't exist at all today (design's own source facts),
  // and a remote browser always talks to a desktop backend, so this branch
  // is unreachable in production; it exists so a future backend that DOES
  // answer this way degrades to "nothing here" instead of an error banner.
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; view: SkillsToolsView };

type PendingRisk =
  | { kind: 'plugin'; pluginId: string; displayName: string; connections: string[] }
  | { kind: 'item'; itemKey: string; displayName: string; connections: string[] };

function withPluginOn(view: SkillsToolsView, pluginId: string, on: boolean): SkillsToolsView {
  const patch = (g: PluginGroup): PluginGroup => (g.pluginId === pluginId ? { ...g, on, paused: !on } : g);
  return { ...view, builtIn: view.builtIn.map(patch), installed: view.installed.map(patch) };
}

function withItemOn(view: SkillsToolsView, itemKey: string, on: boolean): SkillsToolsView {
  const patchPart = (p: PartRow): PartRow => (p.key === itemKey ? { ...p, on } : p);
  const patchGroup = (g: PluginGroup): PluginGroup => ({ ...g, parts: g.parts.map(patchPart) });
  return {
    ...view,
    builtIn: view.builtIn.map(patchGroup),
    installed: view.installed.map(patchGroup),
    personal: view.personal.map(patchPart),
  };
}

// Plain-language copy for a needs-setup row's popup — the ONLY place this
// tab asserts a cause, and every clause here is a verified fact from the
// row's own data (never a guess): design §5's three kinds.
function needCopy(projectName: string, row: NeedsSetupRowData): string {
  if (row.kind === 'personal-skill') {
    return `${projectName} has ${row.displayName} turned on, but its skill file was added on another device. Personal skill files don't sync yet.`;
  }
  if (row.kind === 'tool-connection') {
    return `${projectName} has ${row.displayName} turned on. Its connection and any sign-in stay on the device where they were set up, so it needs setting up here too.`;
  }
  return `${projectName} has ${row.displayName} turned on, but it isn't installed on this device.`;
}

function askAssistantPrompt(row: NeedsSetupRowData): string {
  if (row.kind === 'personal-skill') {
    return `Please help me set up the "${row.displayName}" skill for this project — it's turned on here but its skill file isn't on this device yet.`;
  }
  if (row.kind === 'tool-connection') {
    return `Please help me set up the "${row.displayName}" tool connection for this project — it's turned on here but needs its connection (and any sign-in) configured on this device.`;
  }
  return `Please help me install the "${row.displayName}" plugin — it's turned on for this project but isn't installed on this device yet.`;
}

function kindLabel(kind: NeedsSetupRowData['kind']): string {
  if (kind === 'personal-skill') return 'Personal skill';
  if (kind === 'tool-connection') return 'Tool connection (MCP server)';
  return 'Plugin';
}

function PluginGroupRow({
  group, onToggleMaster, onTogglePart,
}: {
  group: PluginGroup;
  onToggleMaster: (next: boolean) => void;
  onTogglePart: (part: PartRow, next: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const description = group.bundled
    ? `Built in · Automatic use ${group.on ? 'on' : 'off'}`
    : group.on ? 'Automatic use on in new conversations' : 'Automatic use off · Turn on to include its skills';
  return (
    <section className="rounded-lg border border-edge-dim bg-panel overflow-hidden">
      <SettingRow
        variant="nav" className="!bg-transparent" icon={<PluginIcon />} title={group.displayName}
        description={description} descriptionClassName={WRAP}
        accessory={group.parts.length ? (
          <Button variant="ghost" size="icon" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.displayName} items`} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
          </Button>
        ) : undefined}
        control={<Toggle checked={group.on} onChange={onToggleMaster} aria-label={`${group.displayName} in this project`} />}
      />
      {!!group.parts.length && expanded && (
        <div className="space-y-2 px-3 pb-3 sm:pl-12">
          {group.parts.map((part) => {
            const status = group.paused ? 'Paused with plugin' : `Automatic use ${part.on ? 'on' : 'off'}`;
            return (
              <SettingRow
                key={part.key} variant="nav" className="!bg-inset/50 border border-edge-dim"
                icon={part.kind === 'mcp' ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
                title={part.displayName}
                description={`${part.kind === 'mcp' ? 'Tool connection' : 'Skill'} · ${status}${part.needsLocalSetup ? ' · Needs local setup' : ''}`}
                descriptionClassName={WRAP}
                control={<Toggle checked={part.on} disabled={group.paused} onChange={(next) => onTogglePart(part, next)} aria-label={`${part.displayName} in this project`} />}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function PersonalItemRow({ part, onToggle }: { part: PartRow; onToggle: (next: boolean) => void }) {
  return (
    <section className="rounded-lg border border-edge-dim bg-panel overflow-hidden">
      <SettingRow
        variant="nav" className="!bg-transparent"
        icon={part.kind === 'mcp' ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
        title={part.displayName}
        description={`${part.kind === 'mcp' ? 'Tool connection' : 'Skill'} · Automatic use ${part.on ? 'on' : 'off'}${part.needsLocalSetup ? ' · Needs local setup' : ''}`}
        descriptionClassName={WRAP}
        control={<Toggle checked={part.on} onChange={onToggle} aria-label={`${part.displayName} in this project`} />}
      />
    </section>
  );
}

// "Set up here" explains why the item is missing and offers the two real
// paths (R16 / design §5): ask the assistant, or — for a personal skill only
// — pick the file yourself. A popup, not an inline box (Destin, combined
// review S-2: "dont want this inside the card. maybe a popup").
function NeedsSetupRow({ row, onOpen }: { row: NeedsSetupRowData; onOpen: () => void }) {
  return (
    <div className="rounded-lg border border-edge-dim bg-panel">
      <SettingRow
        variant="nav" className="!bg-transparent"
        icon={row.kind === 'tool-connection' ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
        title={row.displayName} description={`${kindLabel(row.kind)} · Not on this device`} descriptionClassName={WRAP}
        accessory={<Button size="sm" variant="secondary" onClick={onOpen}>Set up here</Button>}
      />
    </div>
  );
}

function SkillsToolsTabImpl({ hidden, project, onNewConversation }: SkillsToolsTabProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingRisk, setPendingRisk] = useState<PendingRisk | null>(null);
  const [setupFor, setSetupFor] = useState<NeedsSetupRowData | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Snapshot of the last known-good view, for reverting an optimistic write
  // that the main process refused or that threw. A ref (not state) because it
  // must be readable synchronously inside `commit` without waiting on a
  // render, and it should never itself trigger one.
  const viewRef = useRef<SkillsToolsView | null>(null);
  useEffect(() => { if (state.kind === 'ready') viewRef.current = state.view; }, [state]);
  // The last failed write, so the error's Retry button re-attempts the SAME
  // change rather than doing nothing or re-fetching the whole tab.
  const lastFailedRef = useRef<{ change: ProjectExtensionsChange; optimistic: (v: SkillsToolsView) => SkillsToolsView } | null>(null);

  const load = useCallback(async (path: string) => {
    setState({ kind: 'loading' });
    setSaveError(null);
    lastFailedRef.current = null;
    try {
      const res: ProjectExtensionsGetResult = await (window.claude as any).projectExtensions.get(path);
      if (res.ok) setState({ kind: 'ready', view: res.view });
      else if (res.error === 'not-implemented-on-mobile') setState({ kind: 'unavailable' });
      else setState({ kind: 'error', message: res.error });
    } catch (err: any) {
      setState({ kind: 'error', message: err?.message ? String(err.message) : String(err) });
    }
  }, []);

  // Re-fetch whenever the PROJECT actually changes (path, not object
  // identity — `project` gets a fresh object on every projects-index
  // refresh even for the same project, and re-fetching on those would waste
  // an IPC round trip for nothing that changed).
  useEffect(() => { void load(project.path); }, [project.path, load]);

  const commit = useCallback(async (change: ProjectExtensionsChange, optimistic: (v: SkillsToolsView) => SkillsToolsView) => {
    const prev = viewRef.current;
    if (!prev) return;
    setState({ kind: 'ready', view: optimistic(prev) });
    setSaveError(null);
    try {
      const res = await (window.claude as any).projectExtensions.set(project.path, [change]);
      if (res.ok) {
        setState({ kind: 'ready', view: res.view });
        lastFailedRef.current = null;
      } else {
        setState({ kind: 'ready', view: prev });
        setSaveError(res.error);
        lastFailedRef.current = { change, optimistic };
      }
    } catch (err: any) {
      setState({ kind: 'ready', view: prev });
      setSaveError(err?.message ? String(err.message) : String(err));
      lastFailedRef.current = { change, optimistic };
    }
  }, [project.path]);

  const retryLastFailed = useCallback(() => {
    const f = lastFailedRef.current;
    if (f) void commit(f.change, f.optimistic);
  }, [commit]);

  // R3/R23: turning ON a plugin whose parts include a tool connection (or
  // turning ON a tool connection directly) always confirms first — naming
  // every connection the change would activate. An automatically discoverable
  // SKILL alone never does. Applies uniformly to a plugin-scoped item AND a
  // personal/adopted one (Personal section) — both are the same "this can
  // reach outside services" action; the contract's examples happen to be
  // plugin-scoped, but nothing in R3/R23 restricts the rule to plugins.
  const requestPluginToggle = useCallback((group: PluginGroup, next: boolean) => {
    if (next) {
      const connections = group.parts.filter((p) => p.kind === 'mcp').map((p) => p.displayName);
      if (connections.length > 0) {
        setPendingRisk({ kind: 'plugin', pluginId: group.pluginId, displayName: group.displayName, connections });
        return;
      }
    }
    void commit({ plugin: group.pluginId, on: next }, (v) => withPluginOn(v, group.pluginId, next));
  }, [commit]);

  const requestItemToggle = useCallback((part: PartRow, next: boolean) => {
    if (next && part.kind === 'mcp') {
      setPendingRisk({ kind: 'item', itemKey: part.key, displayName: part.displayName, connections: [part.displayName] });
      return;
    }
    void commit({ item: part.key, on: next }, (v) => withItemOn(v, part.key, next));
  }, [commit]);

  const confirmRisk = useCallback(() => {
    if (!pendingRisk) return;
    if (pendingRisk.kind === 'plugin') {
      void commit({ plugin: pendingRisk.pluginId, on: true }, (v) => withPluginOn(v, pendingRisk.pluginId, true));
    } else {
      void commit({ item: pendingRisk.itemKey, on: true }, (v) => withItemOn(v, pendingRisk.itemKey, true));
    }
    setPendingRisk(null);
  }, [pendingRisk, commit]);

  // "Ask assistant to set it up": reuses App's existing new-conversation path
  // (createSession's initialInput param, threaded through
  // ProjectView.onNewConversation) rather than inventing a second one — the
  // same prefilled-input mechanism ReportDesign.tsx and the page-builder
  // dialogs already use.
  const askAssistant = useCallback((row: NeedsSetupRowData) => {
    setSetupFor(null);
    onNewConversation(project.path, askAssistantPrompt(row));
  }, [onNewConversation, project.path]);

  const chooseSkillFile = useCallback(async () => {
    setImportError(null);
    const paths: string[] = await (window.claude as any).dialog.openFile();
    if (!paths || paths.length === 0) return;
    setImportBusy(true);
    try {
      const res = await (window.claude as any).projectExtensions.importSkill(paths[0]);
      if (!res.ok) { setImportError(res.error); return; }
      setSetupFor(null);
      await load(project.path);
    } finally {
      setImportBusy(false);
    }
  }, [load, project.path]);

  if (state.kind === 'unavailable') return null;

  return (
    <div className={hidden ? 'hidden' : 'flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-1 pb-4 min-w-0 max-sm:h-auto max-sm:overflow-visible'}>
      <div className="flex-1 overflow-auto max-sm:overflow-visible flex flex-col content-start p-2 -m-2">
        {state.kind === 'loading' && <LoadingState what="Skills & tools" />}
        {state.kind === 'error' && (
          <ErrorState mode="recoverable" message={state.message} onRetry={() => load(project.path)} />
        )}
        {state.kind === 'ready' && (
          <>
            <p className="mb-4 px-1 text-xs text-fg-muted leading-relaxed shrink-0">
              Changes apply to new conversations in {project.name}. To call an off skill yourself, type / in chat.
            </p>
            {saveError && (
              <div className="mb-4 shrink-0">
                <ErrorState mode="recoverable" message={saveError} onRetry={retryLastFailed} />
              </div>
            )}
            {state.view.builtIn.length === 0 && state.view.installed.length === 0
              && state.view.personal.length === 0 && state.view.needsSetup.length === 0 ? (
              <EmptyState message="No skills or tools available yet." />
            ) : (
              <>
                {state.view.builtIn.length > 0 && (
                  <section aria-label="Included plugins" className="mb-5 shrink-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1">
                      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Built into YouCoded</span>
                      <span className="text-xs text-fg-muted">Ready to choose for this project</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {state.view.builtIn.map((g) => (
                        <PluginGroupRow key={g.pluginId} group={g} onToggleMaster={(next) => requestPluginToggle(g, next)} onTogglePart={requestItemToggle} />
                      ))}
                    </div>
                  </section>
                )}
                {state.view.installed.length > 0 && (
                  <section aria-label="Installed plugins" className="mb-5 shrink-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1">
                      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Added on this device</span>
                      <span className="text-xs text-fg-muted">Choose which parts can be used automatically</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {state.view.installed.map((g) => (
                        <PluginGroupRow key={g.pluginId} group={g} onToggleMaster={(next) => requestPluginToggle(g, next)} onTogglePart={requestItemToggle} />
                      ))}
                    </div>
                  </section>
                )}
                {state.view.personal.length > 0 && (
                  <section aria-label="Personal skills and tools" className="mb-5 shrink-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1">
                      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Personal skills &amp; tools</span>
                      <span className="text-xs text-fg-muted">Not part of any plugin</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {state.view.personal.map((part) => (
                        <PersonalItemRow key={part.key} part={part} onToggle={(next) => requestItemToggle(part, next)} />
                      ))}
                    </div>
                  </section>
                )}
                {state.view.needsSetup.length > 0 && (
                  <section id="project-tools-needing-setup" aria-label="Items needing setup on this device" className="mb-5 shrink-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2 px-1">
                      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Needs setup on this device</span>
                      <span className="text-xs text-fg-muted">Project choices are saved; these items cannot run here yet</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {state.view.needsSetup.map((row) => (
                        <NeedsSetupRow key={row.key} row={row} onOpen={() => setSetupFor(row)} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Risk confirmation — shown every time a change would turn on a tool
          connection (R23), whether from a plugin master or a single part. */}
      {pendingRisk && (
        <Dialog open onClose={() => setPendingRisk(null)} layer={3} size="prompt" title={`Turn on ${pendingRisk.displayName}?`} scrollBody={false}>
          <div className="p-5 space-y-3">
            <p className="text-xs text-fg-2">
              {pendingRisk.kind === 'item'
                ? 'This is a tool connection.'
                : `${pendingRisk.displayName} includes ${pendingRisk.connections.length > 1 ? 'tool connections' : 'a tool connection'}:`}
            </p>
            {pendingRisk.kind === 'plugin' && (
              <ul className="list-disc pl-5 text-xs text-fg">
                {pendingRisk.connections.map((name) => <li key={name}>{name}</li>)}
              </ul>
            )}
            <p className="text-xs text-fg-2">
              When it&apos;s on, every new conversation in {project.name} starts it automatically, and it can reach
              services outside YouCoded without asking each time. Only turn it on if you trust where it came from.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setPendingRisk(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmRisk}>Turn on</Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Needs-setup popup (R16/R22): explains why, then offers the two real
          paths — ask the assistant, or (personal skill only) choose the file. */}
      {setupFor && (
        <Dialog open onClose={() => setSetupFor(null)} layer={3} size="prompt" title={`Set up ${setupFor.displayName}`} scrollBody={false}>
          <div className="p-5 space-y-4">
            <p className="text-xs text-fg-2">{needCopy(project.name, setupFor)}</p>
            {importError && <ErrorState mode="recoverable" message={importError} onRetry={() => void chooseSkillFile()} />}
            <div className="flex flex-col gap-2">
              <Button variant="primary" className="w-full" onClick={() => askAssistant(setupFor)}>Ask assistant to set it up</Button>
              {setupFor.kind === 'personal-skill' && (
                <Button variant="secondary" className="w-full" onClick={() => void chooseSkillFile()} disabled={importBusy}>
                  {importBusy ? 'Choosing…' : 'Choose skill file'}
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// Kept mounted while hidden (performance.md rule 2), like FilesTab: memo +
// stable props (ProjectView hoists onNewConversation with useCallback) + no
// context read of its own — everything this component needs arrives as props.
export const SkillsToolsTab = React.memo(SkillsToolsTabImpl);
