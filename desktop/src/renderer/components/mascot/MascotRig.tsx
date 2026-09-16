import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeRigSvg } from './sanitize-rig-svg';
import { DEFAULT_BUDDY_RIG } from './default-buddy-rig';
import {
  POSES, LIMB_IDS, BLINK_CFG, FACE_FALLBACK, IDLE_LOOP_CLASS, parsePivot, defaultPivot,
  stepSpring, isSettled, dragTargets, idleSway, waveSway,
  type PoseName, type FaceName, type SpringState, type RigPartId, type MotionStyle,
} from './mascot-poses';

export interface RigMotion { vx: number; vy: number; dragging: boolean; }

interface MascotRigProps {
  /** theme-asset:// URL of the theme's rig, or null → first-party default rig. */
  svgUrl: string | null;
  pose: PoseName;
  /** Mutable drag-velocity ref written by the drag handler (BuddyMascot).
   *  A ref, not state — pointermove-rate re-renders would defeat the point.
   *  Velocity must arrive normalized to the 80px window scale (k = 80/size × 2.4). */
  motionRef: React.MutableRefObject<RigMotion>;
  /** Disables blink + springs + idle loops (reduced-effects mode). Pose changes remain. */
  reducedEffects: boolean;
  /** Motion personality (spec §5). Selection UI is an open question — default 'chill'. */
  motionStyle?: MotionStyle;
  /** 0.5–2× multiplier on idle amplitude, sway, and twitches. */
  intensity?: number;
}

interface Parts {
  /** The svg element these parts were indexed from — identity check for
   *  lazy re-indexing (see ensureParts). */
  svg: SVGSVGElement;
  root: SVGGElement | null;
  byId: Map<RigPartId, SVGGElement>;
  // The six expression groups + blink, indexed by face name; absent groups
  // simply don't swap (graceful degradation per spec §3.2).
  faces: Partial<Record<FaceName | 'blink', SVGGElement>>;
  pupils: SVGGElement[];
}

// Parts the springs act on: the four limbs plus the tail, which trails
// off the left-leg target (Kuromi's tail wags when carried).
const SPRING_IDS = [...LIMB_IDS, 'rig-tail'] as const;
type SpringId = (typeof SPRING_IDS)[number];

const ALL_LOOP_CLASSES = ['rig-breathing', 'rig-bounce-loop', 'rig-float-loop', 'rig-sleep-loop', 'rig-fast-breath', 'rig-dizzy-sway'];

/**
 * Renders a rigged mascot SVG and animates it (spec §3 + §5).
 * - Fetches + sanitizes the theme rig (or uses the bundled default).
 * - UNIFIED SPRINGS (workbench-approved model): one spring per part whose
 *   target = pose base + (drag trail while dragging, else motion-style idle
 *   sway + welcome wave). Pose changes ride the physics instead of a CSS
 *   transition, so everything composes and settles with overshoot.
 * - Motion styles: idle body loop on #rig-root (CSS keyframes in mascot.css,
 *   amplitude via --amp = intensity), per-style blink cadence, hyper
 *   spring-velocity twitches.
 * - Curious-face pupils track the cursor.
 */
export function MascotRig({
  svgUrl, pose, motionRef, reducedEffects, motionStyle = 'chill', intensity = 1,
}: MascotRigProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  // WHY: React reassigns innerHTML when this object changes identity. Recreating
  // it on every blink/pose render destroys the animated SVG and restarts its CSS
  // motion; only a newly loaded rig should replace the spring-owned DOM.
  const svgMarkup = useMemo(() => svgHtml ? { __html: svgHtml } : undefined, [svgHtml]);
  const partsRef = useRef<Parts | null>(null);
  const springsRef = useRef<Map<SpringId, SpringState>>(new Map());
  // `<partId>:tx` / `<partId>:ty` — see the translation springs in the loop below.
  const transSpringsRef = useRef<Map<string, SpringState>>(new Map());
  const poseRef = useRef<PoseName>(pose);
  poseRef.current = pose;
  const styleRef = useRef<MotionStyle>(motionStyle);
  styleRef.current = motionStyle;
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;
  const [blinking, setBlinking] = useState(false);
  // Cursor-relative pupil offset (viewBox px), written by a window listener,
  // consumed by the rAF loop only while the curious face is showing.
  const pupilRef = useRef({ x: 0, y: 0 });

  // ── Load + sanitize ──
  useEffect(() => {
    let alive = true;
    if (!svgUrl) {
      setSvgHtml(sanitizeRigSvg(DEFAULT_BUDDY_RIG));
      return;
    }
    // theme-asset:// is registered with supportFetchAPI:true (main.ts), so
    // fetch works. Sanitization is the security boundary — see sanitize-rig-svg.
    fetch(svgUrl)
      .then((r) => r.text())
      .then((text) => { if (alive) setSvgHtml(sanitizeRigSvg(text) ?? sanitizeRigSvg(DEFAULT_BUDDY_RIG)); })
      .catch(() => { if (alive) setSvgHtml(sanitizeRigSvg(DEFAULT_BUDDY_RIG)); });
    return () => { alive = false; };
  }, [svgUrl]);

  // ── Lazy DOM indexing ──
  // Keyed on the ACTUAL svg element, not on effect timing: React can recreate
  // the host div with the same innerHTML (e.g., ThemeMascot re-parents the
  // mascot into MascotScene once the async theme delivers companions) WITHOUT
  // svgHtml changing — an effect keyed on [svgHtml] then never re-runs and
  // every pose/face/spring write lands on the detached old svg (2026-07-16
  // dev2 verification bug). ensureParts() re-indexes whenever the svg in the
  // DOM isn't the one we indexed, and callers run it before touching parts.
  const ensureParts = (): Parts | null => {
    const svg = hostRef.current?.querySelector('svg');
    if (!svg) { partsRef.current = null; return null; }
    if (partsRef.current?.svg === svg) return partsRef.current;
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const byId = new Map<RigPartId, SVGGElement>();
    const allIds: RigPartId[] = [...LIMB_IDS, 'rig-tail', 'rig-body'];
    for (const id of allIds) {
      const el = svg.querySelector<SVGGElement>(`#${id}`);
      if (!el) continue;
      byId.set(id, el);
      if (id === 'rig-body') {
        // BOTTOM-CENTRE on purpose: a body that settles or squashes must do it
        // downward, standing on the same spot. Scaling about the middle makes
        // him shrink into the air, which reads as flying away, not sitting.
        try {
          const b = el.getBBox();
          (el.style as unknown as Record<string, string>).transformBox = 'view-box';
          el.style.transformOrigin = `${b.x + b.width / 2}px ${b.y + b.height}px`;
        } catch { /* jsdom has no getBBox; the body simply stays put */ }
        continue;
      }
      const pivot = parsePivot(el.getAttribute('data-pivot'))
        ?? (() => { try { return defaultPivot(id, el.getBBox()); } catch { return null; } })();
      if (pivot) {
        // transform-box:view-box makes transform-origin viewBox-relative,
        // matching the data-pivot coordinate space.
        (el.style as unknown as Record<string, string>).transformBox = 'view-box';
        el.style.transformOrigin = `${pivot.x}px ${pivot.y}px`;
      }
    }
    const faces: Parts['faces'] = {};
    for (const name of ['idle', 'welcome', 'curious', 'shocked', 'dizzy', 'blink', 'happy', 'shutdown'] as const) {
      const el = svg.querySelector<SVGGElement>(`#rig-face-${name}`);
      if (el) faces[name] = el;
    }
    const root = svg.querySelector<SVGGElement>('#rig-root');
    // The idle body loops rotate/scale in viewBox coordinates.
    if (root) (root.style as unknown as Record<string, string>).transformBox = 'view-box';
    partsRef.current = {
      svg,
      root,
      byId,
      faces,
      pupils: Array.from(svg.querySelectorAll<SVGGElement>('.pupil')),
    };
    // SPRINGS SURVIVE A RE-INDEX (2026-09-05). They used to be thrown away here,
    // and because React can rebuild the host div with identical innerHTML —
    // which it does on a pose change — every spring was then recreated ALREADY
    // AT its new target. So no pose change ever animated: the limbs teleported
    // while the body eased under them, which is exactly what Destin saw ("the
    // animation to transition between states can be improved", 2026-09-05).
    // Measured on the sleep pane: the left arm's slide showed 2 distinct
    // positions across 313 samples at 16ms.
    //
    // A spring is physical state belonging to a PART ID, not to a DOM node, so
    // it is right for it to outlive the element. On a genuine rig swap the limbs
    // now spring from where the old rig's were rather than appearing pre-posed,
    // which is the better of the two reads.
    // Fresh DOM starts from the authored state — write the full current look.
    applyPose(partsRef.current, poseRef.current, blinking, true, {
      rot: springsRef.current, trans: transSpringsRef.current,
    });
    applyLimbVisibility(partsRef.current, poseRef.current);
    applyLoopClass(partsRef.current);
    return partsRef.current;
  };

  const applyLoopClass = (parts: Parts): void => {
    const { root } = parts;
    const host = hostRef.current;
    if (!root || !host) return;
    root.classList.remove(...ALL_LOOP_CLASSES);
    // --amp feeds the loop keyframes' amplitude (mascot.css).
    host.style.setProperty('--amp', String(intensityRef.current));
    if (reducedEffects) return;
    const p = poseRef.current;
    if (p === 'dizzy') { root.classList.add('rig-dizzy-sway'); return; }
    if (p.startsWith('peek')) return; // peeking bodies hold still — the grip carries the read
    root.classList.add(IDLE_LOOP_CLASS[styleRef.current]);
    if (styleRef.current === 'hyper') root.classList.add('rig-fast-breath');
  };

  // ── Index after the SVG lands in the DOM (ensureParts also self-heals
  //    from the rAF loop if the DOM is replaced between effect runs) ──
  useEffect(() => {
    ensureParts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgHtml]);

  // ── Face swap on pose/blink change (limb transforms are spring-owned) ──
  useEffect(() => {
    const parts = ensureParts();
    if (!parts) return;
    applyFace(parts, pose, blinking);
    applyLimbVisibility(parts, pose);
    // The body is never spring-driven, so unlike the limbs it has no other
    // writer — it has to be written here on EVERY pose change, not only in the
    // reduced-effects branch below.
    applyBody(parts, pose, false);
    // Reduced effects: springs don't run — write pose transforms directly.
    if (reducedEffects) applyPose(parts, pose, blinking, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pose, blinking, reducedEffects, svgHtml]);

  // ── Idle body loop class on rig-root (motion style + intensity) ──
  useEffect(() => {
    const parts = ensureParts();
    if (parts) applyLoopClass(parts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motionStyle, intensity, reducedEffects, pose, svgHtml]);

  // ── Blink loop (per-style cadence) ──
  useEffect(() => {
    if (reducedEffects) return;
    let closeTimer: NodeJS.Timeout | null = null;
    let openTimer: NodeJS.Timeout | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      // styleRef (not the prop) so a style switch mid-gap picks up the new
      // cadence on the next cycle without tearing the loop down.
      const [minGap, range, closedMs] = BLINK_CFG[styleRef.current];
      closeTimer = setTimeout(() => {
        // Skip blinks mid-drag and in eyes-wide states.
        const face = POSES[poseRef.current].face;
        if (!motionRef.current.dragging && face !== 'shocked' && face !== 'dizzy' && partsRef.current?.faces.blink) {
          setBlinking(true);
          openTimer = setTimeout(() => { setBlinking(false); schedule(); }, closedMs);
        } else {
          schedule();
        }
      }, minGap + Math.random() * range);
    };
    schedule();
    return () => {
      stopped = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (openTimer) clearTimeout(openTimer);
      setBlinking(false);
    };
  }, [reducedEffects, motionRef]);

  // ── Pupil targets (curious face follows the cursor) ──
  useEffect(() => {
    if (reducedEffects) return;
    const onMove = (e: PointerEvent) => {
      const host = hostRef.current;
      const parts = partsRef.current;
      if (!host || !parts || !parts.pupils.length) return;
      if (POSES[poseRef.current].face !== 'curious') return;
      const r = host.getBoundingClientRect();
      if (!r.width) return;
      const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / r.width));
      const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / r.height));
      pupilRef.current = { x: nx * 0.55, y: ny * 0.4 };
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [reducedEffects]);

  // ── Unified spring loop: pose base + drag trail + idle sway per part ──
  //
  // Perf: dual-rate driver (2026-07-30 idle-CPU investigation). This was an
  // unconditional requestAnimationFrame chain — and because every motion
  // style's idleSway is a continuous sinusoid, the springs never park, so it
  // woke AND wrote new limb transforms at the display's full refresh rate for
  // as long as a rig mascot was mounted. On a 180Hz panel that is 180 presented
  // frames/sec for ambient sway, at ~1.5-1.9ms of CPU each (~29% of one core).
  //
  // Now a 33ms interval drives idle motion (sway, twitches, wave, pupils —
  // 30fps is indistinguishable for slow ambient movement), and the rAF chain
  // runs ONLY while the user is dragging, where limb trailing tracks the
  // cursor and full refresh rate is genuinely the point. stepSpring integrates
  // real elapsed time (dt), so the handoff between cadences changes no physics.
  //
  // Freeze-safety: while the document is visible the interval never stops;
  // `rafActive` only decides who calls step(). Drag start is noticed on the
  // next interval tick (≤33ms — imperceptible for a grab); the rAF chain
  // retires itself the frame after `dragging` clears. If rAF is ever suspended
  // mid-drag, the interval resumes idle stepping as soon as `dragging` clears —
  // no wake source can be missed because the interval IS the wake source.
  //
  // The one case where the interval DOES stop is a hidden document (see the
  // startIdle/stopIdle pair below), and that is freeze-safe for the same
  // reason: a drag cannot be in flight while hidden — the pointer can't be
  // grabbing a window nobody is showing — so there is no in-progress gesture
  // to strand, and `visibilitychange` itself is the wake source that restarts
  // the interval (which then re-arms rAF if a drag has since begun).
  useEffect(() => {
    if (reducedEffects) return;
    const IDLE_TICK_MS = 33;
    let raf = 0;
    let rafActive = false;
    let last = performance.now();
    // Hyper twitch countdown — an impulse straight into a random spring's velocity.
    let twitchIn = 1200;
    // Force one write after a pose change even for parked springs — a pose can
    // change only tx/ty (side-peek arm parking) while the rotation target is
    // unchanged, and the parked-spring skip below would never write it.
    let lastPose: PoseName | null = null;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      // Self-healing: re-indexes (and restyles) if React replaced the svg DOM
      // since the last frame — see the ensureParts comment.
      const parts = ensureParts();
      if (!parts) return;
      const m = motionRef.current;
      const style = styleRef.current;
      const I = intensityRef.current;
      const poseName = poseRef.current;
      const poseChanged = lastPose !== poseName;
      lastPose = poseName;
      const def = POSES[poseName];
      const drag = m.dragging ? dragTargets(m.vx, m.vy) : null;
      const sway = m.dragging ? null : idleSway(now, style, I);
      if (style === 'hyper' && !m.dragging) {
        twitchIn -= dt;
        if (twitchIn <= 0) {
          const id = SPRING_IDS[Math.floor(Math.random() * SPRING_IDS.length)];
          const s = springsRef.current.get(id);
          if (s && parts.byId.has(id)) s.velocity += (60 + Math.random() * 140) * (Math.random() < 0.5 ? -1 : 1) * I;
          twitchIn = 700 + Math.random() * 1700;
        }
      }
      for (const id of SPRING_IDS) {
        const el = parts.byId.get(id);
        if (!el) continue;
        const pp = def.parts[id] ?? {};
        const base = pp.rotate ?? 0;
        let offs = 0;
        if (drag) {
          offs = id === 'rig-tail' ? drag['rig-leg-left'] * 0.8 : (drag[id as (typeof LIMB_IDS)[number]] ?? 0);
        } else {
          offs = sway?.[id] ?? 0;
          // The welcome wave rides the right arm's spring (±8° sinusoid) —
          // published rigs have no waveInner wrapper, so the physics does it.
          if (def.wave && id === 'rig-arm-right') offs += waveSway(now);
        }
        const target = base + offs;
        // Translation springs, one per axis, keyed off the same id. Reuses the
        // tuned physics rather than a second easing model, so a limb's shift and
        // its swing cannot disagree about how heavy this buddy is.
        let transMoving = false;
        for (const [axis, want] of [['tx', pp.tx ?? 0], ['ty', pp.ty ?? 0]] as const) {
          const key = `${id}:${axis}`;
          let ts = transSpringsRef.current.get(key);
          if (!ts) { ts = { value: want, velocity: 0 }; transSpringsRef.current.set(key, ts); }
          if (isSettled(ts, want)) { ts.value = want; ts.velocity = 0; continue; }
          const n = stepSpring(ts, want, dt);
          ts.value = n.value;
          ts.velocity = n.velocity;
          transMoving = true;
        }
        let s = springsRef.current.get(id);
        if (!s) { s = { value: base, velocity: 0 }; springsRef.current.set(id, s); }
        // Parked on a static target — and "parked" now has to mean the SLIDE as
        // well as the swing. Gating on the rotation alone computed the arm's
        // slide every tick and never wrote it, so a pose that only translates
        // (every sleep pose) teleported instead of moving (measured 2026-09-05:
        // two distinct positions across 145 samples).
        if (!poseChanged && !transMoving && s.value === target && isSettled(s, target)) continue;
        const next = stepSpring(s, target, dt);
        s.value = next.value;
        s.velocity = next.velocity;
        el.style.transition = 'none';
        const tx = transSpringsRef.current.get(`${id}:tx`)?.value ?? (pp.tx ?? 0);
        const ty = transSpringsRef.current.get(`${id}:ty`)?.value ?? (pp.ty ?? 0);
        el.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${s.value.toFixed(2)}deg)`;
      }
      // Velocity decay while a drag pauses mid-hold, so limbs relax.
      if (m.dragging) { m.vx *= 0.85; m.vy *= 0.85; }
      // Curious pupils follow the cursor.
      if (parts.pupils.length && def.face === 'curious') {
        const p = pupilRef.current;
        for (const el of parts.pupils) {
          (el.style as unknown as Record<string, string>).transformBox = 'view-box';
          el.style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px)`;
        }
      }
    };
    // Full-rate chain, alive only while dragging (see the driver comment above).
    const rafTick = (now: number) => {
      if (!motionRef.current.dragging) { rafActive = false; return; }
      raf = requestAnimationFrame(rafTick);
      step(now);
    };
    const idleTick = () => {
      if (motionRef.current.dragging) {
        if (!rafActive) { rafActive = true; raf = requestAnimationFrame(rafTick); }
        return; // rAF owns step() while dragging — don't double-step
      }
      step(performance.now());
    };
    // Pause idle motion while the document is hidden. The rig loops are
    // character motion, so they are deliberately exempt from steps()
    // quantization (juddery breathing is worse than the CPU) — which makes this
    // gate the thing that keeps that exemption honest. Without it, a minimized
    // window still presents ambient sway at the panel's full refresh rate
    // forever. visibilityState, not focus: it stays 'visible' on a secondary
    // monitor, where the user CAN still see the mascot. Matches the
    // ThemeEffects pattern (ThemeEffects.tsx:243).
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    const startIdle = () => {
      if (idleTimer !== null) return;
      // Reset the clock BEFORE the first tick. stepSpring integrates real
      // elapsed time, so resuming after a 10-minute hide would otherwise feed
      // it dt = 600000ms in one step and fling every spring off-model.
      last = performance.now();
      idleTimer = setInterval(idleTick, IDLE_TICK_MS);
      step(performance.now()); // first paint immediately, not 33ms late
    };
    const stopIdle = () => {
      if (idleTimer === null) return;
      clearInterval(idleTimer);
      idleTimer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') startIdle();
      else stopIdle();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') startIdle();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopIdle();
      cancelAnimationFrame(raf);
    };
  }, [reducedEffects, motionRef]);

  return (
    <div
      ref={hostRef}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
      // Sanitized upstream — sanitizeRigSvg is the security boundary.
      dangerouslySetInnerHTML={svgMarkup}
    />
  );
}

/**
 * The body's own transform.
 *
 * Separate from the spring loop by design: springs are the carried-soft-toy
 * limb wobble, and a body that overshoots on its way into a nap reads as a
 * flinch rather than a settle. A plain eased transition is the right motion —
 * and it is the ONLY thing that moves the body, which no pose could do before
 * 2026-09-04 (`applyPose` skipped `rig-body` by name).
 */
function applyBody(parts: Parts, pose: PoseName, instant: boolean): void {
  const def = POSES[pose];
  const el = parts.byId.get('rig-body');
  if (el) {
    const p = def.parts['rig-body'] ?? {};
    // Directional on purpose (Destin, 2026-09-05): falling asleep is a slow
    // heavy settle, waking is a quick one with a little overshoot at the end.
    // The same curve both ways is what made the change of state read as a jump
    // rather than as him doing something.
    const asleep = pose === 'sleep';
    el.style.transition = instant
      ? 'none'
      : asleep
        ? 'transform 620ms cubic-bezier(.32,.02,.28,1)'
        : 'transform 300ms cubic-bezier(.2,1.5,.4,1)';
    el.style.transform =
      `translate(${p.tx ?? 0}px, ${p.ty ?? 0}px) rotate(${p.rotate ?? 0}deg) scale(${p.scale ?? 1})`;
  }
}

/** Direct (non-spring) pose write — initial mount and reduced-effects mode. */
function applyPose(
  parts: Parts,
  pose: PoseName,
  blinking: boolean,
  instant: boolean,
  // WHERE THE LIMBS ACTUALLY ARE, when the springs are already holding them.
  // This write runs on every re-index, which React performs on a pose change —
  // so without it the limbs were slammed to the FINAL pose for one frame and
  // the springs then dragged them back to the start and animated up. A pop,
  // then the move (measured 2026-09-05: the arm's path began 0.5 → 5 → 1.25).
  live?: { rot: Map<SpringId, SpringState>; trans: Map<string, SpringState> },
): void {
  const def = POSES[pose];
  for (const [id, el] of parts.byId) {
    if (id === 'rig-body') continue;
    const p = def.parts[id] ?? {};
    const rot = live?.rot.get(id as SpringId)?.value ?? p.rotate ?? 0;
    const tx = live?.trans.get(`${id}:tx`)?.value ?? p.tx ?? 0;
    const ty = live?.trans.get(`${id}:ty`)?.value ?? p.ty ?? 0;
    el.style.transition = instant ? 'none' : 'transform 180ms ease-out';
    el.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
  }
  applyBody(parts, pose, instant);
  applyFace(parts, pose, blinking);
}

/** Show/hide whole limbs per the pose's `hidden` flags. Not spring-animated —
 *  visibility is a discrete pose property (side-peek hides the rig arms because
 *  the edge-pinned mittens stand in for the hands). Set on pose change only;
 *  the rAF spring loop writes transforms and never touches display. */
function applyLimbVisibility(parts: Parts, pose: PoseName): void {
  const def = POSES[pose];
  for (const id of LIMB_IDS) {
    const el = parts.byId.get(id);
    if (el) el.style.display = def.parts[id]?.hidden ? 'none' : '';
  }
}

function applyFace(parts: Parts, pose: PoseName, blinking: boolean): void {
  const def = POSES[pose];
  // Blink overlays whichever face is showing (except eyes-wide states).
  // A pose whose OWN face holds the eyes shut (sleep) needs nothing from the
  // momentary blink scheduler, and must not be fought by it.
  const asked: FaceName | 'blink' =
    blinking && parts.faces.blink && def.face !== 'shocked' && def.face !== 'dizzy' ? 'blink' : def.face;
  // RESOLVE AGAINST WHAT THE RIG ACTUALLY HAS. A rig drawn before `happy` and
  // `shutdown` existed has no group for them, and showing "the one that matches"
  // when nothing matches hides every face — a blank-faced buddy on somebody's
  // installed theme (see FACE_FALLBACK). Last resort is any face at all, because
  // a face that is not quite the right feeling beats no face.
  // NOT a type predicate: narrowing `asked` to `never` in the false branch is
  // what TS does with one, and then the fallback lookup below cannot be typed.
  const has = (n: FaceName | 'blink'): boolean => !!parts.faces[n];
  const want: FaceName | 'blink' | undefined = has(asked)
    ? asked
    : FACE_FALLBACK[asked].find(has) ?? (Object.keys(parts.faces)[0] as FaceName | 'blink' | undefined);
  for (const [name, el] of Object.entries(parts.faces)) {
    (el as SVGGElement).style.display = name === want ? '' : 'none';
  }
}
