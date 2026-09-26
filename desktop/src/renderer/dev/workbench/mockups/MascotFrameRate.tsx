// src/renderer/dev/workbench/mockups/MascotFrameRate.tsx
//
// The REAL welcome-screen mascot, twice: once moving the way it did until
// 2026-09-26 (smooth CSS keyframes, drawn at the screen's full refresh rate —
// 180/s on Destin's panel) and once the way it does now (the same motion,
// computed in MascotRig's own 30/s update). Destin, 2026-09-26: "lets test at a
// lower framerate?" — motion is judged by watching it, side by side.
//
// Nothing is redrawn: both panes are `MascotRig` on the app's default rig. The
// "Until now" pane re-adds the old keyframe rule for itself only; a running CSS
// animation beats the inline transform MascotRig writes, so that pane shows the
// old motion exactly. Dev-only, like the rest of dev/.
import React, { useRef, useState } from 'react';
import { MascotRig, type RigMotion } from '../../../components/mascot/MascotRig';
import type { MotionStyle } from '../../../components/mascot/mascot-poses';

// Welcome-screen size (App.tsx: ThemeMascot "w-36 h-36").
const PX = 144;

// The old mascot.css rules, verbatim, scoped to this pane.
const OLD_LOOPS = `
@keyframes mfr-rig-breathe { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.6%); } }
@keyframes mfr-rig-bounce { 0%, 100% { transform: translateY(0) scale(1, 1); } 28% { transform: translateY(-3%) scale(0.985, 1.02); } 55% { transform: translateY(0) scale(1.015, 0.985); } 72% { transform: translateY(-0.9%) scale(1, 1); } }
@keyframes mfr-rig-float { 0%, 100% { transform: translateY(1.6%) rotate(-1.2deg); } 50% { transform: translateY(-2.8%) rotate(1.2deg); } }
[data-mfr='css'][data-style='chill'] svg #rig-root { animation: mfr-rig-breathe 4s ease-in-out infinite; transform-origin: 0 0 !important; }
[data-mfr='css'][data-style='bouncy'] svg #rig-root { animation: mfr-rig-bounce 1.15s ease-in-out infinite; transform-origin: 50% 85% !important; }
[data-mfr='css'][data-style='floaty'] svg #rig-root { animation: mfr-rig-float 5.8s ease-in-out infinite; transform-origin: 50% 60% !important; }
`;

const STYLES: Array<{ id: MotionStyle; label: string }> = [
  { id: 'chill', label: 'Breathe' },
  { id: 'bouncy', label: 'Bounce' },
  { id: 'floaty', label: 'Float' },
];

export function MascotFrameRateDemo({ driver }: { driver: 'css' | 'tick' }) {
  const motionRef = useRef<RigMotion>({ vx: 0, vy: 0, dragging: false });
  const [style, setStyle] = useState<MotionStyle>('chill');
  return (
    <div className="flex flex-col items-center gap-3" data-mfr={driver} data-style={style}>
      {driver === 'css' && <style>{OLD_LOOPS}</style>}
      <div style={{ width: PX, height: PX }}>
        <MascotRig svgUrl={null} pose="welcome" motionRef={motionRef} reducedEffects={false} motionStyle={style} />
      </div>
      <div className="flex gap-1">
        {STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`rounded-md border px-2 py-1 text-3xs ${style === s.id ? 'border-edge text-fg bg-inset' : 'border-edge-dim text-fg-muted hover:bg-inset'}`}
            onClick={() => setStyle(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
