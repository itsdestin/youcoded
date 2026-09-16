// Narrow-viewport overflow menu ("|||").
//
// Why this exists: below 640px the header can't fit the settings cog, the
// projects button, and the gamepad alongside the session strip and the
// artifact/view toggles. Previously the gamepad was simply `hidden sm:block`,
// which made Connect 4 UNREACHABLE on a phone — TOGGLE_PANEL had exactly one
// caller in the whole renderer, so an incoming challenge could never be
// answered. Rather than hide things, the three collapse into one menu.
//
// Deliberately NOT collapsed in here: the artifact drawer button and the
// chat/terminal toggle. Those are per-session view switches used constantly,
// so they stay one tap away in the header (Destin's call).
//
// Presentation is an anchored dropdown portaled to <body> at z-[9000], the
// same pattern (and the same load-bearing z-index) as SessionStrip's session
// dropdown — the header has a backdrop-filter stacking context and
// overflow-hidden ancestors, so an in-tree absolute dropdown gets clipped.

import { guardDirtyEditor } from './artifact-views/dirty-editor-guard';
import { createPortal } from 'react-dom';
import { useArtifact } from '../state/ArtifactContext';
import { GamepadIcon } from './Icons';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { useArtifactCount } from '../hooks/useArtifactCount';
import { Tooltip } from './ui';

const MENU_WIDTH = 208; // w-52

interface Props {
  activeSessionId: string | null;
  projectRoot?: string;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
  onToggleGamePanel: () => void;
  gamePanelOpen: boolean;
  gameConnected?: boolean;
  challengePending?: boolean;
}

export default function OverflowMenu({
  activeSessionId, projectRoot,
  onToggleSettings, settingsBadge, settingsDangerBadge,
  onToggleGamePanel, gamePanelOpen, gameConnected, challengePending,
}: Props) {
  const { state, dispatch } = useArtifact();
  // Session Files joined this menu on narrow (Destin, 2026-07-20; renamed from
  // "Session artifacts" 2026-07-23) — the header's right cluster is now the
  // chat/terminal toggle's home.
  const drawerOpen = activeSessionId ? (state.drawerOpenBySession[activeSessionId] ?? false) : false;
  const artifactCount = useArtifactCount(activeSessionId, projectRoot);
  // Positioning + outside/Escape dismissal live in the shared hook, which the
  // project-view hero menu also uses.
  const { open, toggle, anchorRef, menuRef, pos, choose } = useAnchoredMenu<HTMLButtonElement>(MENU_WIDTH);

  // Any badge on a collapsed item has to surface on the ||| button itself,
  // otherwise collapsing the header silently swallows the notification that
  // something needs attention. Danger (red) outranks challenge (orange)
  // outranks info (blue) — same precedence the cog uses on its own.
  const badgeColor = settingsDangerBadge ? 'bg-red-500'
    : challengePending ? 'bg-orange-400'
    : settingsBadge ? 'bg-blue-500'
    : null;


  const rows = [
    {
      key: 'settings',
      label: 'Settings',
      onClick: choose(onToggleSettings),
      active: false,
      dot: settingsDangerBadge ? 'bg-red-500' : settingsBadge ? 'bg-blue-500' : null,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      key: 'projects',
      label: 'Projects',
      onClick: choose(() => dispatch({ type: 'PROJECT_VIEW_OPENED' })),
      active: false,
      dot: null,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
      ),
    },
    {
      key: 'artifacts',
      label: artifactCount > 0 ? `Session Files (${artifactCount})` : 'Session Files',
      onClick: choose(() => {
        if (!activeSessionId) return;
        // Same D3 guard as the HeaderBar toggle — closing can discard a draft.
        guardDirtyEditor(() =>
          dispatch({ type: drawerOpen ? 'DRAWER_CLOSED' : 'DRAWER_OPENED', sessionId: activeSessionId }));
      }),
      active: drawerOpen,
      dot: null,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
    {
      key: 'games',
      // §4.1: names the pane, not one of its four games. Matches HeaderBar's
      // button title so the phone and desktop entry points read the same.
      label: challengePending ? 'Games — challenge!' : 'Games',
      onClick: choose(onToggleGamePanel),
      active: gamePanelOpen,
      dot: challengePending ? 'bg-orange-400' : gameConnected ? 'bg-green-400' : null,
      icon: <GamepadIcon className="w-4 h-4" />,
    },
  ];

  return (
    <>
      <Tooltip text="Menu">
      <button
        ref={anchorRef}
        type="button"
        onClick={toggle}
        // coarse-hit gives this a 44x44 touch target without changing its
        // visual box (globals.css). p-2 matches the Android cog sizing.
        className={`coarse-hit relative p-2 rounded-sm hover:bg-inset transition-colors shrink-0 ${open ? 'text-fg bg-inset' : 'text-fg-muted'}`}
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* Three horizontal bars — the ||| affordance. */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        {badgeColor && !open && (
          <span className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full ${badgeColor}`} />
        )}
      </button>
      </Tooltip>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          // overlay-no-drag: the header is WebkitAppRegion:drag, and a portaled
          // child of <body> still inherits nothing — but the class is what the
          // rest of the app's overlays use, so keep it consistent.
          className="glass-overlay overlay-no-drag fixed w-52 bg-panel border border-edge rounded-lg shadow-lg z-[9000] overflow-hidden py-1"
          style={{ top: pos.top, left: pos.left }}
        >
          {rows.map(r => (
            <button
              key={r.key}
              type="button"
              role="menuitem"
              onClick={r.onClick}
              className={`coarse-roomy w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors ${
                r.active ? 'text-accent' : 'text-fg-2 hover:text-fg'
              } hover:bg-inset`}
            >
              <span className="shrink-0">{r.icon}</span>
              <span className="flex-1 min-w-0 truncate">{r.label}</span>
              {r.dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.dot}`} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
