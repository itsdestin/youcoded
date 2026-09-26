// The chat window and what opens from it (header, composer, status bar), plus
// the full-screen views reached from the header and the welcome screen.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const CHAT: readonly ScreenEntry[] = [
  chat('chat', 'view'),
  chat('chat/sessions', 'menu'),
  chat('chat/switcher', 'menu'),
  chat('chat/close-session', 'dialog'),
  chat('chat/find', 'bar'),
  chat('chat/skills', 'drawer'),
  chat('chat/model-picker', 'dialog'),
  chat('chat/preferences', 'dialog'),
  chat('chat/resume', 'dialog'),
  { ...chat('chat/resume#stress', 'dialog'), scenario: 'stress' },
  chat('chat/open-tasks', 'dialog'),
  chat('chat/tags', 'dialog'),
  chat('chat/status-bar', 'dialog'),
  chat('chat/status-bar/themes', 'dialog'),
  chat('chat/quick-chips', 'dialog'),
  chat('chat/files', 'pane'),
  chat('chat/terminal', 'view'),
  chat('chat/games', 'pane'),
  // No session at all: the first screen a new user sees.
  { name: 'welcome', tags: ['view'], scenario: 'empty' },
  { name: 'projects', tags: ['view', 'projects'] },
  { name: 'pages', tags: ['view', 'pages'] },
  { name: 'marketplace', tags: ['view', 'marketplace'] },
  { name: 'library', tags: ['view', 'marketplace'] },
];
