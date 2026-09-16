// ProjectHero — the top card of the Project View main column (Task 2.2).
// Replaces the minimal inline hero placeholder from Task 2.1.
//
// Layout (matches docs/superpowers/prototypes/2026-06-14-project-view-redesign.html):
//   PROJECT eyebrow
//   <project name button ▾>                        [New Conversation]
//   [folder] path · [octocat] owner/name  (both inline click targets)
//   N files · N conversations · N context files · active <when>
// (2026-07-23: the separate "N artifacts" stat was dropped when the Artifacts
// tab merged into Files — there is no longer a tab for it to correspond to.)
//
// The project name is a clickable switcher trigger (opens <ProjectSwitcher>,
// Task 2.3) and MUST NOT truncate — it wraps. The ONE accent use in this card is
// the New Conversation primary button.
import React, { useEffect, useState } from 'react';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import { getPlatform } from '../../platform';
import { type SyncDot } from '../sync-dot-state';

// Live, computed-in-ProjectView stats (NOT the stale stats.artifactCount).
// 2026-07-23: the separate `artifacts` count was dropped when the Artifacts
// tab merged into Files — see the file-merge spec.
interface HeroStats {
  // All on-disk files (the Files tab). null = gated root (home dir /
  // drive root — no scan runs, so there is no number to show).
  files: number | null;
  // True when discovery hit a cap — render "N+" so a truncated sample never
  // poses as an exact total.
  filesTruncated?: boolean;
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}

// "N", "N+" (truncated), or "—" (gated — no scan ran). Shared by the hero
// stat line and ProjectView's segment badges so the two can't disagree.
export function formatFileCount(files: number | null, truncated?: boolean): string {
  if (files === null) return '—';
  return truncated ? `${files.toLocaleString()}+` : String(files);
}
// null when the project folder has no git remote.
interface HeroRepo {
  webUrl?: string;
  owner?: string;
  name?: string;
}

// Per-project sync props, derived in ProjectView from syncSpaces.status().
interface HeroSync {
  dot: SyncDot;
  spaceId: string | null;
  lastSynced: string | null;
  errorMessage: string | null;
  // True when this project's registry record is a `stopped` tombstone (review
  // #4): a permanent detach, distinct from the global "Sync is turned off" state.
  stopped: boolean;
}

interface ProjectHeroProps {
  project: CentralIndexProject;
  // Synced display name from the cross-device project registry (2026-07-12),
  // overlaid at read time — prefer it over the folder name for a synced project.
  displayName?: string | null;
  // Synced description from the project registry when this project syncs, else
  // the local saved-folders one. Same read-time-overlay shape as displayName;
  // ProjectView picks which. null/empty → the "Add a description" affordance.
  description?: string | null;
  stats: HeroStats;
  repo: HeroRepo | null;
  onOpenSwitcher: () => void;
  onNewConversation: (cwd: string) => void;
  sync: HeroSync | null;             // null → syncSpaces unavailable: render no sync line
  onTurnOnSync: () => void;
  onSyncNow: (spaceId: string) => void;
  onRenamed: () => void;             // parent refreshes the list after a rename / stop
  canRemove: boolean;                // false for synced projects (move-out is deferred)
  onRemove: () => void;
}

// lucide-style chevron-down (matches prototype IC.chevDown).
function ChevronDown({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

import { createPortal } from 'react-dom';
import { FolderIcon, GitHubIcon, CogIcon } from './icons';
import { Button, TextInput, Textarea } from '../ui';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { OverlayPanel } from '../overlays/Overlay';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
// Decision 2026-08-06: the sync pill reverted from per-state glyphs to the
// plain colored dot — sync-spaces.md pins the dot as the ONE sanctioned
// status-color use, and ProjectSwitcher rows already use it, so two visual
// languages for one status was the wrong call. PROJECT_DESCRIPTION_MAX keeps
// the input's cap in lockstep with the shared type instead of re-typing 200.
import { PROJECT_DESCRIPTION_MAX } from '../../../shared/artifacts/types';

const MENU_WIDTH = 240;
const SYNC_POPOVER_WIDTH = 288;

/** One row in the hero's cog menu. `danger` items render red at rest — these
 *  are consequential enough that hover is the wrong moment to find out
 *  (carried over from the old danger-outline buttons, spec decision 67). */
interface MenuItem {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export function ProjectHero({
  project,
  displayName,
  description,
  stats,
  repo,
  onOpenSwitcher,
  onNewConversation,
  sync,
  onTurnOnSync,
  onSyncNow,
  onRenamed,
  canRemove,
  onRemove,
}: ProjectHeroProps) {
  const showRepoSlug = !!(repo?.webUrl && repo.owner && repo.name);
  const isElectron = getPlatform() === 'electron';

  // The visible name prefers the synced display name over the folder name.
  const shownName = displayName || project.name;
  // Folder name = the immutable sync identity, recovered from the space id. Non-
  // null only for a SYNCED project — that's what routes rename/stop through sync.
  const syncedFolderName = sync?.spaceId?.startsWith('project:')
    ? sync.spaceId.slice('project:'.length)
    : null;

  // Rename — inline field on the actions row. Resets whenever the active project
  // changes (keyed on path) so a half-typed name from the last project doesn't
  // bleed into the next. Seeded from the visible (possibly synced) name.
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState(shownName);
  useEffect(() => { setNickname(shownName); setRenaming(false); }, [project.path, shownName]);
  const commitRename = async () => {
    const n = nickname.trim();
    setRenaming(false);
    if (!n || n === shownName) return;
    if (syncedFolderName) {
      // Synced project: change the SYNCED display name (propagates to every
      // device via the Personal space). NEVER the folder on disk — the repo name
      // is derived from the folder, so a folder move is a deferred flow (spec §15).
      await (window.claude as any).syncSpaces.renameProject?.(syncedFolderName, n).catch(() => {});
    } else {
      // Plain local folder: picker nickname only. folders.rename updates the
      // nickname, which buildSavedFolderProjects prefers for the display name.
      await (window.claude as any).folders.rename(project.path, n).catch(() => {});
    }
    onRenamed();
  };

  // Description — same inline-edit contract as rename (Enter commits, Escape
  // reverts, blur commits) and the same reset-on-project-change guard, so a
  // half-typed description can't bleed into the next project.
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(description ?? '');
  useEffect(() => { setDescDraft(description ?? ''); setEditingDesc(false); }, [project.path, description]);
  // Size the description editor to its content so it matches the footprint of
  // the rendered text it replaced. Set to 'auto' first: without that, height
  // only ever grows (scrollHeight can't shrink below the height already set),
  // so deleting a line would leave the box tall.
  const fitDescHeight = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  // Ref callback rather than an effect — it fires once the node exists, which is
  // the moment the height is measurable.
  const autoGrowDesc = (el: HTMLTextAreaElement | null) => fitDescHeight(el);

  const commitDescription = async () => {
    const d = descDraft.trim();
    setEditingDesc(false);
    if (d === (description ?? '').trim()) return;
    if (syncedFolderName) {
      // Synced: the description rides the cross-device project registry next to
      // displayName, so every device sees the same words.
      // No `?.` — both channels are real now (Tasks 2-5), so a missing one
      // should fail loudly instead of silently no-opping.
      await (window.claude as any).syncSpaces.setProjectDescription(syncedFolderName, d).catch(() => {});
    } else {
      // Plain local folder: saved-folders record only — nothing to sync it to.
      // `d` is always a string (descDraft.trim()) — the local-folder handler's
      // trim() has no null guard, so this must never pass null/undefined.
      await (window.claude as any).folders.setDescription(project.path, d).catch(() => {});
    }
    onRenamed();
  };

  // Stop syncing — consequence-gated (destructive-UI convention): a first click
  // arms the confirm, a second confirms. Detaches this project's sync on every
  // device while keeping each local copy; permanent (no Resume — spec §15).
  const [confirmingStop, setConfirmingStop] = useState(false);
  useEffect(() => { setConfirmingStop(false); }, [project.path]);
  const commitStop = async () => {
    setConfirmingStop(false);
    if (!syncedFolderName) return;
    await (window.claude as any).syncSpaces.stopProject?.(syncedFolderName).catch(() => {});
    onRenamed(); // optimistic refresh; a Personal `synced` event also refreshes
  };

  // NARROW ONLY. Below 640px the management actions collapse behind a cog:
  // a row of six buttons plus a shrink-0 button column left the project name a
  // couple of characters wide on a phone. Desktop has the room, so it keeps
  // every action visible — collapsing there would cost a click for no gain.
  const narrow = useNarrowViewport();
  const menu = useAnchoredMenu<HTMLButtonElement>(MENU_WIDTH, 'right');
  // The sync pill's own popover. Left-aligned (the pill sits at the LEFT of the
  // actions row, unlike the cog) and wider than the cog menu because it carries
  // a sentence rather than a list of one-line rows. Reuses the same hook, so
  // outside-click and Escape dismissal behave identically to every other menu.
  const syncMenu = useAnchoredMenu<HTMLButtonElement>(SYNC_POPOVER_WIDTH, 'left');

  // Sync actions are NOT here — they live in the sync pill's popover, which
  // renders at every width (2026-08-06: the popover replaced the cog as the
  // sync entry point on narrow, so keeping the rows here would just duplicate
  // it). The cog is management only now.
  const destructiveAction: MenuItem | null =
    canRemove
      ? { key: 'remove', label: 'Remove from YouCoded', onClick: onRemove, danger: true }
      : null;

  // 'reveal'/'repo' rows used to live here, duplicating "Open in File Explorer"/
  // "Open repo" — both are gone now that the path/repo line below is itself a
  // click target at every width, cog menu included.
  const menuItems: MenuItem[] = [
    { key: 'rename', label: 'Rename', onClick: () => setRenaming(true) },
    ...(destructiveAction ? [destructiveAction] : []),
  ];

  // The pill's five states. `short` is what fits on the pill; `detail` is the
  // full sentence the 2026-07-09 spec pins, which now lives in the popover
  // rather than being cut — shortening the readout must not delete the honesty
  // copy. `action` is the one thing you can DO from that state, which the
  // popover also carries, so no state's action is stranded at any width.
  // WHY no `icon` field (2026-08-06 revert): the mockup gave each state its
  // own glyph; the repo owner reverted to the plain dot post-approval, so the
  // pill/popover render `sync.dot.color` directly instead of a per-state icon.
  const syncPill: {
    short: string; tone: string;
    detail: string; action: { label: string; onClick: () => void } | null;
  } | null = !sync ? null
    : sync.dot.color === 'green'
      ? {
          short: sync.lastSynced ? `Synced ${sync.lastSynced}` : 'Synced',
          tone: 'text-[#44A05C]',
          detail: 'Syncs across your devices.',
          action: sync.spaceId ? { label: 'Sync now', onClick: () => onSyncNow(sync.spaceId!) } : null,
        }
    : sync.dot.color === 'red'
      ? {
          short: 'Sync problem', tone: 'text-[#DD4444]',
          // The REAL error, never a guess — surfaced verbatim when the engine
          // gave one (error-message-standards.md).
          detail: sync.errorMessage
            ? `Sync isn't working. ${sync.errorMessage}`
            : "Sync isn't working.",
          action: sync.spaceId ? { label: 'Try again', onClick: () => onSyncNow(sync.spaceId!) } : null,
        }
    : sync.spaceId && sync.stopped
      ? {
          short: 'Sync stopped', tone: 'text-fg-dim',
          detail: 'Sync stopped — this project stays on your devices but no longer syncs between them.',
          action: null, // Permanent tombstone: there is no Resume (spec §15).
        }
    : sync.spaceId
      ? {
          short: 'Sync off', tone: 'text-fg-dim',
          detail: 'Sync is turned off — this project will sync once you turn it on in Settings.',
          action: null, // The switch is global; it lives in Settings, not here.
        }
      : {
          short: 'Only on this computer', tone: 'text-fg-2',
          detail: 'This project stays on this computer until you turn on sync for it.',
          // The action that had NO desktop home in the refresh-icon shape.
          action: { label: 'Turn on sync for this project', onClick: onTurnOnSync },
        };

  return (
    // Stacks below 640px. Before the cog collapse the right column was shrink-0
    // with two size="lg" buttons (~268px together), which on a 390px phone left
    // the entire left column — name, path, sync strip, stats — about 34px wide.
    // data-guide-anchor: the first-run tour's Projects stop rings this card
    // once a project exists (a fresh install rings "Add a project" instead).
    <div className="layer-surface p-3 sm:p-5 flex flex-col gap-3 sm:gap-4" data-guide-anchor="project-hero">
      {/* Top row: the content column, plus the narrow-only cog pinned right.
          WHY the card is a COLUMN now (2026-08-06): New Conversation moved to
          the bottom-right, so the old left/right split stopped describing the
          layout — the cog is the only thing still anchored top-right. */}
      <div className="flex items-start justify-between gap-3">
        {/* Content: eyebrow + name switcher + path/repo + description + stats.
            `flex-1` is load-bearing: without it the column is sized by its
            widest child's MAX-CONTENT width. A <textarea>'s max-content width is
            its default ~20 `cols`, not its text, so opening the description
            editor collapsed the whole column to the stats row's width (~333px)
            and the editor re-wrapped 2 lines into 3. `flex-1` makes the width
            the row's, so read and edit modes occupy the same box. */}
        <div className="flex-1 min-w-0">
        <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1.5">
          Project
        </div>

        {/* Name as the switcher trigger. WHY: must NOT truncate — the user
            explicitly called this out. whitespace-normal + break-words let long
            project names wrap instead of clipping. */}
        {/* Renaming swaps the heading itself for the field. WHY here and not on
            an actions row (where it used to live): the rename target IS the
            name, so editing it anywhere else made you look in two places at
            once — and with the actions row gone there is nowhere else to put it. */}
        {renaming ? (
          <TextInput
            size="sm"
            value={nickname}
            autoFocus
            aria-label="Project nickname"
            className="text-2xl font-semibold w-full"
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') { setNickname(shownName); setRenaming(false); } }}
            onBlur={() => void commitRename()}
          />
        ) : (
          <button
            type="button"
            onClick={onOpenSwitcher}
            className="group flex items-start gap-2 text-left rounded-md -ml-1 px-1 py-0.5 hover:bg-inset transition-colors"
            title="Switch project"
          >
            <span className="text-2xl font-semibold text-fg leading-tight whitespace-normal break-words">
              {shownName}
            </span>
            <span className="text-fg-muted group-hover:text-fg shrink-0 mt-1.5">
              <ChevronDown size={18} />
            </span>
          </button>
        )}

        {/* Path + optional owner/name repo slug — both double as click targets
            (Open in File Explorer / Open on GitHub), replacing the old
            standalone buttons this row now subsumes. */}
        <div className="flex items-center gap-2 mt-1.5 min-w-0">
          <button
            type="button"
            onClick={isElectron ? () => void (window.claude as any).shell.openPath(project.path) : undefined}
            disabled={!isElectron}
            className="inline-flex items-center gap-1 min-w-0 text-fg-muted hover:text-fg-2 transition-colors disabled:cursor-default"
            title={isElectron ? 'Open in File Explorer' : project.path}
          >
            <FolderIcon size={13} />
            <span
              className={`font-mono text-xs truncate ${isElectron ? 'underline decoration-dotted underline-offset-2 decoration-fg-faint hover:decoration-fg-muted' : ''}`}
            >
              {project.path}
            </span>
          </button>
          {showRepoSlug && (
            <>
              <span className="text-fg-faint shrink-0">·</span>
              <button
                type="button"
                onClick={() => window.claude.shell.openExternal(repo!.webUrl!)}
                className="inline-flex items-center gap-1 text-xs text-fg-dim hover:text-fg-2 shrink-0 transition-colors"
                title={`Open ${repo!.owner}/${repo!.name} on GitHub`}
              >
                <GitHubIcon size={13} />
                <span className="underline decoration-dotted underline-offset-2 decoration-fg-faint hover:decoration-fg-muted">
                  {repo!.owner}/{repo!.name}
                </span>
              </button>
            </>
          )}
        </div>

        {/* Description — the slot the sync strip used to occupy. Italic inside
            curly quotes: it reads as the user's own words about the project
            rather than as another piece of app chrome, and the quotes make an
            empty-vs-set state legible without a label. Curly, matching the
            stop-sync confirm copy below. */}
        {editingDesc ? (
          // A Textarea, not a TextInput, so the editor occupies the SAME box as
          // the text it replaces: the rendered description wraps inside
          // max-w-[46rem], and a single-line input made the card jump on click
          // and hid the tail of a long description behind a scroll. Same
          // max-width, same text-sm, and autoGrowDesc sizes it to its content on
          // mount and on every keystroke. Enter still COMMITS (matching rename)
          // — the wrap is for layout parity, not for multi-line values.
          <Textarea
            size="sm"
            ref={autoGrowDesc}
            value={descDraft}
            rows={1}
            autoFocus
            aria-label="Project description"
            placeholder="What is this project?"
            className="mt-1.5 -ml-2.5 w-full max-w-[46rem] text-sm italic overflow-hidden"
            // Cap at the keystroke, not just on commit — PROJECT_DESCRIPTION_MAX
            // is the shared source of truth (shared/artifacts/types.ts), not a
            // re-typed 200 that could drift from the main-process limit.
            maxLength={PROJECT_DESCRIPTION_MAX}
            onChange={(e) => { setDescDraft(e.target.value); fitDescHeight(e.currentTarget); }}
            onKeyDown={(e) => {
              // preventDefault so Enter commits instead of inserting the newline
              // a textarea would otherwise take.
              if (e.key === 'Enter') { e.preventDefault(); void commitDescription(); }
              if (e.key === 'Escape') { setDescDraft(description ?? ''); setEditingDesc(false); }
            }}
            onBlur={() => void commitDescription()}
          />
        ) : description ? (
          <button
            type="button"
            onClick={() => setEditingDesc(true)}
            // Geometry MUST match the Textarea below exactly -- same padding,
            // radius, negative margin, and a transparent 1px border standing in
            // for the field's real one. Otherwise clicking to edit shifts the
            // text and resizes the box under the cursor.
            className="mt-1.5 block text-left rounded-lg border border-transparent -ml-2.5 px-2.5 py-1.5 hover:bg-inset transition-colors max-w-[46rem]"
            title="Edit description"
          >
            <span className="text-sm italic text-fg-dim">“{description}”</span>
          </button>
        ) : (
          // Dashed-outline add affordance, matching QuickChips' "+ Add Chip" and
          // ModelPicker's freeform row. Bare hover-only text read as a label,
          // not a control -- there was nothing to see until the cursor was
          // already on it. `-ml-2 px-2` keeps the LABEL aligned with the name
          // and path above, so the box hangs into the card's gutter instead of
          // indenting the text.
          <button
            type="button"
            onClick={() => setEditingDesc(true)}
            className="mt-1.5 -ml-2 inline-flex items-center gap-1 rounded-md border border-dashed border-edge-dim px-2 py-1 text-xs text-fg-muted hover:text-fg hover:border-edge hover:bg-inset transition-colors"
          >
            <span aria-hidden="true" className="text-sm leading-none">+</span>
            Add a description
          </button>
        )}

        {/* Stop-syncing confirm. Armed from the cog menu; the consequence copy
            is far too long for a menu row, so it lands here where the sync
            state it's about is already on screen. */}
        {confirmingStop && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#DD4444]/40 px-3 py-2">
            <span className="text-2xs text-fg-dim max-w-[22rem]">
              Stop syncing “{shownName}”? The folder stays on all your devices, but changes will no longer sync between them. This can’t be undone from here.
            </span>
            <Button variant="danger-outline" size="sm" onClick={() => void commitStop()}>
              Stop syncing
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingStop(false)}>
              Cancel
            </Button>
          </div>
        )}

        {/* Stat row — dot-separated. */}
        <div className="flex flex-wrap gap-4 mt-3 text-xs text-fg-muted">
          <span><b className="text-fg-2 font-semibold">{formatFileCount(stats.files, stats.filesTruncated)}</b> files</span>
          <span><b className="text-fg-2 font-semibold">{stats.conversations}</b> conversations</span>
          <span><b className="text-fg-2 font-semibold">{stats.contextFiles}</b> context files</span>
          <span>active <b className="text-fg-2 font-semibold">{stats.activeLabel}</b></span>
        </div>

        </div>

        {/* Narrow-only cog, now top-right of the card (it used to sit beside
            New Conversation, which moved to the bottom). */}
        {narrow && (
          <button
            ref={menu.anchorRef}
            type="button"
            onClick={menu.toggle}
            className={`coarse-hit shrink-0 p-2 rounded-md border border-edge transition-colors ${
              menu.open ? 'bg-inset text-fg' : 'text-fg-muted hover:text-fg hover:bg-inset'
            }`}
            title="Project settings"
            aria-label="Project settings"
            aria-haspopup="menu"
            aria-expanded={menu.open}
          >
            <CogIcon size={16} />
          </button>
        )}
      </div>

      {/* Bottom row: management actions left, the primary action right
          (2026-08-06 — New Conversation moved down here from the top-right).
          It renders unconditionally because New Conversation always exists,
          even when the actions cluster inside it does not. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* Management actions (spec §4). The cluster renders at every width
            because the sync pill lives in it and the readout is not a
            desktop-only luxury — only the management BUTTONS stay behind the
            narrow cog (see the `narrow` note above).
            Rename = picker nickname only; the field itself renders up at the
            heading (one rename UI at both widths). Remove hides for synced
            projects (move-out-of-sync is a deferred flow). */}
        {(syncPill || !narrow) && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Sync pill — the old status strip compressed to its state word,
                sitting left of Rename. The dot colour is the ONE sanctioned
                status-colour use (sync-spaces rule). The refresh button is the
                whole action surface for the two states that HAVE a refresh;
                see the states note on `syncPill` above for the other three. */}
            {syncPill && (
              <button
                type="button"
                ref={syncMenu.anchorRef}
                onClick={syncMenu.toggle}
                aria-expanded={syncMenu.open}
                aria-label={`Sync status: ${syncPill.short}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
                  // Rest is UNFILLED, exactly like the `secondary` Buttons beside
                  // it, so hover has somewhere to go: hover fills to `bg-inset`.
                  // Two earlier attempts were too subtle because both relied on
                  // a relationship no theme guarantees -- `edge-dim -> edge` is
                  // one 1px line, and `inset -> edge` asks a BORDER token to read
                  // as a background, which in green/low-contrast themes it does
                  // not. `transparent -> bg-inset` is the app's most-used hover
                  // pair (82 sites) and is visible in every shipped theme.
                  // Label colour deliberately untouched: Button.tsx's rule is
                  // "hover is ALWAYS a background fade, the label stays crisp".
                  syncMenu.open
                    ? 'border-edge bg-well'
                    : 'border-edge-dim hover:bg-inset hover:border-edge'
                }`}
              >
                {/* Plain colored dot (2026-08-06 revert) — same shape as
                    ProjectSwitcher's row dot, the one sanctioned status-color
                    use in this project (sync-spaces.md). */}
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    sync!.dot.color === 'green' ? 'bg-[#44A05C]'
                    : sync!.dot.color === 'red' ? 'bg-[#DD4444]'
                    : 'bg-fg-faint'
                  }`}
                />
                <span className={`text-2xs font-medium ${syncPill.tone}`}>{syncPill.short}</span>
              </button>
            )}
            {!narrow && !renaming && (
              <Button variant="secondary" size="sm" onClick={() => setRenaming(true)}>
                Rename
              </Button>
            )}
            {/* "Open in File Explorer" used to live here — it's now the path
                line above (every width, not desktop-only). */}
            {/* WHY danger-outline (spec decision 67): "Remove from YouCoded" and
                "Stop syncing" used to look neutral and only turn red on hover.
                These are consequential enough that hover is the wrong moment to
                find that out, so they read as destructive at rest. "Rename"
                above stays neutral — being the only non-red one is what makes
                it read as the safe action. */}
            {!narrow && (canRemove ? (
              <Button variant="danger-outline" size="sm" onClick={onRemove}>
                Remove from YouCoded
              </Button>
            ) : syncedFolderName ? (
              // Nothing here for a synced project. "Stop syncing" moved INTO the
              // sync popover (2026-08-05) so every sync action lives behind the
              // pill, and the bare "Sync stopped" text that used to sit here is
              // gone — the pill states that two inches to the left, and printing
              // it twice in one row reads as a rendering bug.
              null
            ) : (
              // Kept — this explains why there is no Remove button, which is a
              // different fact from the pill's sync state.
              <span className="text-2xs text-fg-muted">Managed by sync</span>
            ))}
          </div>
        )}

        {/* "Open repo" used to live in a right-hand column — it's now the
            repo-slug link in the path/repo row above, at every width.
            The ONE accent use in this hero. `sm:ml-auto` keeps it hard right
            even when the actions cluster above is absent. */}
        <Button
          size="lg"
          className="w-full sm:w-auto sm:shrink-0 sm:ml-auto"
          onClick={() => onNewConversation(project.path)}
        >
          New Conversation
        </Button>
      </div>

      {narrow && menu.open && menu.pos && createPortal(
        <OverlayPanel
          ref={menu.menuRef}
          role="menu"
          // L4, not the old hardcoded z-[9000]. That value existed only to clear
          // ProjectView's z-[8000]; ProjectView is a z-40 screen now (change 26),
          // so 9000 would float this kebab above every overlay in the app. L4
          // matches the other portaled anchored menus (ContextMenu, Select).
          layer={4}
          className="overlay-no-drag fixed py-1"
          style={{ top: menu.pos.top, left: menu.pos.left, width: MENU_WIDTH, borderRadius: 'var(--radius-lg)' }}
        >
          {menuItems.map((item, i) => (
            <React.Fragment key={item.key}>
              {/* Hairline above the destructive item so it can't be hit by
                  muscle memory aimed at the row above it. */}
              {item.danger && i > 0 && <div className="my-1 border-t border-edge-dim" />}
              <button
                type="button"
                role="menuitem"
                onClick={menu.choose(item.onClick)}
                className={`coarse-roomy w-full text-left px-3 py-2 text-sm-tight transition-colors hover:bg-inset ${
                  item.danger ? 'text-[#DD4444]' : 'text-fg-2 hover:text-fg'
                }`}
              >
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </OverlayPanel>,
        document.body,
      )}

      {/* Sync popover — the status strip's full copy and its one action, moved
          off the card and behind the pill. Portaled at L4 like the cog menu
          above, so it can't be clipped by the hero's own box, and it renders at
          EVERY width: this is the only place the red state's real error message
          and the "Turn on sync" action exist, so hiding it on narrow would
          strand them (narrow-viewport.md — never hide a control unless another
          entry point exists). */}
      {syncPill && syncMenu.open && syncMenu.pos && createPortal(
        <OverlayPanel
          ref={syncMenu.menuRef}
          layer={4}
          className="overlay-no-drag fixed p-3"
          style={{ top: syncMenu.pos.top, left: syncMenu.pos.left, width: SYNC_POPOVER_WIDTH, borderRadius: 'var(--radius-lg)' }}
        >
          <div className="flex items-center gap-1.5 mb-1.5">
            {/* Same dot as the trigger — the popover header restates the pill,
                so it must restate it with the same visual language. */}
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                sync!.dot.color === 'green' ? 'bg-[#44A05C]'
                : sync!.dot.color === 'red' ? 'bg-[#DD4444]'
                : 'bg-fg-faint'
              }`}
            />
            <span className={`text-2xs font-semibold ${syncPill.tone}`}>{syncPill.short}</span>
          </div>
          <p className="text-xs text-fg-dim leading-snug">{syncPill.detail}</p>
          {syncPill.action && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2.5 w-full"
              onClick={syncMenu.choose(syncPill.action.onClick)}
            >
              {syncPill.action.label}
            </Button>
          )}
          {/* Stop syncing — moved off the actions row so every sync action sits
              behind the pill. Still consequence-gated: this ARMS the on-card
              confirm rather than acting, because the confirm's copy is far too
              long for a 288px popover. Hairline above it for the same reason the
              cog menu has one — a destructive action must not be hit by muscle
              memory aimed at the button above it. Absent once stopped: the
              tombstone is permanent, there is nothing left to stop (spec §15). */}
          {syncedFolderName && !sync?.stopped && (
            <>
              <div className="my-2.5 border-t border-edge-dim" />
              <Button
                variant="danger-outline"
                size="sm"
                className="w-full"
                onClick={syncMenu.choose(() => setConfirmingStop(true))}
              >
                Stop syncing
              </Button>
            </>
          )}
        </OverlayPanel>,
        document.body,
      )}
    </div>
  );
}
