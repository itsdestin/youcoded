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
//
// T6: the load/commit/risk engine below moved to the shared
// `useProjectExtensionsController` hook (hooks/useProjectExtensionsController.ts)
// so the Marketplace post-install panel (ProjectSetupPanel.tsx) gets the SAME
// optimistic/serialized write semantics rather than a second hand-copied
// implementation. This file keeps only what's specific to the TAB: rendering
// every section (built-in/installed/personal/needs-setup) and the needs-setup
// popup's "ask assistant" / "choose skill file" actions.
import React, { useCallback, useState } from 'react';
import { Button, ChevronDown, Dialog, ErrorState, LoadingState, EmptyState, PluginIcon, SettingRow, Toggle } from '../ui';
import { SkillIcon, ToolIcon } from '../marketplace/type-icons';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import {
  useProjectExtensionsController, type PluginGroup, type PartRow, type NeedsSetupRowData,
} from '../../hooks/useProjectExtensionsController';

export interface SkillsToolsTabProps {
  hidden: boolean;
  project: CentralIndexProject;
  /** Reuses App's own new-conversation path (createSession's initialInput
   *  param) — "Ask assistant to set it up" starts a session in this project
   *  with a prefilled request. initialInput is optional only so this prop's
   *  type stays assignable from ProjectHero's plain `(cwd) => void` handler. */
  onNewConversation: (cwd: string, initialInput?: string) => void;
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

// F6 (T4 review): a stable DOM id for one needs-setup row, so
// PROJECT_VIEW_OPEN_SKILLS_TAB's optional `itemKey` (artifact-actions.ts) can
// scroll to THAT row instead of only the whole section — exported so
// ProjectView's scroll effect builds the identical id without a second copy
// of the scheme. `itemKey` values (`mcp:foo`, `self:bar`) never contain
// whitespace today; the replace is a defensive belt for a future one that did.
export function needsSetupRowDomId(itemKey: string): string {
  return `project-tools-needing-setup-item-${itemKey.replace(/\s+/g, '-')}`;
}

function kindLabel(kind: NeedsSetupRowData['kind']): string {
  if (kind === 'personal-skill') return 'Personal skill';
  if (kind === 'tool-connection') return 'Tool connection (MCP server)';
  return 'Plugin';
}

// Exported (T6): the Marketplace post-install panel (ProjectSetupPanel.tsx)
// reuses this row verbatim for the one just-installed plugin's master switch
// + parts inside each project — same anatomy, same copy, so the two surfaces
// can never drift apart into two slightly different renderings of "a plugin
// group in a project".
export function PluginGroupRow({
  group, onToggleMaster, onTogglePart, initiallyOpen = false,
}: {
  group: PluginGroup;
  onToggleMaster: (next: boolean) => void;
  onTogglePart: (part: PartRow, next: boolean) => void;
  /** ProjectSetupPanel's own approved anatomy shows the just-installed
   *  plugin's parts immediately once its project row is expanded — no
   *  second chevron to find (R20: "without an extra tap"). The tab's own
   *  call sites don't pass this, keeping every plugin group collapsed by
   *  default there (unchanged from T4). */
  initiallyOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const description = group.bundled
    ? `Built in · Automatic use ${group.on ? 'on' : 'off'}`
    : group.on ? 'Automatic use on in new conversations' : 'Automatic use off · Turn on to include its skills';
  return (
    <section className="rounded-lg border border-edge-dim bg-panel overflow-hidden">
      <SettingRow
        variant="nav" flat icon={<PluginIcon />} title={group.displayName}
        description={description} wrapDescription
        accessory={group.parts.length ? (
          <Button variant="ghost" size="icon" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.displayName} items`} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            <ChevronDown className="h-4 w-4" expanded={expanded} />
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
                key={part.key} variant="nav" bordered
                icon={part.kind === 'mcp' ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
                title={part.displayName}
                description={`${part.kind === 'mcp' ? 'Tool connection' : 'Skill'} · ${status}${part.needsLocalSetup ? ' · Needs local setup' : ''}`}
                wrapDescription
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
        variant="nav" flat
        icon={part.kind === 'mcp' ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
        title={part.displayName}
        description={`${part.kind === 'mcp' ? 'Tool connection' : 'Skill'} · Automatic use ${part.on ? 'on' : 'off'}${part.needsLocalSetup ? ' · Needs local setup' : ''}`}
        wrapDescription
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
    <div id={needsSetupRowDomId(row.key)} className="rounded-lg border border-edge-dim bg-panel">
      <SettingRow
        variant="nav" flat
        icon={row.kind === 'tool-connection' ? <ToolIcon size={17} /> : <SkillIcon size={17} />}
        title={row.displayName} description={`${kindLabel(row.kind)} · Not on this device`} wrapDescription
        accessory={<Button size="sm" variant="secondary" onClick={onOpen}>Set up here</Button>}
      />
    </div>
  );
}

function SkillsToolsTabImpl({ hidden, project, onNewConversation }: SkillsToolsTabProps) {
  const {
    state, saveError, pendingRisk, reload, requestPluginToggle, requestItemToggle, confirmRisk, cancelRisk, retryLastFailed,
  } = useProjectExtensionsController(project.path, !hidden);
  const [setupFor, setSetupFor] = useState<NeedsSetupRowData | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

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
      reload();
    } finally {
      setImportBusy(false);
    }
  }, [reload]);

  if (state.kind === 'unavailable') return null;

  return (
    <div className={hidden ? 'hidden' : 'flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-1 pb-4 min-w-0 max-sm:h-auto max-sm:overflow-visible'}>
      <div className="flex-1 overflow-auto max-sm:overflow-visible flex flex-col content-start p-2 -m-2">
        {state.kind === 'loading' && <LoadingState what="Skills & tools" />}
        {state.kind === 'error' && (
          <ErrorState mode="recoverable" message={state.message} onRetry={reload} />
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
        <Dialog open onClose={cancelRisk} layer={3} size="prompt" title={`Turn on ${pendingRisk.displayName}?`} scrollBody={false}>
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
              <Button variant="secondary" onClick={cancelRisk}>Cancel</Button>
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
