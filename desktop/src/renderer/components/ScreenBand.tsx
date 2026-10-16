// ScreenBand — the band across the top of a full-screen view (the page view
// and Project View), so the two read as rooms in one house (Destin,
// 2026-09-17: "add the same styled frame/header in projects view. we will
// unify these separate page/menu styles").
//
//   ┌ [⚙][▤][▢][pinned…]        ◷ Title            [Esc · Back to chat] [– □ ×] ┐
//
// Same height, drag region and window buttons as the app's header; three
// equal columns so the title is truly centred (it truncates before the clusters do). The left cluster is the app's own
// destinations — Settings, Pages, Projects and the pinned pages — wired to
// the same places as in the chat header; `active` lights the one this screen
// IS. No chat/terminal toggle, files or games here. No border underneath: the
// framed pane's own edge is the divider (shell deck round 4).
import React, { useRef } from 'react';
import { CaptionButtons, MacTrafficLights, ProjectsButton, SettingsGearButton, showCaptionButtons } from './HeaderBar';
import { PagesButton, PinnedPageButtons } from './pages/PagesButton';
import { ON_INSET_CONTROL } from './header/control-states';
import { useWallpaperHeaderInk } from '../hooks/use-wallpaper-header-ink';

export interface ScreenBandProps {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
  /** Which destination this screen is; a focused pinned page lights its own
   *  pinned button instead (PinnedPageButtons reads that from state). */
  active: 'pages' | 'projects' | null;
  title: React.ReactNode;
  /** The screen's own icon, drawn before the title (decisions "Full-screen
   *  titles", H-1: "centered, small, with the screen's icon"). */
  icon?: React.ReactNode;
  /** Back to chat. */
  onBack: () => void;
  backLabel?: string;
}

export function ScreenBand({ settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge, active, title, icon, onBack, backLabel = 'Back to chat' }: ScreenBandProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  // Float chrome only (a no-op elsewhere): the same wallpaper-derived icon tint
  // as the chat header. The chat's bottom controls are hidden under a screen and
  // belong to the chat header's own instance, so this one leaves them alone.
  useWallpaperHeaderInk(headerRef, { inkBottom: false });
  return (
    <div
      ref={headerRef}
      // WHY max-sm:flex / justify-between (with the title and pinned pages hidden below 640px):
      // at phone width three equal columns could not hold the clusters, and the title, the
      // icons and "Back to chat" drew over each other. The lit Pages / Projects button still
      // says where you are; pinned pages stay reachable from Pages.
      className="header-bar !relative grid grid-cols-3 max-sm:flex max-sm:justify-between items-center h-10 px-2 sm:px-3 shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <MacTrafficLights headerRef={headerRef} />
      {/* header-controls-left/-right: class hooks only, so the 'float' chrome
          style (styles/float-chrome.css) gives these buttons the same floating
          surface as the chat header's. No other style reads them. */}
      <div className="header-controls-left flex items-center gap-1 sm:gap-2">
        <SettingsGearButton settingsOpen={settingsOpen} onToggleSettings={onToggleSettings} settingsBadge={settingsBadge} settingsDangerBadge={settingsDangerBadge} />
        <PagesButton active={active === 'pages'} />
        <ProjectsButton active={active === 'projects'} />
        <PinnedPageButtons className="max-sm:hidden" />
      </div>
      <div className="flex max-sm:hidden items-center justify-center gap-2 min-w-0 px-3 text-sm font-medium text-fg">
        {icon && <span className="shrink-0 text-fg-muted flex">{icon}</span>}
        {title}
      </div>
      <div className="header-controls-right flex items-center justify-end gap-1 sm:gap-2">
        {/* WHY the light inset pill again, key first (final-review#FV-6, Destin
            2026-10-14: "i really don't want esc/back to chat to be filled. it should
            be a light button like the old version was"). H-5 had made it a filled
            accent Button; this restores master's quiet pill, which matches the
            window buttons beside it (shell deck round 5: "should match styling of
            max/min/exit"), and keeps H-5's one lasting part, the key on the left.
            At phone width "Esc ·" is dropped (old guide §4.8). The float chrome's
            wallpaper ink already styles this pill (master shipped it). */}
        <div className="flex bg-inset rounded-md p-0.5">
          <button
            type="button"
            onClick={onBack}
            aria-label={backLabel}
            className={`px-2 py-1 rounded-sm flex items-center gap-1.5 text-xs leading-none whitespace-nowrap ${ON_INSET_CONTROL}`}
          >
            <span aria-hidden="true" className="hidden sm:inline text-fg-muted">Esc</span>
            <span aria-hidden="true" className="hidden sm:inline text-fg-faint">·</span>
            <span>{backLabel}</span>
          </button>
        </div>
        {showCaptionButtons() && <CaptionButtons />}
      </div>
    </div>
  );
}
