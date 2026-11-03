// Floating menus and popovers opened by click steps (`open:`) rather than by a switch in the app:
// the filter lists inside the Resume browser. Added for the "what changed since
// the last release" comparison, which needs every visible part photographed.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const FLOATING: readonly ScreenEntry[] = [
  // The Resume browser's "all projects" and "tags" pick-any lists.
  { ...chat('chat/resume#projects-filter', 'dialog', 'popover'), open: [{ do: 'click', target: { role: 'button', label: 'Projects' } }] },
  { ...chat('chat/resume#tags-filter', 'dialog', 'popover'), open: [{ do: 'click', target: { role: 'button', label: 'Tags' } }] },

  // Dropdown lists (Select / TypeableSelect): the marketplace "Show" filter and Settings -> General's Step guard.
  { name: 'marketplace/skills#show-menu', tags: ['marketplace', 'view', 'popover'], open: [{ do: 'click', target: { role: 'button', label: 'Show' } }] },
  { name: 'settings/assistant/general#step-guard-open', tags: ['settings', 'dialog', 'popover'], open: [{ do: 'click', target: { role: 'combobox', label: 'Step guard' } }] },
  // Project header menus: the sync status pill's menu, and (phone width) the cog that holds the management buttons.
  { name: 'projects/files#sync-menu', tags: ['projects', 'view', 'menu'], open: [{ do: 'click', target: { role: 'button', labelStarts: 'Sync status' } }] },
  // Spreadsheet right-click menu, and a hover tip.
  { name: 'chat/files/open/a-q3-sales-comments#cell-menu', tags: ['chat', 'pane', 'viewer', 'menu'], open: [{ do: 'right-click', target: { role: 'clickable', labelStarts: 'A B C D E F G H I J K L', nth: 1 } }] },
  { name: 'chat#gear-tooltip', tags: ['chat', 'popover'], open: [{ do: 'hover', target: { role: 'button', label: 'Settings' } }] },
  // Comments: the hover card over a highlighted passage, and the open comments list over a sheet.
  { name: 'chat/files/open/a-launch-brief#highlight-card', tags: ['chat', 'pane', 'viewer', 'popover'], open: [{ do: 'hover', target: { role: 'clickable', labelStarts: 'Beta opens to 500 customers' } }] },
  { name: 'chat/files/open/a-q3-sales-comments#comments-open', tags: ['chat', 'pane', 'viewer'], open: [{ do: 'click', target: { role: 'button', label: 'Comments 3' } }] },
  // The phone's project header cog menu, (the browser page's right-click menu is skipped: the practice browser draws no page picture to click).
  { name: 'projects/files#cog-menu-phone', tags: ['projects', 'view', 'menu', 'narrow'], viewport: { width: 390, height: 844 }, open: [{ do: 'click', target: { role: 'button', label: 'Project settings' } }] },
  // Another hover tip: the status bar's tags chip.
  { name: 'chat#tags-chip-tooltip', tags: ['chat', 'popover'], open: [{ do: 'hover', target: { role: 'button', labelStarts: 'Tags & note' } }] },
];
