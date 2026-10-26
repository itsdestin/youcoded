// src/renderer/dev/workbench/mockups/BuddyGroupScreen.tsx
//
// The whole buddy as it sits on a desktop — the mascot, his chat and (in the 'beside' placement) the round buttons —
// for buddy-rebuild-questions#Q-5, which asked to SEE where the three actions could live. Positions come from the
// app's own geometry (shared/buddy-geometry.ts: computeGroupLayout, computeBarContentRect), so each window sits where
// the real one would; the chat is the shipping buddy chat in an iframe at its real size. The desktop behind it is a
// plain gradient: a real wallpaper is the user's, and the placement is what is being judged.
// Reached at ?mode=workbench&child=1&view=buddy-group&actions=header|composer|beside. Dev-only.

import React, { useRef } from 'react';
import { MascotRig, type RigMotion } from '../../../components/mascot/MascotRig';
import { BuddyBarButtons } from '../../../components/buddy/BuddyBarApp';
import { CHAT_SIZE, MASCOT_SIZE, computeGroupLayout, computeBarContentRect } from '../../../../shared/buddy-geometry';

try {
  const t = new URLSearchParams(window.location.search).get('theme');
  if (t) {
    localStorage.setItem('youcoded-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }
} catch { /* private mode */ }

const DESK = { x: 0, y: 0, width: 560, height: 680 };

export function BuddyGroupScreen() {
  const params = new URLSearchParams(window.location.search);
  const actions = params.get('actions') ?? 'beside';
  const theme = params.get('theme') ?? '';
  const motionRef = useRef<RigMotion>({ vx: 0, vy: 0, dragging: false });
  // The mascot low on the right, as most people park him; the layout puts the chat above.
  const mascotBounds = { x: 360, y: 540, width: MASCOT_SIZE.width, height: MASCOT_SIZE.height };
  const layout = computeGroupLayout(mascotBounds, DESK);
  const bar = computeBarContentRect({ ...mascotBounds, x: layout.mascot.x, y: layout.mascot.y });
  const chatSrc = `?mode=workbench&child=1&view=buddy-chat&actions=${actions}${theme ? `&theme=${theme}` : ''}`;

  return (
    <div style={{
      position: 'relative', width: DESK.width, height: DESK.height, overflow: 'hidden',
      background: 'linear-gradient(150deg, #5b6b8c 0%, #8e7aa8 55%, #c99a8a 100%)',
    }}>
      <iframe
        title="Buddy chat"
        src={chatSrc}
        style={{ position: 'absolute', left: layout.chat.x, top: layout.chat.y, width: CHAT_SIZE.width, height: CHAT_SIZE.height, border: 0, background: 'transparent', colorScheme: 'normal' }}
      />
      {actions === 'beside' && (
        <div className="buddy-bar-root" data-visible="1" style={{
          position: 'absolute', left: bar.x, top: bar.y, width: bar.width, height: bar.height,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <BuddyBarButtons />
        </div>
      )}
      <div style={{ position: 'absolute', left: layout.mascot.x, top: layout.mascot.y, width: MASCOT_SIZE.width, height: MASCOT_SIZE.height }}>
        <MascotRig svgUrl={null} pose="idle" motionRef={motionRef} reducedEffects={false} />
      </div>
    </div>
  );
}
