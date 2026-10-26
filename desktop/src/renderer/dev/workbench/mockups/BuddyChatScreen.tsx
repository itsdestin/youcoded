// src/renderer/dev/workbench/mockups/BuddyChatScreen.tsx
//
// The buddy's CHAT window with a conversation in it, against the mock backend — the screen the buddy
// rebuild (2026-10-25) is reviewed on. Renders the SHIPPING <BuddyChatApp/>, so this page cannot drift from
// the floater. The viewport IS the window: photograph it at the chat's real size (CHAT_SIZE, 320x480).
// Reached at ?mode=workbench&child=1&view=buddy-chat (routing in index.tsx); ?theme=<slug> picks the theme.
// Dev-only, like the rest of dev/.

import React, { useEffect } from 'react';
import { BuddyChatApp } from '../../../components/buddy/BuddyChatApp';
import { useChatDispatch } from '../../../state/chat-context';

// Same module-scope theme override as BuddySessionScreens.tsx (it says why it must run before ThemeProvider).
try {
  const t = new URLSearchParams(window.location.search).get('theme');
  if (t) {
    localStorage.setItem('youcoded-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }
} catch { /* private mode */ }

// The buddy window's <html> marker, set before first paint as index.tsx does for a real buddy window.
document.documentElement.setAttribute('data-mode', 'buddy-chat');

/** Seeds the buddy's chat store with the workbench conversations (the mock's seedChat, as App.tsx does). */
function Seed() {
  const dispatch = useChatDispatch();
  useEffect(() => {
    const off = (window.claude.on as any).seedChat?.((payload: any) => dispatch({ type: 'CHAT_STATE_SEEDED', sessions: payload } as any));
    return typeof off === 'function' ? off : undefined;
  }, [dispatch]);
  return null;
}

export function BuddyChatScreen() {
  // ?actions=header|composer|beside — the three placements of buddy-rebuild-questions#Q-5.
  const actions = (new URLSearchParams(window.location.search).get('actions') ?? 'beside') as any;
  return <BuddyChatApp seed={<Seed />} actionsAt={actions} />;
}
