// desktop/src/renderer/components/FolderSwitcher.tsx
// The session picker's folder dropdown. Per the 2026-07-09 project-sync UX
// spec this component ONLY picks: adding/importing/syncing projects moved to
// Project View, reached via the single "Manage projects…" footer entry.
// Rows are pick-only — rename and remove also live in Project View (Destin's
// 2026-07-09 follow-up: no per-row hover actions here).
// Each row carries a sync dot (green syncing / red problem / gray not in
// sync) whose tooltip holds the full plain-language phrase.
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { syncDotFor, findSpaceFor, type SyncStatusData } from './sync-dot-state';
import { fieldClasses, Tooltip } from './ui';
import { POPOVER_Z } from './overlays/Overlay';

interface SavedFolder {
  path: string;
  nickname: string;
  addedAt: number;
  exists: boolean;
  // Kept solely to mirror the FOLDERS_LIST IPC payload shape — rows arrive
  // with this flag, but nothing in this file reads it anymore (the sync dot
  // supersedes the old "synced project" managed badge).
  managed?: boolean;
}

interface Props {
  /** Currently selected folder path */
  value: string;
  /** Called when user selects a folder */
  onChange: (path: string) => void;
  /** Auto-select the first saved folder when value is empty (default: true) */
  autoSelect?: boolean;
  /** Opens Project View ("Manage projects…"). Omitted where Project View
   *  doesn't exist (the buddy window) — the footer row hides itself. */
  onManageProjects?: () => void;
  /** Assistant settings only (review round 4, R4-2): the open list is exactly
   *  as wide as the closed control and left-aligned to it, and each row puts
   *  the name and the path on ONE line. Everywhere else the panel keeps its
   *  fixed 320px, centred and overhanging its host — the shape Destin chose
   *  for the new-session menu on 2026-07-17, which this must not disturb. */
  panelMatchesTrigger?: boolean;
}

// Dot colors: status colors are theme-independent by design-system rule.
// Red matches the app's existing #DD4444; green mirrors the SessionDot green.
const DOT_CLASS: Record<'green' | 'red' | 'gray', string> = {
  green: 'bg-[#44A05C]',
  red: 'bg-[#DD4444]',
  gray: 'bg-fg-faint',
};

export default function FolderSwitcher({ value, onChange, autoSelect = true, onManageProjects, panelMatchesTrigger = false }: Props) {
  const [folders, setFolders] = useState<SavedFolder[]>([]);
  const [open, setOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatusData | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The dropdown panel is PORTALED to document.body (see render below), so it
  // needs its own ref for the outside-click check — it is no longer a DOM
  // child of wrapperRef.
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useScrollFade<HTMLDivElement>();
  // Fixed-position coordinates for the portaled dropdown, computed from the
  // trigger button's screen rect whenever the dropdown opens (and on resize).
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; maxHeight: number; width: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await (window as any).claude.folders.list();
      setFolders(list);
      // Auto-select the first folder (home) when no value is set
      if (autoSelect && !value && list.length > 0) {
        onChange(list[0].path);
      }
    } catch {}
  }, [value, onChange, autoSelect]);

  useEffect(() => { load(); }, [load]);

  // Fetch sync state when the dropdown opens. catch → null: on Android the
  // shim has no syncspaces handlers (30s reject) — rows simply render no dot.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (window as any).claude.syncSpaces.status()
      .then((s: SyncStatusData) => { if (!cancelled) setSyncStatus(s); })
      .catch(() => { if (!cancelled) setSyncStatus(null); });
    return () => { cancelled = true; };
  }, [open]);

  // Live-refresh the folder list when cross-device discovery materializes (or
  // stops) a project while this picker is open (2026-07-13 dogfood fix). Without
  // this a project synced from another device wouldn't appear until the dropdown
  // was closed and reopened. Gated on `open` so a closed picker (which refetches
  // on its next open anyway) doesn't subscribe. On Android onEvent exists
  // (remote-shim defines it) but never fires (no syncspaces handlers) — inert
  // there; the optional-chain is just belt-and-suspenders.
  useEffect(() => {
    if (!open) return;
    const unsubscribe = (window as any).claude.syncSpaces.onEvent?.((e: any) => {
      if (e?.type === 'projects-changed') void load();
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [open, load]);

  // Position the portaled dropdown under the trigger, clamped to the viewport.
  // WHY a portal + fixed positioning at all: this picker lives inside the
  // SessionStrip's new-session menu, whose rounded-corner containers use
  // overflow-hidden — an absolutely-positioned child gets CLIPPED at the menu
  // edges (cut-off icons, truncated list). Portaling to document.body lets the
  // dropdown float above the host menu instead of being squeezed inside it.
  // Must match the `w-80` Tailwind class on the panel div (320px = 20rem) —
  // if one changes, change the other, or the clamping math here silently
  // drifts from the panel's real rendered width. Deliberately wider than the
  // host SessionStrip dropdown's own w-72 (288px) so the panel visibly
  // overhangs it on both sides instead of sitting flush (Destin, 2026-07-17).
  const PANEL_WIDTH = 320;
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    // R4-2: match-the-trigger mode measures the control instead of using the
    // fixed width, and hangs the panel off its left edge rather than centring.
    const width = panelMatchesTrigger ? rect.width : PANEL_WIDTH;
    const left = panelMatchesTrigger
      ? Math.min(Math.max(rect.left, margin), Math.max(window.innerWidth - width - margin, margin))
      : Math.min(
          Math.max(rect.left + rect.width / 2 - width / 2, margin),
          window.innerWidth - width - margin,
        );
    const top = rect.bottom + 4;
    // Never extend past the viewport bottom — the panel scrolls instead.
    const maxHeight = Math.max(window.innerHeight - top - margin, 120);
    setPanelPos({ top, left, maxHeight, width });
  }, [panelMatchesTrigger]);

  useLayoutEffect(() => {
    if (!open) { setPanelPos(null); return; }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  // Close panel on outside click/tap. The panel is portaled, so "inside" means
  // inside the trigger wrapper OR inside the floating panel itself.
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  // Close panel on Escape — routed through the central useEscClose LIFO stack
  // so chat-passthrough preventDefault works consistently with other overlays.
  const handleEscClose = useCallback(() => {
    setOpen(false);
  }, []);
  useEscClose(open, handleEscClose);

  const handleSelect = useCallback((path: string) => {
    onChange(path);
    setOpen(false);
  }, [onChange]);

  // Find nickname for current value
  const currentFolder = folders.find(f => f.path === value);
  const displayLabel = currentFolder
    ? currentFolder.nickname
    : value
      ? value.replace(/\\/g, '/').split('/').pop() || value
      : 'Select folder...';

  return (
    <div ref={wrapperRef} className="relative">
      {/* Trigger button — shows current selection.
          Restyled onto the shared compact field (ui/field sm) so it
          matches the Provider/Model Selects beside it in the new-session form —
          was a hand-rolled surface (text-xs / border-edge / rounded-md) that
          predated the ui/ system and drifted a hair taller than the Selects.
          layout/justify/truncate classes are passed through fieldClasses and
          win over the base via mergeClasses, same as Select's trigger. */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={fieldClasses('sm', 'w-full text-left truncate flex items-center gap-1.5 justify-between')}
      >
        <svg className="w-3 h-3 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="flex-1 truncate">{displayLabel}</span>
        <svg className={`w-3 h-3 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* The full-path hint that used to sit here was removed 2026-07-30
          (Destin): the trigger already names the folder, and the second line
          pushed every field below it down while repeating information the
          picker's own rows carry. The path still reaches assistive tech and
          hover via each row's title attribute inside the dropdown. */}

      {/* Dropdown panel — uses .layer-surface for theme-driven background,
          border, shadow, and glassmorphism (blur/opacity from --panels-* vars).
          PORTALED to document.body with fixed positioning so the host menu's
          overflow-hidden can't clip it (see the WHY on `measure` above).
          POPOVER_Z: the SessionStrip menu that hosts this picker is the
          documented z-[9000] exception (PITFALLS → Overlays) — a popover
          spawned FROM that menu must render above its own host. */}
      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          // Marker for HOST menus' outside-click handlers (SessionStrip): the
          // portal lives on document.body, so a host's contains() check can't
          // see it — without this attribute the host closes (and unmounts us)
          // on the mousedown, and our click never fires.
          data-folder-switcher-portal=""
          className="layer-surface fixed overflow-hidden flex flex-col"
          style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width, maxHeight: panelPos.maxHeight, zIndex: POPOVER_Z, animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both' }}
        >
          {/* Saved folders list — min-h-0 lets flexbox shrink the list first
              when the viewport-clamped panel height is tight. */}
          {folders.length > 0 && (
            <div ref={listRef} className="scroll-fade max-h-48 min-h-0">
              <div className="py-1">
              {folders.map((f) => {
                const isSelected = f.path === value;
                const dot = syncDotFor(f.path, syncStatus);
                // Prefer the synced display name (cross-device registry overlay,
                // 2026-07-12) over the local nickname for a synced project.
                const shown = ((findSpaceFor(f.path, syncStatus) as any)?.displayName as string | undefined) || f.nickname;

                return (
                  <div
                    key={f.path}
                    onClick={() => handleSelect(f.path)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-accent/10 text-fg'
                        : f.exists
                          ? 'text-fg-2 hover:bg-inset hover:text-fg'
                          : 'text-fg-muted hover:bg-inset'
                    }`}
                  >
                    {/* Folder icon */}
                    <svg className={`w-3 h-3 shrink-0 ${f.exists ? 'text-fg-muted' : 'text-[#DD4444]/60'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>

                    {/* Nickname + path. Rename/remove hover actions were
                        deliberately removed (2026-07-09) — both live in
                        Project View via "Manage projects…". Don't re-add. */}
                    {panelMatchesTrigger ? (
                      // R4-2: name and path on one line, the path taking
                      // whatever room is left after the name.
                      <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                        <span className="text-xs shrink-0">{shown}</span>
                        <span className="text-3xs text-fg-muted truncate" title={f.path}>{f.path}</span>
                      </div>
                    ) : (
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate">{shown}</div>
                        <div className="text-3xs text-fg-muted truncate" title={f.path}>
                          {f.path}
                        </div>
                      </div>
                    )}

                    {/* Stale warning */}
                    {!f.exists && (
                      <span className="text-4xs text-[#DD4444]/80 shrink-0" title="Directory not found">
                        missing
                      </span>
                    )}

                    {/* Selected check */}
                    {isSelected && (
                      <svg className="w-3 h-3 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}

                    {/* Sync dot — green syncing / red problem / gray not in
                        sync; the tooltip carries the full phrase. Renders only
                        when syncSpaces.status() resolved (desktop). */}
                    {dot && (
                      <Tooltip text={dot.label}>
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[dot.color]}`}
                        aria-label={dot.label}
                      />
                      </Tooltip>
                    )}
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* Footer: the ONLY action — everything about adding/importing/
              syncing projects lives in Project View (spec decision 3). */}
          {onManageProjects ? (
            <div className="border-t border-edge">
              <button
                onClick={() => { setOpen(false); onManageProjects(); }}
                className="w-full px-2.5 py-2 text-xs text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                Manage projects…
              </button>
            </div>
          ) : (
            // WHY: the main picker deliberately has no add actions (spec
            // decision 3 — Project View owns adding), but windows WITHOUT
            // Project View (the buddy window has no ArtifactProvider) need a
            // minimal escape hatch to add a folder — otherwise there is NO way
            // to add one there (a regression). This row renders ONLY when
            // onManageProjects is absent.
            <div className="border-t border-edge">
              <button
                onClick={async () => {
                  try {
                    const folder = await (window as any).claude.dialog.openFolder();
                    if (folder) {
                      await (window as any).claude.folders.add(folder);
                      await load();
                      onChange(folder);
                      setOpen(false);
                    }
                  } catch {
                    // Swallow: user cancel resolves to null (handled above);
                    // anything thrown here (e.g. dialog unavailable) is a no-op.
                  }
                }}
                className="w-full px-2.5 py-2 text-xs text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                Browse for folder…
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
