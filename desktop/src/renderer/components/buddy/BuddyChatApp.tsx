import { useEffect } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { BuddyChat } from './BuddyChat';

export function BuddyChatApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-chat');
  }, []);

  return (
    <ThemeProvider>
      <BuddyChat />
    </ThemeProvider>
  );
}
