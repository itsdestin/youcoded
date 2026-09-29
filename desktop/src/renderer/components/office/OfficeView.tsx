// OfficeView — the body of the built-in Office page (design stage, 2026-09-28).
//
// Lives in PageHost's frame pane in place of a page's iframe, so Office gets the
// page view's band, panel and pinned-button behaviour for free
// (office-questions#Q-entry: "a pinnable page"). Inside the pane:
//
//   ┌ [⌂ Home] [▤ Garden plan ×] [▦ Garden budget] [▢ Garden talk ☾]   Saved  [⟲ Versions] ┐
//   │                                                                                       │
//   │   the start screen (Home)  —or—  the Euro-Office editor for the front tab             │
//
// Decisions it draws (office-questions answers): tabs in one page (Q-tabs); idle
// tabs sleep to save memory (Q-sleep); the start screen offers New, Recent and
// this project's files (Q-start); saving is automatic, with kept versions to go
// back to (Q-save); the editor wears the theme — colours, font, glass and
// roundness (Q-theme). The editors are Euro-Office (office-base#Q-base-final),
// on their own sealed origin; only files and small messages cross.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, DocumentTabs, EmptyState, ErrorState, LoadingState } from '../ui';
import type { DocumentTab } from '../ui';
import type { OfficeBridge, OfficeFile, OfficeKind, OfficeStatus, OfficeVersion } from '../../../shared/office-types';
import { HistoryGlyph, HomeGlyph, KIND_LABEL, OfficeKindGlyph } from './office-icons';
import { HOME_TAB, cancelClose, closeDoc, finishClose, flushOffice, markCopied, noteCloseFailedWhileHidden, openDoc, replaceDoc, selectTab, showVersions, useCopying, useOfficeTabs, useSaveState } from './office-store';
import { officeFileFor } from './office-files';
import type { OfficeSaveState } from './office-store';
import { OfficeSaveFailed } from './OfficeSaveFailed';
import { EditorFrame, stripExt } from './EditorFrame';
import type { EditorFrameHandle } from './EditorFrame';
import { ScreenMark } from '../../shoot-mode';

function officeBridge(): OfficeBridge | undefined {
  return window.claude?.office;
}

// 'unavailable': this build or this host cannot run Office at all — a fact, not a failure.
type StatusLoad = { state: 'loading' } | { state: 'ready'; status: OfficeStatus } | { state: 'failed' } | { state: 'unavailable' };

/** projectRoot: the focused conversation's folder (PageHost passes it), for "In <project>". */
/** visible: false while the page view is closed or shows another page — the view stays mounted
 *  then, invisible but laid out (PageHost), so no open editor is torn down with unsaved changes
 *  (C2, fix round 1) and none is laid out at zero size. */
export function OfficeView({ projectRoot = null, visible = true }: { projectRoot?: string | null; visible?: boolean }) {
  const { docs, active, versionsFor } = useOfficeTabs();
  const [load, setLoad] = useState<StatusLoad>({ state: 'loading' });
  const reloadStatus = () => {
    const b = officeBridge();
    if (!b) { setLoad({ state: 'unavailable' }); return; }
    b.status(projectRoot).then(
      (status) => setLoad(status.available ? { state: 'ready', status } : { state: 'unavailable' }),
      // WHY (Task 5 carry-over): the remote client and the phone refuse office:* outright, and
      // their shim stays quiet for it, so this screen must say so itself — as the same fact,
      // with nothing to retry. Any other rejection is a real failure and keeps Retry.
      (e: unknown) => setLoad(/^remote-unsupported:/.test(String((e as Error)?.message ?? '')) ? { state: 'unavailable' } : { state: 'failed' }),
    );
  };
  useEffect(reloadStatus, [projectRoot]);
  // Each mounted editor's handle, so the strip's save-failed actions reach it.
  const frames = useRef(new Map<string, EditorFrameHandle>());

  const front = docs.find((d) => d.file.path === active && !d.closing) ?? null;
  const saveState = useSaveState(front?.file.path ?? null);
  // While Save a copy runs, the strip's buttons wait for it (fix round 5; the tab won't close).
  const copying = useCopying(front?.file.path ?? null);
  const frontPath = front?.file.path ?? null;
  // Stable per front file (fix round 2): a fresh object each render re-asked main whether a copy
  // can be saved on every render of the strip.
  const frontFrame = useMemo(() => ({ get current() { return frontPath ? frames.current.get(frontPath) : undefined; } }), [frontPath]);
  // Kept but hidden (fix round 2): whatever the editor had focused must not keep the keyboard —
  // typing in chat would otherwise land in a document nobody can see.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && rootRef.current?.contains(a)) a.blur();
  }, [visible]);
  const tabs: DocumentTab[] = [
    { id: HOME_TAB, label: 'Home', icon: <HomeGlyph />, closable: false },
    // A closing tab is gone from the strip at once; its editor finishes saving out of sight.
    ...docs.filter((d) => !d.closing).map((d) => ({ id: d.file.path, label: stripExt(d.file.name), icon: <OfficeKindGlyph kind={d.file.kind} />, asleep: d.asleep,
      // Its copy is being written (fix round 6, M6): the ✕ says why it does nothing yet.
      closeNote: copying && d.file.path === front?.file.path ? 'Saving a copy…' : undefined })),
  ];

  const create = async (kind: OfficeKind) => {
    const r = await officeBridge()?.create(kind, projectRoot);
    if (r?.ok) openDoc(r.file);
  };
  const pick = async () => {
    const f = await officeBridge()?.pick();
    if (f) openDoc(f);
  };

  return (
    <div ref={rootRef} className="absolute inset-0 flex flex-col">
      {/* min-h, not h: a failed save's message and Retry (below) are taller than the strip's
          44px; every other state keeps exactly that height. */}
      <div className="min-h-11 shrink-0 flex items-center gap-2 px-2 border-b border-edge-dim">
        <DocumentTabs label="Open documents" tabs={tabs} activeId={active} onSelect={selectTab} onClose={closeDoc} className="flex-1" />
        {front && (
          <div className="shrink-0 flex items-center gap-2 pl-2">
            {/* Saving is automatic (Q-save), so this only confirms it happened — or, when a save
                failed, says main's own reason with Retry (design §4; error-message-standards). */}
            {saveState.phase === 'failed'
              ? <OfficeSaveFailed
                  path={front.file.path}
                  className="max-w-xl"
                  message={saveState.message ?? "Office couldn't save this file."}
                  frame={frontFrame}
                  visible={visible}
                  onCloseWithoutSaving={() => closeDoc(front.file.path)}
                />
              : <span className="text-2xs text-fg-muted">{saveLabel(saveState)}</span>}
            <Button variant="ghost" size="sm" onClick={() => showVersions(front.file)} disabled={copying}>
              <HistoryGlyph />
              Versions
            </Button>
          </div>
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        {active === HOME_TAB && (
          <OfficeHome load={load} onRetry={reloadStatus} onCreate={create} onPick={pick} onOpen={openDoc} />
        )}
        {/* Awake documents stay mounted so switching tabs is instant; the
            others are hidden (performance rule 2 — a hidden editor sits idle).
            An asleep one is not mounted at all: that is what saves the memory.
            WHY not gated on the status load (C2, fix round 1): only Home needs the lists; a
            status re-fetch that fails or reloads must never unmount an editor with unsaved work. */}
        {docs.filter((d) => !d.asleep).map((d) => (
          <EditorFrame
            key={d.file.path}
            ref={(h) => { if (h) frames.current.set(d.file.path, h); else frames.current.delete(d.file.path); }}
            file={d.file}
            hidden={d.closing || d.file.path !== active}
            // Kept but not shown (PageHost): no photo mark — the screen is not on view.
            screen={visible ? `office/${d.file.kind}` : undefined}
            closing={d.closing}
            onClosed={() => finishClose(d.file.path)}
            onCloseFailed={() => {
              // The tab comes back with its reason and actions (the frame marked it failed). If
              // the page is not on view, say so outside it (fix round 2) — never a silent bounce.
              cancelClose(d.file.path);
              if (!visible) noteCloseFailedWhileHidden(d.file.path);
            }}
            onSwitchTo={(copyPath, folder) => {
              replaceDoc(d.file.path, officeFileFor(copyPath));
              markCopied(copyPath, folder);
            }}
          />
        ))}
      </div>

      {/* Only while on view: a mounted dialog would otherwise show over chat and hold Escape. */}
      <VersionsDialog file={visible ? versionsFor : null} onClose={() => showVersions(null)} />
    </div>
  );
}

function saveLabel(s: OfficeSaveState): string {
  if (s.phase !== 'saved') return 'Saving…';
  // After "Save a copy…", say where it went — the folder's name only, never a full path.
  return s.copiedTo ? `Saved a copy to ${s.copiedTo} — now editing the copy.` : 'Saved';
}

function OfficeHome({ load, onRetry, onCreate, onPick, onOpen }: {
  load: StatusLoad; onRetry: () => void; onCreate: (k: OfficeKind) => void; onPick: () => void; onOpen: (f: OfficeFile) => void;
}) {
  if (load.state === 'loading') return <LoadingState what="Office" />;
  if (load.state === 'failed') return <div className="p-6 max-w-xl mx-auto"><ErrorState message="Office could not be started." onRetry={onRetry} /></div>;
  // Specific and certain, and no Retry: nothing the person can do here changes it.
  if (load.state === 'unavailable') return <div className="p-6 max-w-xl mx-auto"><EmptyState message="Office isn't included in this build." /></div>;
  const { recent, project } = load.status;
  const projectFiles = (project?.files ?? []).filter((f) => !recent.some((r) => r.path === f.path));
  return (
    <div className="absolute inset-0 overflow-y-auto">
      {/* Photo-only: a first run (nothing recent) is its own screen, named without '#' so a deck can link its picture. */}
      <ScreenMark name={recent.length === 0 ? 'office/first-run' : 'office/home'} />
      <div className="w-full max-w-4xl mx-auto px-4 py-6 flex flex-col gap-7">
        <section className="flex flex-col gap-3">
          <Eyebrow>New</Eyebrow>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            {(['document', 'spreadsheet', 'presentation'] as const).map((k) => (
              <NewCard key={k} kind={k} onClick={() => onCreate(k)} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Eyebrow>Recent</Eyebrow>
            <div className="flex-1" />
            <Button variant="secondary" size="sm" onClick={onPick}>Open a file…</Button>
          </div>
          {recent.length === 0
            ? <EmptyState message="Files you open in Office will show up here." />
            : <FileList files={recent} verb="Opened" onOpen={onOpen} />}
        </section>

        {/* A file already under Recent is not repeated here (UX review 1, U3). */}
        {projectFiles.length > 0 && project && (
          <section className="flex flex-col gap-2">
            <Eyebrow>In {project.name}</Eyebrow>
            <FileList files={projectFiles} verb="Changed" onOpen={onOpen} />
          </section>
        )}
      </div>
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase px-1">{children}</div>;
}

const NEW_HINT: Record<OfficeKind, string> = {
  document: 'A blank Word file',
  spreadsheet: 'A blank Excel file',
  presentation: 'A blank PowerPoint file',
};

function NewCard({ kind, onClick }: { kind: OfficeKind; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="bg-panel border border-edge rounded-lg p-4 flex items-center gap-3 cursor-pointer card-interactive focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none"
    >
      <span className="shrink-0 w-9 h-9 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-2">
        <OfficeKindGlyph kind={kind} className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{KIND_LABEL[kind]}</div>
        <div className="text-xs text-fg-muted">{NEW_HINT[kind]}</div>
      </div>
    </div>
  );
}

/** Files rows (guide G-17: icon · name · meta). Short lists — Recent keeps 12,
 *  the project list shows its first 12 — so no chunked reveal is needed here. */
function FileList({ files, verb, onOpen }: { files: readonly OfficeFile[]; verb: string; onOpen: (f: OfficeFile) => void }) {
  return (
    <div className="flex flex-col">
      {files.slice(0, 12).map((f) => (
        <div
          key={f.path}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(f)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(f); } }}
          className="flex items-center gap-3 h-11 px-2 rounded-md cursor-pointer text-left hover:bg-inset active:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none"
        >
          <OfficeKindGlyph kind={f.kind} className="w-4 h-4 shrink-0 text-fg-2" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-fg truncate">{f.name}</div>
            <div className="text-2xs text-fg-muted truncate">{f.folder}</div>
          </div>
          {/* Says WHICH time it is: Recent shows when you opened it, the project list when it changed (U3). */}
          <span className="shrink-0 text-2xs text-fg-muted">{verb} {relative(f.at)}</span>
        </div>
      ))}
    </div>
  );
}

const REASON: Record<OfficeVersion['reason'], string> = {
  opened: 'When you opened it',
  autosave: 'Saved while you worked',
  'before-restore': 'Kept before a restore',
};

const RESTORE_FAILED = "Office couldn't restore this version.";

function VersionsDialog({ file, onClose }: { file: OfficeFile | null; onClose: () => void }) {
  const [versions, setVersions] = useState<OfficeVersion[] | null>(null);
  // The list could not be read (Retry asks again) — never shown as "no versions", which would
  // tell the person their kept copies are gone.
  const [listFailed, setListFailed] = useState(false);
  // The version being restored (its button waits), and a restore's failure with what to retry.
  const [restoring, setRestoring] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ message: string; version: OfficeVersion } | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    setVersions(null);
    setListFailed(false);
    setFailed(null);
    if (!file) return;
    let current = true;
    officeBridge()?.versions(file.path).then(
      (list) => { if (current) setVersions(list); },
      () => { if (current) setListFailed(true); },
    );
    return () => { current = false; };
  }, [file, asked]);
  // WHY save first (Task 7, no lost edits): the editor may hold typing autosave has not written
  // yet. Saved now, it is in the file main keeps as "Kept before a restore" — so restoring never
  // drops it. If it cannot be saved, nothing is restored: the person keeps their edits and sees why.
  const restore = async (v: OfficeVersion) => {
    if (!file || restoring) return;
    setRestoring(v.id);
    setFailed(null);
    try {
      const saved = await flushOffice(file.path);
      if (!saved.ok) { setFailed({ message: "Your latest changes couldn't be saved, so nothing was restored.", version: v }); return; }
      const r = await (officeBridge()?.restore(file.path, v.id) ?? Promise.resolve({ ok: false as const, message: RESTORE_FAILED }))
        .catch(() => ({ ok: false as const, message: RESTORE_FAILED }));
      if (r.ok) { onClose(); return; }
      setFailed({ message: r.message, version: v });
    } finally {
      setRestoring(null);
    }
  };
  return (
    <Dialog open={file !== null} onClose={onClose} title="Versions" subtitle={file?.name} size="panel" screen="office/versions">
      <p className="text-xs text-fg-muted pb-3">
        Office saves as you work and keeps a copy every few minutes. Restoring one keeps your current version too.
      </p>
      {failed && <ErrorState className="mb-3" message={failed.message} onRetry={() => void restore(failed.version)} />}
      {listFailed && <ErrorState message="Office couldn't load the versions of this file." onRetry={() => setAsked((n) => n + 1)} />}
      {versions === null && !listFailed && <LoadingState what="versions" />}
      {versions && versions.length === 0 && <EmptyState message="No earlier versions yet." />}
      {versions && versions.length > 0 && (
        <div className="flex flex-col">
          <div className="flex items-center gap-3 h-11 px-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg">Now</div>
              <div className="text-2xs text-fg-muted">The version you are editing</div>
            </div>
          </div>
          {versions.map((v) => (
            <div key={v.id} className="flex items-center gap-3 h-11 px-2 rounded-md hover:bg-inset">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-fg">{when(v.at)}</div>
                <div className="text-2xs text-fg-muted">{REASON[v.reason]}</div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void restore(v)} disabled={restoring !== null}>
                {restoring === v.id ? 'Restoring…' : 'Restore'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}


function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "Today, 2:14 PM" / "Yesterday, 9:03 AM" / "12 Sep, 4:40 PM". */
function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}
