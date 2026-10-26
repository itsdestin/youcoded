import { useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { ChatProvider } from '../../state/chat-context';
import { BuddyChat, type BuddyActionsAt } from './BuddyChat';

// `seed` is the workbench's hook into this window's chat store (dev/workbench/mockups/BuddyChatScreen.tsx); the app passes nothing.
export function BuddyChatApp({ seed, actionsAt }: { seed?: React.ReactNode; actionsAt?: BuddyActionsAt } = {}) {
  // Entrance/exit fade+scale (spec §5): first mount plays the entrance;
  // buddy:chat-state pushes replay it on every re-show and play the exit
  // before main hides the window (main delays hide() ~140ms for the fade).
  const [phase, setPhase] = useState<'enter' | 'exit'>('enter');
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-chat');
    const off = window.claude?.buddy?.onChatState?.((s: { visible: boolean }) => {
      if (s.visible) { setPhase('enter'); setReplayKey((k) => k + 1); }
      else setPhase('exit');
    });
    return off;
  }, []);

  return (
    <ThemeProvider>
      {/* ChatProvider is needed because BubbleFeed imports ToolCard which calls
          useChatDispatch() for permission approval responses. The buddy window
          has its own isolated React tree — it does NOT share the main window's
          ChatProvider instance. */}
      <ChatProvider>
        {seed}
        {/* buddy-chat-panel carries the frosted-glass chrome (buddy.css) — it
            has to be the same element the enter/exit animation scales, or the
            glass rectangle appears instantly and only the contents animate. */}
        <div
          key={replayKey}
          className={`buddy-chat-panel ${phase === 'enter' ? 'buddy-chat-enter' : 'buddy-chat-exit'}`}
          style={{ width: '100%', height: '100%' }}
        >
          <BuddyChat actionsAt={actionsAt} />
        </div>
      </ChatProvider>
    </ThemeProvider>
  );
}
