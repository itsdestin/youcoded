// The buddy's "Minimize to tray" switch in Settings → Buddy Floater: the
// floating mascot, or an icon in the taskbar / menu bar that opens the same chat
// (Destin 2026-10-02). Its own file so SettingsPanel stays inside its line budget.
import React from 'react';
import { SettingRow, Toggle } from './ui';
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

// WHY a switch, not a Floating / Taskbar picker (Destin 2026-10-03: "just make
// it a 'minimize to tray' toggle"): there are only two states and one of them is
// the default, so a single on/off reads faster and matches the popup's other row.
export function BuddyStyleRow({ style, platform, onChange }: {
  style: BuddyStyle;
  platform: string | null;
  onChange: (next: BuddyStyle) => void;
}) {
  return (
    <SettingRow
      variant="item"
      title="Minimize to tray"
      description={`Show the buddy as an icon in your ${trayPlaceName(platform)} instead of floating on your desktop. Click it to open the chat.`}
      control={
        <Toggle
          checked={style === 'tray'}
          onChange={(on) => onChange(on ? 'tray' : 'floating')}
          aria-label="Minimize to tray"
        />
      }
    />
  );
}
