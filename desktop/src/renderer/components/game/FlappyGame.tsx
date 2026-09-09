// Flappy — the playfield (spec §5.1, §5.5, §7, §10).
//
// The rules live next door in `flappy-engine.ts` and are pure; this file is
// only pixels, keys and the mascot. THE MASCOT IS THE BIRD — that is the whole
// point of putting this game in the lineup: whatever character your theme
// ships is the thing flying through the pipes, and it flaps its own arms to do
// it, using the same rig the buddy uses everywhere else in the app.
//
// §7, DECIDED AND NON-NEGOTIABLE: nothing here watches the assistant. There is
// no pause when a turn ends, no dimming, no overlay, no subscription to session
// state of any kind. If you look away at the ready chime you will lose the run,
// and that is the intended behaviour — a game that pauses itself because
// something happened in another pane is a bigger surprise than a lost run.
//
// PERFORMANCE. One requestAnimationFrame loop, cancelled on unmount, and it
// does NOT re-render React. Every moving thing is repositioned by writing a
// `transform` straight onto its DOM node, exactly the way MascotRig drives its
// own spring loop. React state changes only when something a person would
// describe in words changes: the score ticked over, the run ended, the mascot
// changed pose. That is a handful of renders a run instead of sixty a second.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTheme } from '../../state/theme-context';
import { isTypingTarget } from '../../utils/is-typing-target';
import { isAndroid, isRemoteMode } from '../../platform';
import { MascotRig, type RigMotion } from '../mascot/MascotRig';
import { sanitizeRigSvg } from '../mascot/sanitize-rig-svg';
import { defaultMascotPaint } from '../mascot/default-mascot-paint';
import type { PoseName } from '../mascot/mascot-poses';
import { Button } from '../ui';
import type { SoloGameProps } from './game-registry';
import {
  createFlappyState, flap, step,
  FLAPPY_DEFAULTS, WORLD_W, WORLD_H, GROUND_H, BIRD_X, BIRD_DRAW_RADIUS,
  type FlappyState, type DeathCause,
} from './flappy-engine';
import RunOverCard from './RunOverCard';

const CFG = FLAPPY_DEFAULTS;
/** The playfield's shape. Fixed, because the engine's world is fixed — see the
 *  COORDINATES note in flappy-engine.ts. The box is letterboxed into whatever
 *  space the pane has, so the game plays identically at every pane width. */
const ASPECT = WORLD_W / WORLD_H;

/** How many pipe columns the DOM keeps around. The engine never holds more
 *  than five at once (the visible span plus one queued off each edge); the
 *  slots are reused rather than mounted and unmounted, so a pipe appearing
 *  costs a transform write and not a React render. */
const PIPE_SLOTS = 6;

/** Degrees of nose-up / nose-down per unit of vertical speed, and the limits.
 *  The mascot's rig has no whole-body rotation of its own (it renders into a
 *  100%×100% box), so the PITCH is applied to the element hosting the rig. */
const PITCH_GAIN = 0.16;
const PITCH_UP = -25;
const PITCH_DOWN = 60;

/** How long the wing-beat pose is held after a flap, ms. The `flap` pose is in
 *  the shared POSES table, so the arms' springs carry the beat — this only has
 *  to hold the pose long enough for the spring to reach it. */
const FLAP_POSE_MS = 150;

/** Stripe width of the ground texture, in world units. */
const GROUND_STRIPE = 9;

/* ── Colour (§5.5) ───────────────────────────────────────────────────────────
 *
 * No game ships a palette. Pipes and ground are theme surfaces mixed toward the
 * theme's accent, which is the same technique 2048's tile ramp uses and the
 * same one the chess board uses to separate its squares.
 *
 * WHY MIXED AND NOT A PLAIN SURFACE TOKEN: in the dark theme `--well` (the sky)
 * is #1C1C1C and `--inset` is #222222 — six points apart. A pipe painted in a
 * plain surface token is invisible against the sky in exactly the themes people
 * use most. The accent is guaranteed to stand off the surfaces (the theme
 * validator computes it that way), so mixing toward it buys separation in every
 * theme, including community packs nobody here has seen. */
const PIPE_FILL = 'color-mix(in srgb, var(--accent) 20%, var(--inset))';
const PIPE_CAP_FILL = 'color-mix(in srgb, var(--accent) 32%, var(--inset))';
const GROUND_FILL = 'color-mix(in srgb, var(--accent) 26%, var(--inset))';
const GROUND_STRIPE_FILL = 'color-mix(in srgb, var(--accent) 40%, var(--inset))';
/* ── The landscape ───────────────────────────────────────────────────────────
 *
 * TWO THINGS WERE WRONG BEFORE (Destin, both correct):
 *
 * 1. On the wallpaper themes the playfield was EMPTY. §5.1 says "where the
 *    theme ships a wallpaper, that is the sky", and I built it that way — but
 *    the games pane is an OPAQUE panel, so a wallpaper sitting behind the whole
 *    app can never show through it. The result was a blank field on exactly the
 *    themes with the best art (Meadow Mist has a mountain range four inches to
 *    the left of a completely empty playfield). So the sky is now ALWAYS
 *    painted. The spec sentence was wrong, not the implementation of it.
 *
 * 2. Blobs and diagonal streaks were not art. What reads instantly as a place
 *    is a HORIZON — so the sky is now a landscape: a sun, clouds, and three
 *    bands of rolling hills at three depths, each drifting slower than the one
 *    in front of it. Hills are what your eye reads as distance; the parallax
 *    just confirms it.
 *
 * Still no palette of its own (§5.5): every colour is the theme's accent mixed
 * into the theme's own surfaces, so this inherits any pack — including
 * community ones nobody here has seen — and cannot clash with one. */
const SKY_TOP = 'color-mix(in srgb, var(--accent) 3%, var(--well))';
const SKY_HORIZON = 'color-mix(in srgb, var(--accent) 14%, var(--well))';
const SKY_GRADIENT = `linear-gradient(to bottom, ${SKY_TOP} 0%, ${SKY_HORIZON} 100%)`;

/** The three hill bands, far to near. Each is darker and faster than the one
 *  behind it — the two together are what sell the distance. `tile` is how wide
 *  one repeat of the wave is; different tiles stop the three bands from
 *  marching in step, which is the thing that makes parallax look fake. */
const HILLS = [
  { fill: 'color-mix(in srgb, var(--accent) 10%, var(--well))', tile: 340, top: 46, amp: 13, speed: 0.10 },
  { fill: 'color-mix(in srgb, var(--accent) 17%, var(--well))', tile: 250, top: 58, amp: 11, speed: 0.20 },
  { fill: 'color-mix(in srgb, var(--accent) 25%, var(--well))', tile: 190, top: 70, amp: 8,  speed: 0.34 },
] as const;

const SUN_FILL = 'color-mix(in srgb, var(--accent) 13%, transparent)';
const CLOUD_FILL = 'color-mix(in srgb, var(--accent) 7%, transparent)';
const CLOUD_FILL_SOFT = 'color-mix(in srgb, var(--accent) 5%, transparent)';
/** One tile of cloud, repeated. Three puffs of different sizes at different
 *  heights — one centred blob tiles visibly and reads as a repeating pattern. */
const CLOUD_TILE_PX = 260;
const CLOUD_IMAGE = [
  `radial-gradient(34px 13px at 40px 20%, ${CLOUD_FILL} 0 60%, transparent 62%)`,
  `radial-gradient(22px 9px at 66px 17%, ${CLOUD_FILL} 0 60%, transparent 62%)`,
  `radial-gradient(44px 16px at 176px 34%, ${CLOUD_FILL_SOFT} 0 60%, transparent 62%)`,
  `radial-gradient(28px 11px at 206px 30%, ${CLOUD_FILL_SOFT} 0 60%, transparent 62%)`,
].join(', ');

/** Why the run ended, in words. Naming the cause is what turns a loss into
 *  feedback — "you hit the ceiling" and "you hit the ground" are different
 *  mistakes and the player should not have to have been watching to know which. */
function deathReason(cause: DeathCause | null): string {
  if (cause === 'ground') return 'You hit the ground';
  if (cause === 'ceiling') return 'You hit the ceiling';
  return 'You hit a pipe';
}

/** One band of rolling hills, drifting at its own speed.
 *
 *  WHY a path and not a repeating CSS gradient: a gradient can only make
 *  stripes and blobs, and stripes and blobs were the problem — they read as a
 *  pattern. A path can make a HORIZON, which is what the eye reads as a place.
 *
 *  The wave is one `Q` followed by a run of `T`s. Each `T` mirrors the previous
 *  control point, so the curve alternates crest/trough on its own and every
 *  half-tile lands at exactly the same height — which makes it seamless by
 *  construction rather than by a number someone tuned. The band is drawn one
 *  full tile wider than the field so it can slide a whole tile before wrapping.
 */
function HillBand({
  bandRef, fill, tile, top, amp, width,
}: {
  bandRef: React.RefObject<HTMLDivElement | null>;
  fill: string; tile: number; top: number; amp: number; width: number;
}) {
  const total = width + tile;
  const half = tile / 2;
  let d = `M 0 ${amp} Q ${tile / 4} 0, ${half} ${amp}`;
  for (let x = tile; x <= total + half; x += half) d += ` T ${x} ${amp}`;
  d += ` L ${total + half} 100 L 0 100 Z`;
  return (
    <div
      ref={bandRef}
      aria-hidden="true"
      className="absolute left-0 pointer-events-none"
      style={{ top: `${top}%`, bottom: 0, width: total + half }}
    >
      {/* preserveAspectRatio="none" so the band stretches to the pane's height
          at any size — the hills get taller with the window, not clipped. */}
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${total + half} 100`}
        preserveAspectRatio="none"
      >
        <path d={d} fill={fill} />
      </svg>
    </div>
  );
}

/** Static motion for the rig: the bird is never dragged, so the limb springs
 *  are driven only by the pose. Same shape `Icons.tsx` uses for non-buddy
 *  surfaces. */
const STATIC_MOTION: { current: RigMotion } = { current: { vx: 0, vy: 0, dragging: false } };

/**
 * Which mascot flies.
 *
 * THE GAP THIS CLOSES (§5.1): the theme authoring contract only guarantees
 * `rig-body`. A theme is allowed to ship a mascot that is a body and nothing
 * else — no arms — and a bird with no wings cannot flap. So before flying a
 * theme's rig we check it actually has the two arm parts, and if it does not we
 * hand `MascotRig` a null URL, which is its OWN existing signal for "use the
 * bundled default buddy" (the default rig has the full part set). That reuses
 * the fallback path BuddyMascot and ThemeMascot already rely on rather than
 * inventing a second one.
 *
 * It starts on the default and upgrades once the check passes, so the first
 * frame is never a wingless mascot that pops into a winged one.
 */
function useWingedRig(): string | null {
  const { activeTheme } = useTheme();
  // Rig rendering is Electron-desktop-only, the same gate ThemeMascot uses:
  // rigs are fetched over theme-asset://, which does not exist in the Android
  // WebView or the remote-browser shim.
  const themeRig = !isAndroid() && !isRemoteMode() ? activeTheme?.mascot?.rig ?? null : null;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!themeRig) { setUrl(null); return; }
    let alive = true;
    // The rig is re-fetched by MascotRig for the actual render; this second
    // read is off a theme-asset:// URL the browser has already cached, and
    // buys the wing check without changing MascotRig (which other sessions
    // own) or duplicating its rendering path.
    fetch(themeRig)
      .then((r) => r.text())
      .then((text) => { if (alive) setUrl(hasWings(text) ? themeRig : null); })
      .catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [themeRig]);

  return url;
}

/** True when a rig declares both arm parts. Runs the theme's SVG through the
 *  same sanitizer that guards every other inline-rig path before looking at
 *  it, and never puts it in the document — this only asks a question. */
function hasWings(svgText: string): boolean {
  const clean = sanitizeRigSvg(svgText);
  if (!clean) return false;
  // XMLSerializer always emits double quotes, so this is exact after sanitizing.
  return clean.includes('id="rig-arm-left"') && clean.includes('id="rig-arm-right"');
}

export default function FlappyGame({ onEnd, best, onExit }: SoloGameProps) {
  const { theme, activeTheme, reducedEffects } = useTheme();
  const rigUrl = useWingedRig();
  // Where the theme ships a wallpaper, THAT is the sky (§5.1) — the playfield
  // paints no background of its own and the theme's image shows through.

  // ── The simulation. A ref, not state: it changes sixty times a second and
  //    nothing about a re-render would make the picture more correct.
  const sim = useRef<FlappyState>(createFlappyState(newSeed()));

  // ── Things a person would notice, which therefore ARE React state.
  const [phase, setPhase] = useState<FlappyState['status']>('ready');
  const [score, setScore] = useState(0);
  const [pose, setPose] = useState<PoseName>('idle');
  const [focused, setFocused] = useState(false);

  // ── DOM handles the loop writes to directly.
  const areaRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const birdRef = useRef<HTMLDivElement>(null);
  const groundRef = useRef<HTMLDivElement>(null);
  const cloudRef = useRef<HTMLDivElement>(null);
  // One ref per hill band. Fixed length, created once — HILLS is a constant, so
  // this is not a conditional-hook hazard.
  const hillRefs = [
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
  ];
  const pipeRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Pixel size of the letterboxed playfield. State (so the box can be sized in
  // the markup) AND a ref (so the rAF loop can read the scale without the loop
  // being torn down and rebuilt on every resize).
  const [box, setBox] = useState({ w: 0, h: 0 });
  const scaleRef = useRef(0);
  const flapUntil = useRef(0);
  const reported = useRef(false);
  // Read inside the loop, so changing the setting never restarts the loop.
  const reducedRef = useRef(reducedEffects);
  reducedRef.current = reducedEffects;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  // ── Fit the world into whatever space the pane has ────────────────────────
  // The pane is user-resizable from 320px to 60% of the window (§4.3), so the
  // playfield is measured, never assumed. It takes the largest box of the
  // world's shape that fits — letterboxed rather than stretched, because a
  // stretched world would give a wide pane more warning before each pipe and
  // make the leaderboard a measure of window size.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.height, r.width / ASPECT));
      const w = h * ASPECT;
      scaleRef.current = h / WORLD_H;
      setBox((prev) => (Math.abs(prev.h - h) < 0.5 && Math.abs(prev.w - w) < 0.5 ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── The one animation loop ────────────────────────────────────────────────
  // Empty dependency list on purpose: everything it reads that can change lives
  // in a ref, so the loop is created once and cancelled once. A loop that is
  // torn down and rebuilt on each render drops frames at exactly the moments
  // the player is doing something.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - last;
      last = now;
      // The delta is clamped inside the engine (`maxStepMs`): a pane that was
      // hidden for a minute comes back with an enormous delta, and without the
      // clamp the bird would jump hundreds of units and pass straight THROUGH
      // a pipe rather than hitting it.
      const next = step(sim.current, dt, CFG);
      sim.current = next;
      paint(next);
      syncUi(next, now);
    };

    const paint = (s: FlappyState) => {
      const scale = scaleRef.current;
      if (!scale) return;
      const reduced = reducedRef.current;

      // Bird: position, and the pitch that sells rising versus falling.
      const bird = birdRef.current;
      if (bird) {
        const size = BIRD_DRAW_RADIUS * 2 * scale;
        const x = BIRD_X * scale - size / 2;
        const y = s.birdY * scale - size / 2;
        // Reduced effects: no continuous tilting. The bird's HEIGHT still tells
        // you everything you need to play; the rotation is flourish.
        const pitch = reduced ? 0 : clamp(s.birdV * PITCH_GAIN, PITCH_UP, PITCH_DOWN);
        bird.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${pitch.toFixed(1)}deg)`;
      }

      // Pipes: each slot is two full-height columns, shifted so the hole lands
      // where the engine says it does. Transform-only — no widths or heights
      // are written per frame, so no frame triggers a layout.
      const gapHalf = (CFG.pipeGap / 2) * scale;
      // The columns are a full playfield tall, so the half above the hole can
      // always be pushed clear off the top however high the hole sits.
      const colH = WORLD_H * scale;
      for (let i = 0; i < PIPE_SLOTS; i++) {
        const slot = pipeRefs.current[i];
        if (!slot) continue;
        const p = s.pipes[i];
        if (!p) { slot.style.visibility = 'hidden'; continue; }
        slot.style.visibility = 'visible';
        const x = p.x * scale;
        const gapY = p.gapY * scale;
        const top = slot.firstElementChild as HTMLElement | null;
        const bottom = slot.lastElementChild as HTMLElement | null;
        // The top column hangs from above with its BOTTOM edge at the hole's
        // top; the bottom column starts at the hole's bottom.
        if (top) top.style.transform = `translate(${x.toFixed(1)}px, ${(gapY - gapHalf - colH).toFixed(1)}px)`;
        if (bottom) bottom.style.transform = `translate(${x.toFixed(1)}px, ${(gapY + gapHalf).toFixed(1)}px)`;
      }

      // Ground + sky drift. REDUCED MOTION (§10): both stop dead. The pipes
      // keep coming — they are the game and cannot be stopped — but the
      // decorative scroll underneath and behind them does not run.
      const stripe = GROUND_STRIPE * scale;
      if (groundRef.current) {
        const off = reduced ? 0 : -((s.distance * scale) % stripe);
        groundRef.current.style.transform = `translateX(${off.toFixed(1)}px)`;
      }
      // Parallax. Each layer wraps on its OWN tile width, so every one of them
      // is seamless independently — the thing that makes distance read is that
      // the speeds differ, not that they share a rhythm.
      if (cloudRef.current) {
        const off = reduced ? 0 : -((s.distance * scale * 0.06) % CLOUD_TILE_PX);
        cloudRef.current.style.transform = `translateX(${off.toFixed(1)}px)`;
      }
      for (let i = 0; i < HILLS.length; i++) {
        const el = hillRefs[i]?.current;
        if (!el) continue;
        const h = HILLS[i]!;
        const off = reduced ? 0 : -((s.distance * scale * h.speed) % h.tile);
        el.style.transform = `translateX(${off.toFixed(1)}px)`;
      }
    };

    // React sees a change only when one has actually happened.
    const syncUi = (s: FlappyState, now: number) => {
      setPhase((p) => (p === s.status ? p : s.status));
      setScore((v) => (v === s.score ? v : s.score));
      const want: PoseName =
        s.status === 'dead'
          // The existing faces, not new art: wide-eyed on impact, then dizzy
          // once the body has come to rest (§5.1).
          ? (s.grounded ? 'dizzy' : 'shocked')
          : s.status === 'flying' && now < flapUntil.current
            ? 'flap'
            : 'idle';
      setPose((p) => (p === want ? p : want));
      if (s.status === 'dead' && !reported.current) {
        reported.current = true;
        // Starts the short window in which a key-retry is ignored, so the tap
        // already in the air when you hit the pipe cannot skip your own score.
        diedAt.current = now;
        // Exactly once per run, whatever else happens afterwards.
        onEndRef.current(s.score);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Input (§10) ───────────────────────────────────────────────────────────
  const doFlap = useCallback(() => {
    if (sim.current.status === 'dead') return;
    sim.current = flap(sim.current, CFG);
    flapUntil.current = performance.now() + FLAP_POSE_MS;
  }, []);

  // When the run ended. A key-retry is ignored for a moment after death so the
  // tap that was already in the air — you are mid-flap when you hit the pipe —
  // cannot skip straight past your own score. Clicking Play again has no such
  // guard: a click is deliberate in a way a held rhythm is not.
  const diedAt = useRef(0);
  const RETRY_LOCKOUT_MS = 450;

  const restart = useCallback(() => {
    reported.current = false;
    diedAt.current = 0;
    flapUntil.current = 0;
    sim.current = createFlappyState(newSeed());
    setScore(0);
    setPhase('ready');
    setPose('idle');
    fieldRef.current?.focus({ preventScroll: true });
  }, []);

  // KEY SCOPING. The handler is bound to the playfield, never to `window`, so
  // it cannot fire while the player is typing in the chat — with the field
  // unfocused this component listens to nothing at all. Space AND Enter both
  // flap, which is the single-non-pointer-input requirement in §10.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
    // Holding the key down must not machine-gun the bird into the ceiling —
    // one press is one flap, the same as every other game in this genre.
    if (e.repeat) { e.preventDefault(); return; }
    // Space would otherwise scroll the pane this playfield sits in.
    e.preventDefault();
    if (sim.current.status === 'dead') {
      if (performance.now() - diedAt.current >= RETRY_LOCKOUT_MS) restart();
      return;
    }
    doFlap();
  }, [doFlap, restart]);

  // Focus on open so the keyboard works without hunting for a click target —
  // but only if the player was not mid-sentence somewhere. `isTypingTarget` is
  // the app's single answer to "is a text field active?", and yielding to it is
  // what keeps this from being the focus trap §10 rules out. `preventScroll`
  // stops the pane jumping on mount.
  useEffect(() => {
    if (!isTypingTarget(document.activeElement)) fieldRef.current?.focus({ preventScroll: true });
  }, []);

  const scale = box.h / WORLD_H;
  const groundPx = GROUND_H * scale;
  const birdPx = BIRD_DRAW_RADIUS * 2 * scale;
  const pipePx = CFG.pipeWidth * scale;

  return (
    <div className="p-3 flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-end gap-4">
        <Stat label="Pipes" value={String(score)} />
        <Stat label="Best" value={best != null ? String(best) : '—'} />
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={restart}>New run</Button>
      </div>

      <div ref={areaRef} className="flex-1 min-h-0 flex items-center justify-center">
        <div
          ref={fieldRef}
          tabIndex={0}
          role="application"
          aria-label="Flappy. Press Space or Enter to flap."
          // Marker for the app's window-level key handlers, matching 2048's:
          // while this field holds focus, Space belongs to the game.
          data-game-keys="space"
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPointerDown={(e) => {
            e.preventDefault(); // keeps the click from stealing focus away again
            fieldRef.current?.focus({ preventScroll: true });
            if (sim.current.status === 'dead') return;
            doFlap();
          }}
          style={{ width: box.w || undefined, height: box.h || undefined }}
          className={[
            'relative overflow-hidden rounded-lg border outline-none select-none touch-none',
            // The deepest surface shade, so the field reads as a window cut
            // into the pane. The painted sky sits on top of it.
            'bg-well',
            // Focus is not decoration here — it is the difference between Space
            // flapping and Space scrolling, so it gets a real ring rather than
            // a focus-visible-only one (clicking would not trigger
            // focus-visible, leaving the player to guess).
            focused ? 'border-accent ring-2 ring-accent/40' : 'border-edge',
          ].join(' ')}
        >
          {/* Drifting sky streaks. Skipped entirely under a wallpaper (the
              theme's own image is the background and does not want stripes over
              it) and under reduced effects, where the transform is pinned at 0
              anyway. */}
          {/* THE SKY IS ALWAYS PAINTED. It used to be skipped under a
              wallpaper theme, on the reasoning that the theme's own background
              would show through — but the games pane is opaque, so it never
              could, and those themes got an empty field instead. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none"
            style={{ backgroundImage: SKY_GRADIENT }}
          />

          {/* The sun. Static and low-contrast: it places the light, it is not
              something to look at. */}
          <div
            aria-hidden="true"
            className="absolute rounded-full pointer-events-none"
            style={{
              right: '14%', top: '10%',
              width: Math.max(26, box.w * 0.13), height: Math.max(26, box.w * 0.13),
              background: `radial-gradient(circle, ${SUN_FILL} 0 58%, transparent 70%)`,
            }}
          />

          {/* Clouds, then three hill bands far-to-near. Each drifts slower than
              the one in front of it (see the rAF loop) — that difference is
              what reads as distance. Under reduced motion they all pin at 0 and
              simply become a still landscape, which is still a landscape. */}
          <div
            ref={cloudRef}
            aria-hidden="true"
            className="absolute inset-y-0 left-0 pointer-events-none"
            style={{
              width: `calc(100% + ${CLOUD_TILE_PX}px)`,
              backgroundImage: CLOUD_IMAGE,
              backgroundSize: `${CLOUD_TILE_PX}px 100%`,
              backgroundRepeat: 'repeat-x',
            }}
          />
          {HILLS.map((h, i) => (
            <HillBand
              key={h.top}
              bandRef={hillRefs[i]!}
              fill={h.fill}
              tile={h.tile}
              top={h.top}
              amp={h.amp}
              width={box.w}
            />
          ))}

          {/* Pipe pool. Mounted once and reused — see PIPE_SLOTS. */}
          {Array.from({ length: PIPE_SLOTS }, (_, i) => (
            <div
              key={i}
              ref={(el) => { pipeRefs.current[i] = el; }}
              aria-hidden="true"
              className="absolute inset-0 pointer-events-none"
              style={{ visibility: 'hidden' }}
            >
              <PipeColumn width={pipePx} height={box.h} cap="bottom" />
              <PipeColumn width={pipePx} height={box.h} cap="top" />
            </div>
          ))}

          {/* The bird. The rig renders into a 100%×100% box and exposes no
              whole-body rotation, so the PITCH lives on this host element —
              which is also where the theme tokens are mapped onto the rig's
              tint contract, the same three variables ThemeMascot sets. */}
          <div
            ref={birdRef}
            aria-hidden="true"
            className="absolute top-0 left-0 pointer-events-none"
            style={{
              width: birdPx || 0,
              height: birdPx || 0,
              willChange: 'transform',
              ['--rig-accent' as string]: 'var(--accent)',
              ['--rig-on-accent' as string]: 'var(--on-accent)',
              ['--rig-line' as string]: 'var(--fg)',
              // Default-only paint also covers an unusable community rig fallback.
              ...defaultMascotPaint(theme, true),
            }}
          >
            <MascotRig
              svgUrl={rigUrl}
              pose={pose}
              motionRef={STATIC_MOTION}
              reducedEffects={reducedEffects}
            />
          </div>

          {/* Ground. Its stripes scroll at exactly the world's speed because
              they are driven by the engine's own `distance`, so the ground can
              never slide out from under the pipes standing on it. */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 overflow-hidden border-t border-edge"
            style={{ height: groundPx || 0, background: GROUND_FILL }}
          >
            <div
              ref={groundRef}
              className="absolute inset-y-0 left-0"
              style={{
                width: `calc(100% + ${GROUND_STRIPE * scale}px)`,
                backgroundImage: `repeating-linear-gradient(90deg, transparent 0 ${(GROUND_STRIPE * scale) / 2}px, ${GROUND_STRIPE_FILL} ${(GROUND_STRIPE * scale) / 2}px ${GROUND_STRIPE * scale}px)`,
              }}
            />
          </div>

          {/* Before the first flap. Pointer-events-none so the whole field is
              still one big flap target underneath it. */}
          {phase === 'ready' && (
            // Sits BELOW the middle, not centred: the mascot waits at the
            // vertical centre of the field, and centring the prompt printed it
            // straight across the bird (seen in the Step 2 capture).
            <div className="absolute inset-x-0 bottom-[22%] flex flex-col items-center gap-1 pointer-events-none">
              <span className="text-sm font-semibold text-fg">Press Space to fly</span>
              <span className="text-2xs text-fg-muted">Nothing is moving until you do.</span>
            </div>
          )}

          {phase === 'dead' && (
            // Game state, not app state: this appears because you hit a pipe,
            // never because the assistant did something (§7). The card itself
            // is shared with every other solo game (G-1) — see RunOverCard.
            <RunOverCard
              reason={deathReason(sim.current.deathCause)}
              score={score === 1 ? '1 pipe' : `${score} pipes`}
              // A zero is never a "New best", and "Your best: 0 pipes" is not
              // a target — it is a slightly insulting way to say nothing. Below
              // one pipe the card simply shows the score and the retry.
              isBest={score > 0 && score > (best ?? 0)}
              best={best != null && best > 0 && score <= best
                ? (best === 1 ? '1 pipe' : `${best} pipes`)
                : undefined}
              onRetry={restart}
              onExit={onExit}
              retryKeyHint="Space"
            />
          )}
        </div>
      </div>

      {/* Says which input is live right now. Without it a player whose field has
          lost focus presses Space, the pane scrolls, and nothing explains why. */}
      <p className="text-2xs text-fg-muted leading-relaxed">
        {focused
          ? 'Space or Enter to flap. This one is a reflex game — it will not wait for you.'
          : 'Click the playfield (or Tab to it) to play with the keyboard.'}
      </p>

      {/* Screen-reader commentary. Polite, and only the two facts worth saying:
          the running total, and the end of the run. */}
      <span className="sr-only" role="status" aria-live="polite">
        {phase === 'dead' ? `Run over. ${score} pipes cleared.` : `${score} pipes cleared.`}
      </span>
    </div>
  );
}

/** One half of a pipe: a full-playfield-height column with a wider lip at the
 *  end that faces the hole. Both are sized once, in the markup — the loop only
 *  ever writes their `transform`. */
function PipeColumn({ width, height, cap }: { width: number; height: number; cap: 'top' | 'bottom' }) {
  return (
    <div
      className="absolute top-0 left-0"
      style={{ width: width || 0, height: height || 0, background: PIPE_FILL, willChange: 'transform' }}
    >
      <div
        className="absolute"
        style={{
          // The lip overhangs the column on both sides, which is what makes the
          // hole read as a hole rather than as a gap in a stripe.
          left: -width * 0.11,
          right: -width * 0.11,
          height: Math.max(3, width * 0.28),
          [cap === 'bottom' ? 'bottom' : 'top']: 0,
          background: PIPE_CAP_FILL,
          borderRadius: 2,
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-2xs uppercase tracking-wide text-fg-muted">{label}</span>
      <span className="text-sm font-semibold text-fg tabular-nums">{value}</span>
    </span>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A fresh, unpredictable run. The ENGINE never calls Math.random itself —
 *  every run is a seed plus a list of flaps, which is what makes it replayable
 *  in a test. Only the seed is random, and only here. */
function newSeed(): number {
  return (Math.random() * 0x7fffffff) | 0;
}
