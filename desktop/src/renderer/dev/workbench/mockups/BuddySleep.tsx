// src/renderer/dev/workbench/mockups/BuddySleep.tsx
//
// The REAL buddy, at his real size, actually falling asleep — so the pose can
// be judged by watching it happen rather than by looking at a drawing of the
// end of it. Destin, 2026-08-31: "the videos are just rough to compare."
//
// Nothing here is redrawn. The mascot is `MascotRig` itself on the app's own
// default rig, driven by poses out of the shared `POSES` table, and the
// sleeping breath is the app's own `sleepy` motion style (`rig-sleep-loop`,
// 6.5s). What IS new is only the arrangement: a plate the size of the buddy's
// real window, a timer that puts him under and wakes him again, and a button so
// the wake can be triggered on demand instead of waited for.
//
// WHY the wake matters as much as the pose (2026-09-04): a sleep pose is judged
// on three things, and only one of them is visible in a still — how he settles,
// what he looks like down there, and whether coming back reads as "he noticed"
// or as "he glitched". The pane loops so all three are seen.
//
// Dev-only, like the rest of dev/.
import React, { useEffect, useRef, useState } from 'react';
import { MascotRig, type RigMotion } from '../../../components/mascot/MascotRig';
import type { PoseName } from '../../../components/mascot/mascot-poses';

// His real window is 112px (main.ts buddyDimensions). Judged at that size and
// no larger — a sleep pose that only reads when you zoom in has failed.
const BUDDY_PX = 112;
const AWAKE_MS = 3200;
const ASLEEP_MS = 6800;

export function BuddySleepDemo({ pose }: { pose: PoseName }) {
  const [asleep, setAsleep] = useState(false);
  const motionRef = useRef<RigMotion>({ vx: 0, vy: 0, dragging: false });
  // Bumped by "Wake him" so the cycle restarts from awake instead of the timer
  // firing him straight back under a moment later.
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setAsleep((s) => !s), asleep ? ASLEEP_MS : AWAKE_MS);
    return () => clearTimeout(t);
  }, [asleep, cycle]);

  return (
    <div className="flex flex-col items-center gap-3" style={{ width: BUDDY_PX + 26 }}>
      {/* A stand-in for the corner of a desktop: the buddy has no window of his
          own to sit in here, and judging him on a flat panel colour would flatter
          a dim candidate unfairly. */}
      <div
        className="relative flex items-end justify-center rounded-xl border border-edge-dim"
        style={{
          width: BUDDY_PX + 26,
          height: BUDDY_PX + 32,
          background: 'linear-gradient(160deg, var(--bg-well) 0%, var(--bg-inset) 100%)',
        }}
      >
        <div style={{ width: BUDDY_PX, height: BUDDY_PX, marginBottom: 8 }}>
          <MascotRig
            svgUrl={null}
            pose={asleep ? pose : 'idle'}
            motionRef={motionRef}
            reducedEffects={false}
            // The app's OWN sleepy loop while he is under — a 6.5s breath
            // against the 4s one he uses awake. Not a new animation.
            motionStyle={asleep ? 'sleepy' : 'chill'}
          />
        </div>
      </div>
      <div className="flex flex-col items-center gap-1 text-3xs text-fg-muted">
        <button
          type="button"
          className="rounded-md border border-edge-dim px-2 py-1 text-3xs text-fg-2 hover:bg-inset"
          onClick={() => { setAsleep(false); setCycle((c) => c + 1); }}
        >
          Wake him
        </button>
        <span>{asleep ? 'asleep' : 'awake'}</span>
      </div>
    </div>
  );
}
