// ProjectSetupPanel — the production Marketplace post-install "choose your
// projects" panel (T6, project-plugin-controls). Replaces the workbench-only
// `ProjectPluginControlsDemo arrangement="fresh"` fixture
// (dev/workbench/mockups/ProjectPluginControls.tsx, `FreshProjectRow`) with
// real data: every project from `artifacts:list-projects-index`, the first
// one expanded (R20 — matters most on a phone, where there is no hover to
// discover a row is expandable), each loading its OWN Skills & tools view
// lazily on expand and showing ONLY the just-installed plugin's group —
// every other plugin in that project is Skills & tools' job, not this
// panel's. Reuses `SkillsToolsTab`'s own exported `PluginGroupRow` (same
// master switch + parts anatomy, same copy) and the shared
// `useProjectExtensionsController` hook, so a toggle here writes through
// `project-extensions:set` with the identical optimistic/serialized/risk-
// popup semantics as the tab — never a second, slightly different copy of
// that logic.
//
// R19 ("it starts off everywhere"): nothing here forces that — it is a
// property of how `project-extensions:get` SEEDS a project's record (see
// resolve.ts's `defaultPluginOn` / store.ts's `ensureSeeded`). This panel
// just shows whatever that seeding already decided and lets the user change
// it per project.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ErrorState, LoadingState, EmptyState, SettingRow, Dialog } from '../ui';
import { useChunkedReveal } from '../../hooks/use-chunked-reveal';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import {
  useProjectExtensionsController, type PluginGroup, type PendingRisk,
} from '../../hooks/useProjectExtensionsController';
import { PluginGroupRow } from '../project-view/SkillsToolsTab';
import type { CentralIndexProject } from '../../../shared/artifacts/types';

export interface ProjectSetupPanelProps {
  pluginId: string;
}

type ProjectsLoadState =
  | { kind: 'loading' }
  // Android's `SessionService.kt` answers `artifacts:list-projects-index`
  // `not-implemented-on-mobile` — there is no Projects screen there at all
  // (design's own source facts). The panel renders null in this case, so
  // MarketplaceDetailOverlay falls back to today's plain installed view.
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; projects: CentralIndexProject[] };

function useProjectsIndex(): [ProjectsLoadState, () => void] {
  const [state, setState] = useState<ProjectsLoadState>({ kind: 'loading' });
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const gen = ++generation.current;
    setState({ kind: 'loading' });
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (gen !== generation.current) return;
      if (res?.ok && Array.isArray(res.projects)) setState({ kind: 'ready', projects: res.projects });
      else if (res?.error === 'not-implemented-on-mobile') setState({ kind: 'unavailable' });
      else setState({ kind: 'error', message: res?.error ? String(res.error) : 'Could not load your projects.' });
    }).catch((err: any) => {
      if (gen === generation.current) setState({ kind: 'error', message: err?.message ? String(err.message) : String(err) });
    });
  }, [attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, reload];
}

// Risk confirmation — identical copy/shape to SkillsToolsTab's own inline
// Dialog (R3/R23: turning on a tool connection always confirms first). Not
// pulled into a shared component: both call sites already share the ONE
// thing that matters (the `Dialog` UI primitive + the `PendingRisk` the
// controller hook computes) — this is just that primitive filled in twice,
// which `.claude/rules/react-renderer.md`'s "every control goes through its
// primitive" is about, not about a single JSX composition living in one place.
function RiskDialog({
  pendingRisk, projectName, onCancel, onConfirm,
}: {
  pendingRisk: PendingRisk;
  projectName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onClose={onCancel} layer={3} size="prompt" title={`Turn on ${pendingRisk.displayName}?`} scrollBody={false}>
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
          When it&apos;s on, every new conversation in {projectName} starts it automatically, and it can reach
          services outside YouCoded without asking each time. Only turn it on if you trust where it came from.
        </p>
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>Turn on</Button>
        </div>
      </div>
    </Dialog>
  );
}

// One project's row. Fetches lazily on expand (kept mounted, never
// unmounted, while collapsed — collapsing a project must not remount this
// and erase an in-flight choice, matching the approved FreshProjectRow
// fixture's own comment) and shows ONLY the just-installed plugin's group.
const ProjectSetupRow = React.memo(function ProjectSetupRow({
  project, pluginId, initiallyOpen,
}: {
  project: CentralIndexProject;
  pluginId: string;
  initiallyOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const {
    state, saveError, pendingRisk, requestPluginToggle, requestItemToggle, confirmRisk, cancelRisk, retryLastFailed, reload,
  } = useProjectExtensionsController(project.path, expanded);

  const group: PluginGroup | undefined = state.kind === 'ready'
    ? [...state.view.builtIn, ...state.view.installed].find((g) => g.pluginId === pluginId)
    : undefined;

  // F4 (T6 review): the controller's per-path "shown for" gate is
  // deliberately once-only (performance.md rule 2 — collapsing and
  // re-expanding an already-LOADED row must cost nothing), but that gate
  // also swallowed a retry for the two cases where re-expanding should DO
  // something: a fetch that failed outright (`state.kind === 'error'`), and
  // the documented "install finished a moment before this row's own catalog
  // scan ran" race (`state.kind === 'ready'` but the just-installed plugin's
  // group hasn't shown up yet — the "Not available here yet" text above).
  // `reload()` bypasses the gate unconditionally, so this effect fires it
  // ONLY on an actual collapse->expand transition (never on the initial
  // mount, and never again while `expanded` stays true) and only when the
  // last fetch left the row in one of those two states — an ordinary
  // successful fetch with the group present must stay lazy-once, exactly
  // like SkillsToolsTab's own use of this same hook.
  const wasExpandedRef = useRef(expanded);
  useEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (!expanded || wasExpanded) return; // only a real collapse->expand edge
    if (state.kind === 'error' || (state.kind === 'ready' && !group)) reload();
  }, [expanded, state, group, reload]);

  // Coordinator fix: a COLLAPSED row that has never been expanded never
  // fetches at all (the controller's `active` gate — see
  // useProjectExtensionsController's own "fetch lazily" comment), so its
  // `state` sits at the hook's initial `{kind:'loading'}` forever, not
  // because anything is actually in flight. Showing "Loading…" there was
  // simply wrong — nothing is loading until the row is expanded. Only the
  // FIRST row starts expanded (R20); every other row must show no
  // description (never a guess at on/off before its own fetch has run) until
  // `expanded` is true and a real fetch can be in flight.
  const description = state.kind === 'ready' && group
    ? `Automatic use ${group.on ? 'on' : 'off'} in new conversations`
    : state.kind === 'ready'
      // The plugin hasn't shown up in this project's own catalog scan yet —
      // rare (a race between install finishing and this row's own fetch);
      // reopening the row re-fetches and self-heals.
      ? 'Not available here yet'
      : expanded
        ? 'Loading…'
        : undefined;

  return (
    <section className="overflow-hidden rounded-lg border border-edge bg-panel">
      {/* flat (not a caller className restyle): this row already sits
          directly on the section's own `bg-panel` — SettingRow's default
          `bg-inset/50` would paint a visible seam, and `flat` is the
          primitive's own documented way to omit it. The row is clickable
          (onClick), so SettingRow's own `hover:bg-inset` still applies. */}
      <SettingRow
        title={project.name} flat
        description={description}
        expanded={expanded} onClick={() => setExpanded((v) => !v)}
      />
      <div className={expanded ? 'px-2 pb-2' : 'hidden'}>
        {/* `expanded` guard (not just `state.kind`): a collapsed, never-
            fetched row sits at the controller's initial `loading` state
            forever (nothing is actually in flight) — this content is CSS-
            hidden while collapsed either way, but rendering "Loading…" into
            it for a fetch that was never started is still the same wrong
            claim the row's own description above was making. */}
        {state.kind === 'loading' && expanded && <p className="px-2 py-3 text-xs text-fg-muted">Loading…</p>}
        {state.kind === 'error' && (
          <div className="p-2"><ErrorState mode="recoverable" message={state.message} onRetry={reload} /></div>
        )}
        {state.kind === 'ready' && saveError && (
          <div className="p-2"><ErrorState mode="recoverable" message={saveError} onRetry={retryLastFailed} /></div>
        )}
        {state.kind === 'ready' && group && (
          <PluginGroupRow
            group={group}
            initiallyOpen
            onToggleMaster={(next) => requestPluginToggle(group, next)}
            onTogglePart={requestItemToggle}
          />
        )}
      </div>
      {pendingRisk && (
        <RiskDialog pendingRisk={pendingRisk} projectName={project.name} onCancel={cancelRisk} onConfirm={confirmRisk} />
      )}
    </section>
  );
}, (a, b) => a.project === b.project && a.pluginId === b.pluginId && a.initiallyOpen === b.initiallyOpen);

export function ProjectSetupPanel({ pluginId }: ProjectSetupPanelProps) {
  const [projectsState, reloadProjects] = useProjectsIndex();
  const scrollRef = useRef<HTMLDivElement>(null);
  const noRoot = useRef<HTMLElement | null>(null);
  const narrow = useNarrowViewport();
  const projects = projectsState.kind === 'ready' ? projectsState.projects : [];
  // Renderer-lists.md: "a card/row list of the user's own things uses
  // useChunkedReveal". Projects have no enforced cap — a user can add
  // arbitrarily many saved folders / sync projects over time, the same "list
  // of the user's own things" class as Conversations and Skills — so this
  // gets the same chunked-reveal treatment rather than assuming the common
  // case (a handful of projects) is the only case. resetKey is constant:
  // there is no filter/search here, and the panel itself remounts per
  // plugin (MarketplaceDetailOverlay resets on `targetKey`).
  const { visible, hasMore, sentinelRef } = useChunkedReveal(projects, {
    resetKey: '',
    rootRef: narrow ? noRoot : scrollRef,
  });

  if (projectsState.kind === 'unavailable') return null;

  return (
    <div>
      <p className="text-xs text-fg-muted">
        Installed on this device. Choose where the assistant can use it automatically in new conversations.
      </p>
      <div className="mt-4">
        {projectsState.kind === 'loading' && <LoadingState what="your projects" />}
        {projectsState.kind === 'error' && (
          <ErrorState mode="recoverable" message={projectsState.message} onRetry={reloadProjects} />
        )}
        {projectsState.kind === 'ready' && projects.length === 0 && (
          <EmptyState message="No projects yet." />
        )}
        {projectsState.kind === 'ready' && projects.length > 0 && (
          <div ref={scrollRef} className="space-y-2">
            {visible.map((project, index) => (
              <ProjectSetupRow key={project.id || project.path} project={project} pluginId={pluginId} initiallyOpen={index === 0} />
            ))}
            {hasMore && <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />}
          </div>
        )}
      </div>
      {projectsState.kind === 'ready' && projects.length > 0 && (
        <p className="mt-4 text-xs text-fg-muted">Choices save as you make them. Leave now and finish later in Projects.</p>
      )}
    </div>
  );
}
