// ProjectSwitcher — command-palette project jumper (Task 2.3).
// Opened from the ProjectHero name button. A centered popup (L2) with a search
// field, a filtered "Recent" list of projects (avatar + name + repo glyph +
// mono path + files·chats hint + active check), and an "Add a project" footer.
//
// Layout/visuals mirror docs/superpowers/prototypes/2026-06-14-project-view-redesign.html
// (switcherPaletteEl). Icon style matches ProjectHero — inline lucide SVG,
// stroke currentColor.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import { syncDotFor, findSpaceFor, type SyncStatusData } from '../sync-dot-state';

interface ProjectSwitcherProps {
  projects: CentralIndexProject[];
  activeId: string | null;
  onSelect: (project: CentralIndexProject) => void;
  onClose: () => void;
  onAddProject: () => void;
  // Optional: removes a project from YouCoded (opens the confirm modal in the
  // parent). The palette is the project-list surface now that the rail is gone,
  // so the hover-revealed × delete lives on each row here.
  onDeleteProject?: (project: CentralIndexProject) => void;
  // Per-project sync state (spec §4) — drives the row sync dots and hides the
  // remove-× on synced rows. null → syncSpaces unavailable (no dots at all).
  syncStatus?: SyncStatusData | null;
}

// Shared glyphs — see ./icons.tsx. (The check is the active-project indicator,
// NOT a status glyph.)
import { SearchIcon, CheckIcon, PlusIcon } from './icons';
import { CloseButton } from '../ui';
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

  // ESC closes via the shared LIFO stack too — the input's own onKeyDown only
  // fires while the field is FOCUSED, and clicking a row blurs it. The palette
  // is only mounted while open, so `open` is simply true here.
  useEscClose(true, onClose);

  // Focus the search field on open. WHY: autoFocus inside an overlay can race
  // the mount/scrim; the ref pattern is reliable. (See task notes.)
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Case-insensitive substring match against name OR path. Empty query → all
  // projects in their given order.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [query, projects]);

  // Reset the keyboard highlight to the top whenever the filtered set changes
  // (query edits). Without this the highlight could point past the end.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // NOTE: no Escape branch here — the useEscClose registration above already
  // closes the palette via the shared LIFO stack; a second path would be
  // redundant. This handler owns only the list-navigation keys.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      // Clamp to range (no wrap — stop at the last row).
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
      return;
    }
  };

  const handleAdd = () => {
    // The parent owns the flow now: it closes this palette, opens the OS folder
    // picker, saves the folder (folders.add) and selects the new project.
    onAddProject();
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
        {/* Search row */}
        <div className="p-2.5 border-b border-edge-dim flex items-center gap-2">
          <span className="text-fg-muted pl-1">
            <SearchIcon size={17} />
          </span>
          {/* Keydown lives on the input so ↑/↓/Enter/Esc work while it's focused
              (it autofocuses on open). OverlayPanel's typed props don't surface
              onKeyDown, so attaching here is the correct seam. */}
          <input
            ref={inputRef}
            type="text"
            placeholder="Jump to project…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none text-base text-fg placeholder:text-fg-muted"
          />
          <span className="text-3xs text-fg-muted border border-edge-dim rounded px-1.5 py-0.5">
            esc
          </span>
        </div>

        {/* Recent micro-label */}
        <div className="px-2 pt-2">
          <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase px-2">
            Recent
          </span>
        </div>

        {/* Project rows */}
        <div className="p-2 max-h-[50vh] overflow-y-auto flex flex-col gap-0.5">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-sm-tight text-fg-muted">
              No projects match “{query.trim()}”.
            </div>
          )}
          {filtered.map((p, i) => {
            const isActive = p.id === activeId;
            const isHighlighted = i === highlightIndex;
            // Prefer the synced display name (cross-device registry overlay,
            // 2026-07-12) over the folder name for a synced project.
            const shown = ((findSpaceFor(p.path, syncStatus ?? null) as any)?.displayName as string | undefined) || p.name;
            // Same synced-wins precedence as the name above: registry overlay
            // for a synced project, saved-folders record for a plain folder.
            // WHY no `as any` here (unlike displayName above): SyncStatusData's
            // spaces now declare `description` (2026-08-05), so this read
            // type-checks without a cast — the type hole this feature opened
            // is closed. displayName's cast is untouched/out of scope.
            const desc = findSpaceFor(p.path, syncStatus ?? null)?.description || p.description || null;
            const avatar = shown.charAt(0).toUpperCase() || '?';
            return (
              // group/relative so the row can host a hover-revealed × delete
              // button (a button cannot nest inside the select button).
              <div key={p.id} className="group relative">
                <button
                  type="button"
                  // Keyboard highlight is outline-not-fill (border-accent); the
                  // active project gets a subtle bg-inset fill instead. pr-9
                  // reserves room for the hover × when delete is available.
                  className={`w-full flex items-center gap-2.5 px-2 py-2 ${onDeleteProject ? 'pr-9' : ''} rounded-md text-left transition-colors border ${
                    isHighlighted
                      ? 'border-accent bg-inset'
                      : isActive
                        ? 'border-transparent bg-inset'
                        : 'border-transparent hover:bg-inset'
                  }`}
                  onMouseEnter={() => setHighlightIndex(i)}
                  onClick={() => onSelect(p)}
                >
                  {/* Avatar: first letter of the name in a rounded square. */}
                  <span className="shrink-0 w-7 h-7 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-xs font-semibold text-fg-2">
                    {avatar}
                  </span>
                  {/* Name + path. */}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-fg truncate">
                        {shown}
                      </span>
                    </span>
                    <span className="block font-mono text-2xs text-fg-muted truncate" title={p.path}>
                      {p.path}
                    </span>
                    {/* Description as a THIRD line — additive, so the path stays
                        visible (it's what disambiguates two folders of the same
                        name). Rows with no description keep their current
                        height, so the list only grows where it's earning it.
                        Single line + truncate: a wrapping description would let
                        one verbose project set the row height for the whole
                        list. Italic-in-quotes matches the hero. */}
                    {desc && (
                      <span className="block text-2xs italic text-fg-dim truncate" title={desc}>
                        “{desc}”
                      </span>
                    )}
                  </span>
                  {/* Files · chats hint. "files" = ALL FILES (fileCount) — the
                      folder's on-disk files — falling back to the artifact
                      count until the withCounts pass resolves both (and for
                      GATED roots like Home, which get no fileCount at all —
                      no scan runs there). Truncated counts render "N+" so a
                      capped sample never poses as exact. Chat count appears
                      only after the withCounts pass. */}
                  {(() => {
                    const files = p.fileCount ?? p.stats.artifactCount;
                    const filesLabel = p.fileCountTruncated ? `${files.toLocaleString()}+` : String(files);
                    return (
                      // Hidden below 640px: this shrink-0 counts hint (~120px)
                      // squeezed the name+path column to ~140px in a 359px
                      // palette, truncating both to a few characters. The name
                      // is what identifies the project; the counts decorate.
                      <span className="hidden sm:inline text-2xs text-fg-muted shrink-0 whitespace-nowrap">
                        {filesLabel} file{files === 1 ? '' : 's'}
                        {typeof p.conversationCount === 'number' && (
                          <> · {p.conversationCount} chat{p.conversationCount === 1 ? '' : 's'}</>
                        )}
                      </span>
                    );
                  })()}
                  {/* Sync dot (spec §4) — green synced / red errored / gray
                      only-on-this-computer. Hidden entirely when syncStatus is
                      null (Android). Tooltip carries the plain-words label. */}
                  {(() => {
                    const dot = syncDotFor(p.path, syncStatus ?? null);
                    return dot ? (
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ml-1 ${dot.color === 'green' ? 'bg-green-400' : dot.color === 'red' ? 'bg-red-400' : 'bg-fg-faint'}`}
                        title={dot.label}
                        aria-label={dot.label}
                      />
                    ) : null;
                  })()}
                  {/* Active check (NOT a status glyph). */}
                  {isActive && (
                    <span className="text-fg shrink-0 ml-1">
                      <CheckIcon size={15} />
                    </span>
                  )}
                </button>
                {/* Hover-revealed remove-from-YouCoded × (opens the confirm modal
                    in the parent). Does not delete files. Hidden for SYNCED rows —
                    removing a folder that's managed by sync is a deferred
                    move-out flow, not a simple un-list. */}
                {onDeleteProject && !findSpaceFor(p.path, syncStatus ?? null) && (
                  <CloseButton
                    // w-6 h-6 survives as a className override: this is a hover-revealed
                    // affordance sized to the row, not a panel-header closer.
                    // touch-reveal + coarse-hit: group-hover never resolves on a
                    // touch device, so "Remove project" had no touch path at
                    // all on Android / remote phones. Stays visible and gets a
                    // 44px hit box when the pointer is coarse. pr-9 on the row
                    // already reserves the space, so nothing shifts.
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 touch-reveal coarse-hit transition-opacity w-6 h-6 rounded-md"
                    title={`Remove ${p.name} from YouCoded`}
                    label={`Remove ${p.name} from YouCoded`}
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Footer: Add a project (opens the OS folder picker via the parent). */}
        <button
          type="button"
          className="flex items-center gap-2 px-4 py-3 border-t border-edge-dim text-sm-tight text-fg-2 hover:bg-inset hover:text-fg transition-colors rounded-b-[inherit]"
          onClick={handleAdd}
        >
          <PlusIcon size={15} />
          Add a project
        </button>
      </OverlayPanel>
    </>
  );
}
