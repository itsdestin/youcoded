// ProjectSwitcher — the "Switch project" popup, opened from the Project View hero's name.
//
// Redesign (redesign backlog row 10, deck project-switcher-1). Destin: "want to replace esc
// with our X. to max this a bit more consistent with other popups. also the checkmarks and such
// are odd here, and there's no way to delete some projects currently" — then "want to change
// how the file/chat numbers are displayed. and how sync appears. should probably be a status
// like the working/inactive/etc chips in session swithcer. and a remove icon somewhere."
//
// What the guide gave each piece (guide-draft.md):
//  - Shell: the shared `Dialog` — one-line title, ✕, tapered line, Esc ("Popups and side
//    panels": "Quick pickers (the project switcher) follow the same shell: a title and the ✕").
//  - Search: a field with its icon inside (InputGroup), focused on open — keyboard-first stays.
//  - List: a small label, then ONE first-level card ("Spacing": nothing bare on the popup)
//    holding plain rows ("Lists and menus": pick-one switchers are plain rows; hover
//    highlights; the selected row never looks like a hovered one).
//  - Row: the session switcher's two-line row (SessionStrip.tsx) — name with its status pill
//    on line 1, quiet facts on line 2. Sync is a named pill with its dot (guide "Status and
//    notices": a live status carries its coloured dot inside the pill), not a bare dot.
//  - Counts: "21 files · 5 chats" as bold number + grey word (guide "Text and numbers").
//  - Remove: a bin at the row's end, for EVERY project — synced ones included (they had no way
//    out). It opens a confirm in the parent; it never deletes the folder or its files.
//  - Add a project: a full-width outlined button under the list (guide "Buttons": a follow-up
//    action under a group).
// Open choices (counts, current-project mark, where Remove shows) are workbench switches in
// ./switcher-variants.ts until Destin picks.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import { syncPillFor, findSpaceFor, type SyncStatusData } from '../sync-dot-state';
import { SearchIcon, PlusIcon, TrashIcon } from './icons';
import { Button, CARD_LEVEL_1, Chip, Dialog, InputGroup, Pill, SectionLabel } from '../ui';
import { useScrollFade } from '../../hooks/useScrollFade';
import { switcherCounts, switcherCurrent, switcherRemove } from './switcher-variants';

interface ProjectSwitcherProps {
  projects: CentralIndexProject[];
  activeId: string | null;
  onSelect: (project: CentralIndexProject) => void;
  onClose: () => void;
  onAddProject: () => void;
  // Opens the parent's "Remove project" confirm. Removing takes the project off this
  // computer's list only — the folder, its files and its sync are left alone.
  onDeleteProject?: (project: CentralIndexProject) => void;
  // Per-project sync state (spec §4) — drives the rows' sync pills. null → syncSpaces
  // unavailable (Android, an older remote host): no sync pills at all.
  syncStatus?: SyncStatusData | null;
}

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
  const listRef = useRef<HTMLDivElement>(null);
  // The see-through edge fade (.scroll-mask — the rows themselves fade, no painted band;
  // Appearance's themes box and the sessions menu, backlog row 5).
  useScrollFade<HTMLDivElement>(listRef);
  const [listMinHeight, setListMinHeight] = useState<number | undefined>(undefined);
  const counts = switcherCounts();
  const currentLook = switcherCurrent();
  const removeLook = switcherRemove();

  // Focus the search field on open. WHY: autoFocus inside an overlay can race the
  // mount/scrim; the ref pattern is reliable.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // WHY freeze the list's opening height: the shared Dialog centres itself, so a list that
  // shrank as you typed would make the whole popup jump up and down under your eyes. The
  // filtered list can only be shorter than the full one, so its first height is the most it
  // will ever need. (The old palette avoided this by hanging from 15% down the window.)
  useLayoutEffect(() => {
    if (listRef.current && listMinHeight === undefined) setListMinHeight(listRef.current.offsetHeight);
  }, [listMinHeight]);

  // Case-insensitive substring match against name OR path. Empty query → all projects in their
  // given order.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [query, projects]);

  // `top`: the project you are in sits alone in its own card above the others. Keyboard order
  // follows what you see, so the list it walks is reordered the same way.
  const splitCurrent = currentLook === 'top' && !query.trim();
  const current = splitCurrent ? filtered.find((p) => p.id === activeId) ?? null : null;
  const others = current ? filtered.filter((p) => p !== current) : filtered;
  const ordered = current ? [current, ...others] : others;

  // Reset the keyboard highlight to the top whenever the query changes, so it never points
  // past the end.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // Escape is the Dialog's (it closes on Esc, the ✕ and a click outside). This handler owns
  // only the list keys.
  // Arrow keys move the highlight; keep it in view now that only the list scrolls. Only
  // after a key — a hover must never scroll the list under the pointer.
  const keyMoved = useRef(false);
  useEffect(() => {
    if (!keyMoved.current) return;
    keyMoved.current = false;
    listRef.current?.querySelectorAll('[data-project-row]')[current ? highlightIndex - 1 : highlightIndex]
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightIndex, current]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') keyMoved.current = true;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (ordered.length === 0) return;
      setHighlightIndex((i) => Math.min(i + 1, ordered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (ordered.length === 0) return;
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = ordered[highlightIndex];
      if (sel) onSelect(sel);
    }
  };

  const renderRow = (p: CentralIndexProject, i: number) => {
    const isActive = p.id === activeId;
    const isHighlighted = i === highlightIndex;
    // Prefer the synced display name (cross-device registry overlay, 2026-07-12) over the
    // folder name for a synced project.
    const space = findSpaceFor(p.path, syncStatus ?? null) as (ReturnType<typeof findSpaceFor> & { displayName?: string }) | null;
    const shown = space?.displayName || p.name;
    // Same synced-wins precedence as the name: registry overlay for a synced project,
    // saved-folders record for a plain folder.
    const desc = space?.description || p.description || null;
    const avatar = shown.charAt(0).toUpperCase() || '?';
    // A missing folder outranks its sync state: nothing can sync a folder that is not there,
    // and it is the one fact that explains why opening it shows nothing.
    const sync = p.missing ? null : syncPillFor(p.path, syncStatus ?? null);
    const files = p.fileCount ?? p.stats.artifactCount;
    const filesLabel = p.fileCountTruncated ? `${files.toLocaleString()}+` : files.toLocaleString();
    const chats = p.conversationCount;
    // WHY the row fill for the highlight and the tint for `fill`: guide "Lists and menus" —
    // hover/keyboard highlights; the project you are IN must never look like a hovered row.
    const markFill = currentLook === 'fill' && isActive;
    const rowTone = markFill
      ? 'bg-accent/10'
      : isHighlighted ? 'bg-inset' : 'hover:bg-inset';
    return (
      <div key={p.id} className={`group relative flex items-center rounded-md transition-colors ${rowTone}`}>
        <button
          type="button"
          // aria-current, not listbox/option roles: `shoot --check` (rightly) treats a
          // listbox as a popup layer of its own, and this list is part of the dialog.
          aria-current={isActive ? 'true' : undefined}
          data-project-row=""
          className="flex-1 min-w-0 flex items-center gap-2.5 pl-2 pr-1 py-2 text-left"
          onMouseEnter={() => setHighlightIndex(i)}
          onClick={() => onSelect(p)}
        >
          {/* Avatar: first letter of the name in a rounded square (unchanged). */}
          <span aria-hidden className="shrink-0 w-7 h-7 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-xs font-semibold text-fg-2">
            {avatar}
          </span>
          <span className="min-w-0 flex-1 flex flex-col gap-0.5">
            {/* Line 1: the name, then its status pills (the session switcher's order). */}
            <span className="flex items-center gap-2 min-w-0">
              <span className="min-w-0 flex-1 flex items-center gap-1.5">
                <span className="text-sm font-medium text-fg truncate">{shown}</span>
                {/* WHY a pill, not the old check (backlog row 10: "the checkmarks … are odd
                    here"): a check reads as "ticked", a setting you can untick. "Current" says
                    what it means. Not a live status, so no dot; the accent tint marks it as
                    yours rather than a warning. */}
                {currentLook === 'pill' && isActive && <Pill tone="info">Current</Pill>}
              </span>
              {p.missing && (
                <span title="This folder isn't where it was — it was moved or deleted outside YouCoded.">
                  <Pill tone="warning" dot>Folder missing</Pill>
                </span>
              )}
              {sync && (
                <span title={sync.detail}>
                  <Pill tone={sync.tone} dot>{sync.short}</Pill>
                </span>
              )}
            </span>
            {/* Line 2: where it is, then its counts at the right — the session switcher's
                second line (folder left, runtime right). */}
            <span className="flex items-center gap-2 min-w-0 text-3xs text-fg-muted">
              <span className="flex-1 min-w-0 truncate" title={p.path}>{p.path}</span>
              {counts === 'summary' && !p.missing && (
                // Guide "Text and numbers": in a summary line, a bold number then a grey word.
                // Hidden at phone width: the path is what tells two same-named folders apart.
                <span data-counts="" className="hidden sm:inline shrink-0 whitespace-nowrap">
                  <b className="font-semibold text-fg-2">{filesLabel}</b> file{files === 1 ? '' : 's'}
                  {typeof chats === 'number' && (
                    <> · <b className="font-semibold text-fg-2">{chats}</b> chat{chats === 1 ? '' : 's'}</>
                  )}
                </span>
              )}
              {counts === 'chips' && !p.missing && (
                // Guide "Cards": short facts as the one fact chip, in one row.
                <span className="hidden sm:flex shrink-0 items-center gap-1">
                  <Chip>{filesLabel} file{files === 1 ? '' : 's'}</Chip>
                  {typeof chats === 'number' && <Chip>{chats} chat{chats === 1 ? '' : 's'}</Chip>}
                </span>
              )}
            </span>
            {/* The description stays a third line, one line, italic in quotes (the hero's
                recipe) — rows without one keep their two-line height. */}
            {desc && (
              <span className="block text-3xs italic text-fg-dim truncate" title={desc}>
                “{desc}”
              </span>
            )}
          </span>
        </button>
        {onDeleteProject && (
          // WHY visible on every row (backlog row 10: "a remove icon somewhere"; "there's no
          // way to delete some projects"): the old ✕ appeared only on hover and never on a
          // synced row. A bin, not a ✕ — the ✕ closes popups everywhere. `hover` variant:
          // shown under the pointer or keyboard, and always on touch (touch-reveal).
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${shown} from your project list`}
            title="Remove from your project list"
            className={`shrink-0 mr-1 hover:text-destructive-fg ${
              removeLook === 'hover'
                ? `${isHighlighted ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 focus:opacity-100 touch-reveal transition-opacity`
                : ''
            }`}
            onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
          >
            <TrashIcon size={14} />
          </Button>
        )}
      </div>
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Switch project"
      size="document"
      screen="projects/switcher"
      // WHY its own body (not the Dialog's scrolling one): with many projects the whole body
      // scrolled, taking the search box and Add a project off screen. Only the list scrolls
      // now, under the app's see-through fade; search stays on top and Add at the bottom.
      scrollBody={false}
    >
      <div className="flex-1 min-h-0 flex flex-col gap-4 p-4">
        {/* Search: the field with its icon inside. Keydown lives on the input so ↑/↓/Enter
            work while it's focused (it focuses on open). */}
        <InputGroup size="md" className="shrink-0">
          <span aria-hidden className="pl-2.5 text-fg-muted flex items-center">
            <SearchIcon size={15} />
          </span>
          <InputGroup.Field
            ref={inputRef}
            placeholder="Search projects"
            aria-label="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </InputGroup>

        {current && (
          <div className="shrink-0">
            <SectionLabel className="mb-2">Current project</SectionLabel>
            <div aria-label="Current project" className={`${CARD_LEVEL_1} p-1`}>
              {renderRow(current, 0)}
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 flex flex-col">
          <SectionLabel className="mb-2 shrink-0">{current ? 'Other projects' : 'Your projects'}</SectionLabel>
          <div className={`${CARD_LEVEL_1} flex-1 min-h-0 flex flex-col overflow-hidden`}>
            <div
              ref={listRef}
              aria-label="Projects"
              style={listMinHeight ? { minHeight: listMinHeight } : undefined}
              className="scroll-mask flex-1 min-h-0 p-1 flex flex-col gap-0.5"
            >
              {ordered.length === 0 && (
                <div className="px-3 py-3 text-xs text-fg-muted">
                  No projects match “{query.trim()}”.
                </div>
              )}
              {others.length === 0 && current && (
                <div className="px-3 py-3 text-xs text-fg-muted">No other projects yet.</div>
              )}
              {others.map((p, j) => renderRow(p, current ? j + 1 : j))}
            </div>
          </div>
        </div>

        {/* The parent owns the flow: it closes this popup, opens the folder picker, saves the
            folder and selects the new project. */}
        <Button variant="secondary" size="md" className="w-full shrink-0" onClick={onAddProject}>
          <PlusIcon size={14} />
          Add a project
        </Button>
      </div>
    </Dialog>
  );
}
