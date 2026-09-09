import React from 'react';
import { MascotRig, type RigMotion } from '../../../components/mascot/MascotRig';
import type { PoseName } from '../../../components/mascot/mascot-poses';
import { ThemeMascot, WelcomeAppIcon } from '../../../components/Icons';
import FlappyGame from '../../../components/game/FlappyGame';
import { Button } from '../../../components/ui';
import { defaultMascotPaint } from '../../../components/mascot/default-mascot-paint';
import { useTheme } from '../../../state/theme-context';

const motion: { current: RigMotion } = { current: { vx: 0, vy: 0, dragging: false } };
const poses: PoseName[] = ['idle', 'curious', 'shocked', 'pressed', 'sleep'];

/** WHY dev-only: Q-1 approved a palette direction, not final paint. Keep the
 * candidate scoped to this workbench host, with no production or theme writes.
 * The three real consumers share one paint choice, not three approximations. */
export function FriendlyMascots({ after }: { after: boolean }) {
  const { theme } = useTheme();
  // WHY: the built route exercises production paint with NO candidate overrides.
  return <div data-friendly-mascots={after ? 'built' : 'before'} className="text-fg" style={{ width: 720, ...defaultMascotPaint(theme) }}>
    <style>{`
      [data-friendly-mascots] { --rig-accent: var(--accent); --rig-on-accent: var(--on-accent); }
      [data-theme="light"] [data-friendly-mascots] { --candidate-body: #DCE5E2; --candidate-face: #263832; --candidate-catch: #FFFFFF; }
      [data-theme="creme"] [data-friendly-mascots] { --candidate-body: #EAD7B4; --candidate-face: #3D2D23; --candidate-catch: #FFF4D0; }
      [data-friendly-mascots="after"] svg:has(#rig-root) {
        --rig-accent: var(--candidate-body, var(--accent));
        --rig-on-accent: var(--candidate-face, var(--on-accent));
      }
      [data-friendly-mascots="after"] .pupil circle { fill: var(--candidate-catch, var(--accent)); }
      [data-friendly-mascots="after"] [data-small-icon] svg { color: var(--candidate-body, var(--accent)); }
      [data-friendly-mascots="after"] [data-small-icon] circle { fill: var(--candidate-catch, var(--accent)); }
      /* WHY U1: face/body contrast alone does not preserve a tiny silhouette.
         A narrow dark rim separates the existing body and limbs from the sky. */
      [data-friendly-mascots="after"] [data-small-icon] svg > path,
      [data-friendly-mascots="after"] [data-small-icon] svg > rect,
      [data-friendly-mascots="after"] [data-small-icon] svg > g > path,
      [data-friendly-mascots="after"] [role="application"] #rig-body > path:first-child,
      [data-friendly-mascots="after"] [role="application"] [id^="rig-arm-"] > path:first-child,
      [data-friendly-mascots="after"] [role="application"] [id^="rig-leg-"] > rect:first-child {
        stroke: var(--candidate-face); stroke-width: 0.85; paint-order: stroke fill;
      }
    `}</style>
    <div className="flex items-center justify-between mb-4">
      <div><h2 className="text-base font-medium">Default buddy</h2><p className="text-xs text-fg-muted">Same shape and expressions · palette study</p></div>
      <Button variant="primary" size="sm">New conversation</Button>
    </div>
    <div className="flex gap-4">
      <section className="flex-1 rounded-lg border border-edge bg-panel p-4">
        <h3 className="text-xs font-medium">Floating buddy · 112 px</h3>
        <div className="flex items-center justify-center bg-well rounded-md my-3" style={{ height: 148 }}>
          <div style={{ width: 112, height: 112 }}><MascotRig svgUrl={null} pose="idle" motionRef={motion} reducedEffects /></div>
        </div>
        <div data-small-icon className="flex items-center gap-3 text-accent">
          <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-6 h-6" />
          <span className="text-xs text-fg">In-app mascot · 24 px</span>
        </div>
      </section>
      <section className="rounded-lg border border-edge bg-panel p-4" style={{ width: 300 }}>
        <h3 className="text-xs font-medium mb-2">Flappy · actual game</h3>
        <div className="flex flex-col" style={{ height: 420 }}><FlappyGame best={0} onEnd={() => {}} onExit={() => {}} /></div>
      </section>
    </div>
    <section className="mt-4 rounded-lg border border-edge bg-panel p-4">
      <h3 className="text-xs font-medium">Expressions · 112 px each</h3>
      <div className="flex justify-between">{poses.map(pose => <div key={pose} className="text-center">
        <div style={{ width: 112, height: 112 }}><MascotRig svgUrl={null} pose={pose} motionRef={motion} reducedEffects /></div>
        <p className="text-xs text-fg-muted">{pose === 'pressed' ? 'Pressed' : pose === 'idle' ? 'Awake' : pose === 'curious' ? 'Curious' : pose === 'shocked' ? 'Surprised' : 'Asleep'}</p>
      </div>)}</div>
    </section>
  </div>;
}
