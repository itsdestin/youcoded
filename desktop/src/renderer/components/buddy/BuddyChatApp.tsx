import { useEffect } from 'react';

export function BuddyChatApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-chat');
  }, []);

  return (
    <div style={{ width: 320, height: 480, background: 'transparent', color: '#fff' }}>
      buddy chat placeholder
    </div>
  );
}
