import { useEffect, useState } from 'react';
import { buildContextMenu, type MenuEntry } from './build-menu';
import { ContextMenu } from './ContextMenu';
import { useScreenOpen } from '../../shoot-mode';

// Single app-wide right-click host. Listens for `contextmenu` (capture) on the
// document, asks build-menu what (if anything) applies to the target, and — only
// when there's something actionable — suppresses the default menu and opens ours.
// Targets outside chat content / the composer are left untouched (terminal,
// settings, remote-browser native menu, etc.). Mounted once from App.

type MenuState = { x: number; y: number; entries: MenuEntry[]; screen?: string };

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const entries = buildContextMenu(target);
      if (!entries) return; // not our surface — leave the default behavior alone
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, entries });
    };
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  // Photo-only build: `shoot` opens the menu a right-click on the first VISIBLE element of
  // a kind would open (hidden sessions' chats are skipped), and names it for the mark.
  const openOn = (selector: string, screen: string, expand = false) => {
    // The last one inside the window: the chat sits scrolled to its end.
    const onScreen = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; };
    const el = [...document.querySelectorAll<HTMLElement>(selector)].filter(onScreen).pop();
    const entries = el ? buildContextMenu(el) : null;
    if (!el || !entries) {
      // Code and file links live inside tool output: Ctrl+O expands it, and `shoot`
      // presses open again once it has drawn.
      if (expand) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, bubbles: true }));
      return;
    }
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(20, r.height / 2), entries, screen });
  };
  useScreenOpen('chat/menu/assistant', () => openOn('.assistant-bubble', 'chat/menu/assistant'));
  useScreenOpen('chat/menu/user', () => openOn('.user-bubble', 'chat/menu/user'));
  useScreenOpen('chat/menu/composer', () => openOn('.input-bar-textarea', 'chat/menu/composer'));
  useScreenOpen('chat/menu/code', () => openOn('.chat-scroll pre', 'chat/menu/code', true));
  useScreenOpen('chat/menu/file', () => openOn('.chat-scroll [data-file-path]', 'chat/menu/file', true));

  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} screen={menu.screen} onClose={() => setMenu(null)} />;
}
