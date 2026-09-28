// ScreenBand — the band across the top of a full-screen view (the page view
// and Project View), so the two read as rooms in one house (Destin,
// 2026-09-17: "add the same styled frame/header in projects view. we will
// unify these separate page/menu styles").
//
//   ┌ [⚙][▤][▢][pinned…]        ◷ Title            [Back to chat · Esc] [– □ ×] ┐
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
  /** Back to chat. */
  onBack: () => void;
  backLabel?: string;
}

export function ScreenBand({ settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge, active, title, onBack, backLabel = 'Back to chat' }: ScreenBandProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  // Float chrome only (a no-op elsewhere): the same wallpaper-derived icon tint
  // as the chat header. The chat's bottom controls are hidden under a screen and
  // belong to the chat header's own instance, so this one leaves them alone.
  useWallpaperHeaderInk(headerRef, { inkBottom: false });
  return (
    <div
      ref={headerRef}
      className="header-bar !relative grid grid-cols-3 items-center h-10 px-2 sm:px-3 shrink-0 select-none"
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
        <PinnedPageButtons />
      </div>
      <div className="flex items-center justify-center gap-2 min-w-0 px-3 text-sm font-medium text-fg">
        {title}
      </div>
      <div className="header-controls-right flex items-center justify-end gap-1 sm:gap-2">
        {/* Same inset pill and quiet text as the window buttons beside it
            (round 5: "should match styling of max/min/exit"). */}
        <div className="flex bg-inset rounded-md p-0.5">
          <button
            type="button"
            onClick={onBack}
            aria-label={backLabel}
            className={`px-2 py-1 rounded-sm flex items-center gap-1.5 text-xs leading-none ${ON_INSET_CONTROL}`}
          >
            {/* One size and one baseline for all three parts (round 6), with a
                dot between the words and the key. */}
            <span>{backLabel}</span>
            <span aria-hidden="true" className="hidden sm:inline text-fg-faint">·</span>
            <span className="hidden sm:inline text-fg-muted">Esc</span>
          </button>
        </div>
        {showCaptionButtons() && <CaptionButtons />}
      </div>
    </div>
  );
}
