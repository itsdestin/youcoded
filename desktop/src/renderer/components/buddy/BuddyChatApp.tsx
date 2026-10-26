import { useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { ChatProvider } from '../../state/chat-context';
import { BuddyChat } from './BuddyChat';

type Phase = 'enter' | 'exit' | 'rest';

export function BuddyChatApp({ seed }: { seed?: React.ReactNode } = {}) {
  // Entrance/exit: the first mount plays the entrance; buddy:chat-state pushes replay it on every re-show and play
  // the exit before main hides the window (main delays hide() ~140ms for the fade).
  //
  // WHY no remount (buddy rebuild, 2026-10-25): this used to key the WHOLE tree on every show, so each open threw the
  // conversation away and filled it again from the computer — the buddy felt slow to open, and a long chat was
  // rebuilt every time. Now only the panel's animation class restarts: 'rest' for one frame, then 'enter'.
  const [phase, setPhase] = useState<Phase>('enter');
  // Which side of the chat the mascot is on, so the chat grows out of him (buddy-rebuild-questions#Q-7).
  const [mascot, setMascot] = useState<'above' | 'below'>('below');
  // Hidden means idle (performance.md rule 2): while main has the window hidden, the chat stops drawing streamed
  // words and catches up when shown. The window's own visibility is the one fact that is always right here.
  const [shown, setShown] = useState(() => document.visibilityState === 'visible');

  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-chat');
    const onVis = () => setShown(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    const off = window.claude?.buddy?.onChatState?.((s: { visible: boolean; mascot?: 'above' | 'below' }) => {
      if (s.mascot) setMascot(s.mascot);
      if (s.visible) {
        setShown(true);
        setPhase('rest');
        requestAnimationFrame(() => setPhase('enter'));
      } else {
        setPhase('exit');
      }
    });
    return () => { document.removeEventListener('visibilitychange', onVis); off?.(); };
  }, []);

  return (
    <ThemeProvider>
      {/* ChatProvider: this window's own chat store — it does NOT share the main window's. */}
      <ChatProvider>
        {seed}
        {/* buddy-chat-panel carries the frosted-glass chrome (buddy.css) — it has to be the same element the
            enter/exit animation scales, or the glass rectangle appears instantly and only the contents animate. */}
        <div
          className={`buddy-chat-panel${phase === 'enter' ? ' buddy-chat-enter' : phase === 'exit' ? ' buddy-chat-exit' : ''}`}
          data-mascot={mascot}
          style={{ width: '100%', height: '100%' }}
        >
          <BuddyChat shown={shown} />
        </div>
      </ChatProvider>
    </ThemeProvider>
  );
}
