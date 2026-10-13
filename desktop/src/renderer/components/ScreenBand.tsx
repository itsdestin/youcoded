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
import { Button } from './ui/Button';
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
        {/* WHY a filled small Button reading "Esc · Back to chat", key first
            (decisions "Way back to chat", ui-element-review-headers#H-5:
            "Filled button on every full screen … key on the left"): this was
            an inset pill reading "Back to chat · Esc" (shell deck round 5–6,
            superseded by H-5), so the four full screens showed three exit
            looks. At phone width "Esc ·" is dropped (old guide §4.8). A filled
            button keeps its own colours under the float chrome's wallpaper ink
            (float-chrome.css skips `.bg-accent`). */}
        <Button
          variant="primary"
          size="sm"
          onClick={onBack}
          aria-label={backLabel}
          className="whitespace-nowrap"
        >
          <span aria-hidden="true" className="hidden sm:inline">Esc ·</span>
          <span>{backLabel}</span>
        </Button>
        {showCaptionButtons() && <CaptionButtons />}
      </div>
    </div>
  );
}
