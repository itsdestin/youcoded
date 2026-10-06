// ProjectSwitcher — command-palette project jumper, opened from the ProjectHero name button.
// A popup hanging from 15% down the window (L2): a search row with the ✕, a "Recent" list of
// projects, and an "Add a project" footer.
//
// Redesign backlog row 10 (decks project-switcher-1/-2). Round 1 rebuilt this on the shared
// Dialog; Destin kept the OLD container and row style ("i honestly liked the old styling of the
// broader container (search, add project, row style) more", PS-1) and took these pieces onto it:
//  - sync as a named status pill with its dot, like the session switcher's Working / Inactive
//    (PS-2 yes) — "Only on this computer" shortened to "Not synced" (PQ-2);
//  - counts as "21 files · 5 chats" with bold numbers (PC-1 "summary"; guide "Text and
//    numbers": a summary line is a bold number then a grey word);
//  - a remove bin that shows only on the pointed / keyboard row, always on touch, and takes NO
//    space when hidden so the pills and counts sit flush right (PC-3 "hover" + note);
//  - "Folder missing" for a project whose folder is gone (PS-3 states);
//  - the project you are in: round 1's pill / tint / own box were all declined (PC-2), so
//    round 2 offers check / edge / subtext (workbench switch `?switcherCurrent=`).
// WHY: the search row borrows the popups' tapered divider (.dialog-header).
import '../ui/Dialog.css';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import { syncPillFor, findSpaceFor, type SyncStatusData } from '../sync-dot-state';
import { workbenchSwitcherCurrent } from '../../workbench-mode';

interface ProjectSwitcherProps {
  projects: CentralIndexProject[];
  activeId: string | null;
  onSelect: (project: CentralIndexProject) => void;
  onClose: () => void;
  onAddProject: () => void;
  // Opens the parent's "Remove project" confirm. Removing never deletes the folder or its
  // files; for a synced project it stops syncing and takes it off every device's lists.
  onDeleteProject?: (project: CentralIndexProject) => void;
  // Per-project sync state (spec §4) — drives the rows' sync pills. null → syncSpaces
  // unavailable (Android, an older remote host): no sync pills at all.
  syncStatus?: SyncStatusData | null;
}

// Shared glyphs — see ./icons.tsx.
import { SearchIcon, CheckIcon, PlusIcon, TrashIcon } from './icons';
import { Button, CloseButton, Pill, SectionLabel } from '../ui';
import { ScreenMark } from '../../shoot-mode';

export function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
  onClose,
  onAddProject,
  onDeleteProject,
  syncStatus,
}: ProjectSwitcherProps) {
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentLook = workbenchSwitcherCurrent();

  // ESC closes via the shared LIFO stack too — the input's own onKeyDown only fires while the
  // field is FOCUSED, and clicking a row blurs it. The palette is only mounted while open.
  useEscClose(true, onClose);

  // Focus the search field on open. WHY: autoFocus inside an overlay can race the
  // mount/scrim; the ref pattern is reliable.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Case-insensitive substring match against name OR path. Empty query → all projects in
  // their given order.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [query, projects]);

  // Reset the keyboard highlight to the top whenever the filtered set changes.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // No Escape branch here — useEscClose above owns it. This handler owns the list keys.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = filtered[highlightIndex];
      if (sel) onSelect(sel);
    }
  };

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-label="Switch project"
        className="fixed left-1/2 top-[15%] -translate-x-1/2 w-[min(640px,92vw)] flex flex-col"
      >
        <ScreenMark name="projects/switcher" />
        {/* Search row. WHY dialog-header, not border-b (quick-fix batch, 2026-09-29;
            ui-labels-batch#LB-11): the popups' approved short, tapered divider. */}
        <div className="dialog-header p-2.5 flex items-center gap-2">
          <span className="text-fg-muted pl-1">
            <SearchIcon size={17} />
          </span>
          <input
            ref={inputRef}
            type="text"
            placeholder="Jump to project…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none text-base text-fg placeholder:text-fg-muted"
          />
          {/* WHY the drawn ✕, not an "esc" key chip (decisions Q-2; LB-11). Esc still closes. */}
          <CloseButton label="Close project switcher" onClick={onClose} />
        </div>

        {/* WHY SectionLabel, not the old spaced-caps eyebrow (labels batch, decisions H-3). */}
        <div className="px-2 pt-2">
          <div className="px-2">
            <SectionLabel>Recent</SectionLabel>
          </div>
        </div>

        <div className="p-2 max-h-[50vh] overflow-y-auto flex flex-col gap-0.5">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-sm-tight text-fg-muted">
              No projects match “{query.trim()}”.
            </div>
          )}
          {filtered.map((p, i) => {
            const isActive = p.id === activeId;
            const isHighlighted = i === highlightIndex;
            // Prefer the synced display name (cross-device registry overlay, 2026-07-12).
            const space = findSpaceFor(p.path, syncStatus ?? null) as (ReturnType<typeof findSpaceFor> & { displayName?: string }) | null;
            const shown = space?.displayName || p.name;
            const desc = space?.description || p.description || null;
            const avatar = shown.charAt(0).toUpperCase() || '?';
            // A missing folder outranks its sync state: nothing can sync a folder that isn't
            // there, and it is what explains why opening it shows nothing.
            const sync = p.missing ? null : syncPillFor(p.path, syncStatus ?? null);
            const files = p.fileCount ?? p.stats.artifactCount;
            const filesLabel = p.fileCountTruncated ? `${files.toLocaleString()}+` : files.toLocaleString();
            const chats = p.conversationCount;
            return (
              // The old row look, kept (PS-1): keyboard highlight is an accent outline. It sits
              // on this wrapper so the bin is INSIDE the row's box when it shows.
              // WHY no fill for the project you are in any more: the old fill + check was what
              // read as "odd" (backlog row 10); its marking is now `currentLook`.
              // WHY `relative`: the `edge` look draws its bar inside the row.
              <div
                key={p.id}
                className={`group relative flex items-center rounded-md transition-colors border ${
                  isHighlighted ? 'border-accent bg-inset' : 'border-transparent hover:bg-inset'
                }`}
                onMouseEnter={() => setHighlightIndex(i)}
              >
                <button
                  type="button"
                  aria-current={isActive ? 'true' : undefined}
                  data-project-row=""
                  className="flex-1 min-w-0 flex items-center gap-2.5 px-2 py-2 text-left"
                  onClick={() => onSelect(p)}
                >
                  {currentLook === 'edge' && isActive && (
                    // An accent bar at the row's left edge — the marking a sidebar uses for
                    // "you are here", without tinting the row like a hover.
                    <span aria-hidden className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-accent" />
                  )}
                  <span aria-hidden className="shrink-0 w-7 h-7 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-xs font-semibold text-fg-2">
                    {avatar}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium text-fg truncate">{shown}</span>
                      {currentLook === 'check' && isActive && (
                        // The old check, restyled: beside the name, in the accent colour, in a
                        // small tinted round — it belongs to the name, not the row's far edge.
                        <span title="Current project" aria-label="Current project" className="shrink-0 w-4 h-4 rounded-full bg-accent/15 text-accent flex items-center justify-center">
                          <CheckIcon size={11} strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span className="block font-mono text-2xs text-fg-muted truncate" title={p.path}>
                      {currentLook === 'subtext' && isActive && (
                        <span className="font-sans font-medium text-accent">Current project · </span>
                      )}
                      {p.path}
                    </span>
                    {/* Description as a third line (unchanged): rows without one keep their
                        height; one line, italic in quotes like the hero. */}
                    {desc && (
                      <span className="block text-2xs italic text-fg-dim truncate" title={desc}>
                        “{desc}”
                      </span>
                    )}
                  </span>
                  {/* The row's right side: counts, then the status pill, on one centre line —
                      marked so `shoot --check` fails if they drift apart (round 2's first pictures
                      had the counts ~3px above the pill's centre). */}
                  <span className="shrink-0 flex items-center gap-2" data-centres-agree="project-row-status">
                    {/* Counts (PC-1 "summary"): bold number, grey word. Hidden below 640px, as
                        before — the name is what identifies the project there. No counts on a
                        missing folder (there is nothing to count). */}
                    {!p.missing && (
                      <span data-counts="" className="hidden sm:inline text-2xs leading-none text-fg-muted shrink-0 whitespace-nowrap">
                        <b className="font-semibold text-fg-2">{filesLabel}</b> file{files === 1 ? '' : 's'}
                        {typeof chats === 'number' && (
                          <> · <b className="font-semibold text-fg-2">{chats}</b> chat{chats === 1 ? '' : 's'}</>
                        )}
                      </span>
                    )}
                    {p.missing && (
                      <span title="This folder isn't where it was — it was moved or deleted outside YouCoded." className="shrink-0 flex">
                        <Pill tone="warning" dot>Folder missing</Pill>
                      </span>
                    )}
                    {/* Sync as a status pill with its dot (PS-2) — where the bare dot was. */}
                    {sync && (
                      <span title={sync.detail} className="shrink-0 flex">
                        <Pill tone={sync.tone} dot>{sync.short}</Pill>
                      </span>
                    )}

                  </span>
                </button>
                {onDeleteProject && (
                  // PC-3 "hover" — "when hidden, the other chips and such should sit flush right":
                  // the bin is display:none (not just transparent) until the row is pointed at
                  // or keyboard-highlighted, so it takes no space; on a touch screen it always
                  // shows (hover never happens there). Every project has one, synced included.
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${shown} from your projects`}
                    title="Remove from your projects"
                    className={`shrink-0 mr-1 hover:text-destructive-fg group-hover:inline-flex focus-visible:inline-flex pointer-coarse:inline-flex ${isHighlighted ? 'inline-flex' : 'hidden'}`}
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
                  >
                    <TrashIcon size={14} />
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer: Add a project (opens the OS folder picker via the parent). WHY the tapered
            line, not border-t (quick-fix batch): same divider as the header above. */}
        <button
          type="button"
          className="relative flex items-center gap-2 px-4 py-3 text-sm-tight text-fg-2 hover:bg-inset hover:text-fg transition-colors rounded-b-[inherit]"
          onClick={onAddProject}
        >
          <span
            aria-hidden
            className="absolute inset-x-4 top-0 h-px"
            style={{ background: 'linear-gradient(to right, transparent, var(--edge-card) 8%, var(--edge-card) 92%, transparent)' }}
          />
          <PlusIcon size={15} />
          Add a project
        </button>
      </OverlayPanel>
    </>
  );
}
