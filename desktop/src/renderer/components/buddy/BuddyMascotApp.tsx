import { useEffect } from 'react';

export function BuddyMascotApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-mascot');
  }, []);

  return (
    <div style={{ width: 80, height: 80, background: 'transparent' }}>
      <span style={{ color: '#fff' }}>🐱 buddy</span>
    </div>
  );
}
