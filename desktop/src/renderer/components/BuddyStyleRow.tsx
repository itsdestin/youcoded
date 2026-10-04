// The buddy's "Show as" choice in Settings → Buddy Floater: the floating mascot
// or an icon in the taskbar / menu bar that opens the same chat (Destin
// 2026-10-02). Its own file so SettingsPanel stays inside its line budget.
import React from 'react';
import { SegmentedTabs, SettingRow } from './ui';
import type { BuddyStyle } from '../../shared/types';

// Renderer-owned preference, like 'youcoded-buddy-enabled'. Read by Settings and
// by App.tsx's launch path, and passed to buddy.show() every time.
const BUDDY_STYLE_KEY = 'youcoded-buddy-style';
export function readBuddyStyle(): BuddyStyle {
  return localStorage.getItem(BUDDY_STYLE_KEY) === 'tray' ? 'tray' : 'floating';
}
export function saveBuddyStyle(style: BuddyStyle): void {
  localStorage.setItem(BUDDY_STYLE_KEY, style);
}

/** macOS calls the bar at the top of the screen the menu bar; everyone else
 *  knows the icon area as the taskbar. */
export function trayPlaceName(platform: string | null): string {
  return platform === 'darwin' ? 'menu bar' : 'taskbar';
}

export function BuddyStyleRow({ style, platform, onChange }: {
  style: BuddyStyle;
  platform: string | null;
  onChange: (next: BuddyStyle) => void;
}) {
  const place = trayPlaceName(platform);
  return (
    <SettingRow
      variant="item"
      title="Show as"
      description={style === 'tray'
        ? `An icon in your ${place}. Click it to open the chat.`
        : 'The mascot floats on your desktop. Click him to open the chat.'}
      control={
        <SegmentedTabs
          variant="contained"
          aria-label="Buddy style"
          value={style}
          onChange={(id) => onChange(id as BuddyStyle)}
          tabs={[
            { id: 'floating', label: 'Floating' },
            { id: 'tray', label: platform === 'darwin' ? 'Menu bar' : 'Taskbar' },
          ]}
        />
      }
    />
  );
}
