// desktop/src/renderer/hooks/useProjectExtensionsController.ts
//
// T6 (project-plugin-controls) — the optimistic/serialized load+write engine
// against project-extensions:get/set, shared by the Projects → Skills & tools
// tab (SkillsToolsTab.tsx) and the Marketplace post-install "choose your
// projects" panel (ProjectSetupPanel.tsx). Both need the EXACT same
// semantics: fetch lazily (only while `active`, and again if the project
// changes while active — performance.md rule 2, "hidden means idle"), an
// optimistic write reconciled against the real response, writes serialized
// onto the tail of the previous one so two quick toggles both land (T4 review
// F3 — see its own comment on `writeChainRef` below), and the risk-
// confirmation gate before any change that turns ON a tool connection
// (R3/R23). Extracted out of SkillsToolsTab (which used to own all of this
// directly) so the setup panel's toggle behavior can never drift from the
// tab's — a second hand-copied implementation is exactly how the two would
// eventually disagree on a fix like F3.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectExtensionsChange, ProjectExtensionsGetResult } from '../../shared/types';

// The two Result types (get/set) share the same `view` shape (shared/types.ts:
// `ProjectExtensionsSetResult = ProjectExtensionsGetResult`); its row/group
// shapes aren't separately exported (knip flags an export nothing outside
// view.ts names by type — see that file's own header), so derive them here
// instead of duplicating the interfaces. SkillsToolsTab and ProjectSetupPanel
// both import these aliases from here rather than redeclaring them.
// Not exported by name (knip flags an exported type nothing imports BY
// NAME — see this file's own convention below, borrowed from view.ts):
// `PluginGroup`/`PartRow`/`NeedsSetupRowData` (which ARE imported elsewhere)
// already carry everything a caller needs structurally.
type SkillsToolsView = Extract<ProjectExtensionsGetResult, { ok: true }>['view'];
export type PluginGroup = SkillsToolsView['builtIn'][number];
export type PartRow = PluginGroup['parts'][number];
export type NeedsSetupRowData = SkillsToolsView['needsSetup'][number];

type ProjectExtensionsLoadState =
  | { kind: 'loading' }
  // Android's `SessionService.kt` (and any future non-desktop backend)
  // answers every project-extensions:* channel `not-implemented-on-mobile`,
  // same convention as artifacts:* — B-2 defers Android entirely.
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; view: SkillsToolsView };

export type PendingRisk =
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

export interface ProjectExtensionsController {
  state: ProjectExtensionsLoadState;
  /** The last write's error, if any — separate from `state`'s own 'error'
   *  kind (a fetch failure) so a save failure can be shown ALONGSIDE the
   *  still-rendered (reverted) view rather than blanking it. */
  saveError: string | null;
  pendingRisk: PendingRisk | null;
  /** Re-fetches unconditionally — used after an out-of-band write (importing
   *  a personal skill file) and by the fetch-error retry button. */
  reload: () => void;
  requestPluginToggle: (group: PluginGroup, next: boolean) => void;
  requestItemToggle: (part: PartRow, next: boolean) => void;
  confirmRisk: () => void;
  cancelRisk: () => void;
  retryLastFailed: () => void;
}

/**
 * `active` gates the fetch exactly like SkillsToolsTab's own `hidden` prop
 * did before this was extracted: nothing is fetched until `active` is true
 * for this `projectPath`, and staying active while the path changes
 * refetches — but becoming inactive and active again for the SAME path costs
 * nothing (performance.md rule 2 — a Skills & tools tab switched away and
 * back, or a setup-panel row collapsed and re-expanded, must not re-fetch).
 */
export function useProjectExtensionsController(projectPath: string, active: boolean): ProjectExtensionsController {
  const [state, setState] = useState<ProjectExtensionsLoadState>({ kind: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingRisk, setPendingRisk] = useState<PendingRisk | null>(null);

  // Snapshot of the last known-good view, for reverting an optimistic write
  // that the main process refused or that threw. A ref (not state) because it
  // must be readable synchronously inside `commit` without waiting on a
  // render, and it should never itself trigger one.
  const viewRef = useRef<SkillsToolsView | null>(null);
  useEffect(() => { if (state.kind === 'ready') viewRef.current = state.view; }, [state]);
  // The last failed write, so the error's Retry button re-attempts the SAME
  // change rather than doing nothing or re-fetching the whole tab.
  const lastFailedRef = useRef<{ change: ProjectExtensionsChange; optimistic: (v: SkillsToolsView) => SkillsToolsView } | null>(null);
  // Serializes writes (T4 review F3): `commit` used to read `viewRef.current`
  // as its `prev` snapshot, but the ref was only advanced by the effect just
  // above — which runs AFTER the render commits, not synchronously inside
  // `commit` itself. Two toggles fired before that effect ran (same tick, or
  // a fast double-click on different rows) both computed their optimistic
  // view from the SAME stale `prev`, so the second silently overwrote the
  // first's in-flight change, and a first-request FAILURE could revert past
  // an already-applied second toggle. Chaining every write onto the tail of
  // the last one guarantees `prev` is always the settled outcome (success OR
  // revert) of every earlier write before the next one's snapshot is taken.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

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

  // Fetch lazily: the first time the caller actually marks this ACTIVE for a
  // project, not the moment the hook mounts — a tab kept mounted while hidden
  // (alongside FilesTab, for instant tab switches), or a setup-panel row not
  // yet expanded, must cost nothing until it is really shown. Tracks the path
  // already shown-for so a project switch WHILE active still refetches (path,
  // not object identity), but toggling active/inactive on an already-loaded
  // project doesn't.
  const shownForPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    if (shownForPathRef.current === projectPath) return;
    shownForPathRef.current = projectPath;
    void load(projectPath);
  }, [projectPath, active, load]);

  const commit = useCallback((change: ProjectExtensionsChange, optimistic: (v: SkillsToolsView) => SkillsToolsView) => {
    const run = async () => {
      const prev = viewRef.current;
      if (!prev) return;
      const next = optimistic(prev);
      // Synchronous — see writeChainRef's WHY above. Not just via the
      // `state.kind === 'ready'` effect, which would hand the NEXT queued
      // write (chained below) a stale snapshot.
      viewRef.current = next;
      setState({ kind: 'ready', view: next });
      setSaveError(null);
      try {
        const res = await (window.claude as any).projectExtensions.set(projectPath, [change]);
        if (res.ok) {
          viewRef.current = res.view;
          setState({ kind: 'ready', view: res.view });
          lastFailedRef.current = null;
        } else {
          viewRef.current = prev;
          setState({ kind: 'ready', view: prev });
          setSaveError(res.error);
          lastFailedRef.current = { change, optimistic };
        }
      } catch (err: any) {
        viewRef.current = prev;
        setState({ kind: 'ready', view: prev });
        setSaveError(err?.message ? String(err.message) : String(err));
        lastFailedRef.current = { change, optimistic };
      }
    };
    // Chain onto the tail regardless of the previous write's outcome — `run`
    // never itself rejects (its own try/catch handles every failure mode),
    // but `.then(run, run)` stays correct even if that ever changes.
    const chained = writeChainRef.current.then(run, run);
    writeChainRef.current = chained;
    return chained;
  }, [projectPath]);

  const retryLastFailed = useCallback(() => {
    const f = lastFailedRef.current;
    if (f) void commit(f.change, f.optimistic);
  }, [commit]);

  // R3/R23: turning ON a plugin whose parts include a tool connection (or
  // turning ON a tool connection directly) always confirms first — naming
  // every connection the change would activate. An automatically discoverable
  // SKILL alone never does. Applies uniformly to a plugin-scoped item AND a
  // personal/adopted one (Personal section) — both are the same "this can
  // reach outside services" action.
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

  const cancelRisk = useCallback(() => setPendingRisk(null), []);

  // Unconditional re-fetch: bypasses the shown-for-path gate so a caller that
  // just wrote something OUT OF BAND (a personal skill file import) or is
  // retrying a failed fetch always gets a fresh read.
  const reload = useCallback(() => {
    shownForPathRef.current = projectPath;
    void load(projectPath);
  }, [projectPath, load]);

  return { state, saveError, pendingRisk, reload, requestPluginToggle, requestItemToggle, confirmRisk, cancelRisk, retryLastFailed };
}
