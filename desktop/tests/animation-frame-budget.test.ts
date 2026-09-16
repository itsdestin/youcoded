import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard for the 2026-07-30 idle-CPU investigation's actual conclusion.
//
// On a high-refresh display, ANY smoothly-animating element makes Chromium
// produce and present a frame at the full refresh rate — measured ~1.5-1.9ms of
// CPU per frame (~29% of one core at 180Hz) for a single 64px pulsing dot. The
// cost is per-FRAME, not per-element, and not app-specific (bare Electron:
// 33.7%; plain Chrome: 26.7% for the identical div). Layer promotion via
// `will-change` was tried first, shipped briefly, and then MEASURED USELESS
// (29.8% -> 27.8%); an 8px layer-promoted transform animation still cost 31.9%.
//
// The only levers that work:
//   1. present fewer frames  -> steps() timing (28.75% -> 9.33% at steps(8))
//   2. present zero frames   -> finite iteration counts / Reduced Effects
//
// These are source-text assertions because the failure mode is cosmetic-looking:
// someone "smooths out" a stepped animation back to ease-in-out, or makes a
// finite animation infinite again. Nothing breaks visually — the app just
// quietly resumes burning ~30% of a core whenever that element is on screen.
//
// Investigation: youcoded-dev/docs/archive/investigations/2026-07-30-idle-cpu-burn.md
const RENDERER = join(__dirname, '..', 'src', 'renderer');
const read = (...p: string[]) =>
  // CRLF → LF: a Windows checkout (autocrlf) hands the pins below `\r\n`, and every
  // regex written with a literal `\n` failed there while passing on Linux and macOS
  // (youcoded#404 CI, 2026-09-03).
  readFileSync(join(RENDERER, ...p), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

describe('perpetual animations are frame-budgeted', () => {
  const globals = read('styles', 'globals.css');

  it('quantizes .animate-pulse with steps() timing', () => {
    expect(globals).toMatch(/\.animate-pulse\s*\{[^}]*animation-timing-function:\s*steps\(/);
  });

  it('quantizes .animate-spin with steps() timing', () => {
    expect(globals).toMatch(/\.animate-spin\s*\{[^}]*animation-timing-function:\s*steps\(/);
  });

  it('keeps .flowing-word finite — its background-position paint cannot be budgeted', () => {
    // Main-thread-painted property: steps() helps far less (still ~40% of a
    // core), so the fix is a finite iteration count. `infinite` here would
    // reintroduce a permanent ~44-66%-of-a-core cost per visible keyword.
    expect(globals).not.toMatch(/animation:\s*flowing-word-pan[^;]*infinite/);
    expect(globals).toMatch(/animation:\s*flowing-word-pan[^;]*\b\d+;/);
  });

  it('quantizes the SessionStrip breathing dot (inline animation)', () => {
    // Inline TSX animations are invisible to a CSS-file sweep — this dot runs
    // for every non-idle session in the always-visible header, making it the
    // app's most persistent animation.
    const src = readFileSync(join(RENDERER, 'components', 'SessionStrip.tsx'), 'utf8');
    expect(src).toMatch(/animation:\s*'breathe[^']*steps\(/);
    expect(src).not.toMatch(/animation:\s*'breathe[^']*ease/);
  });

  it('quantizes the HeaderBar challenge pulse (inline animation)', () => {
    const src = readFileSync(join(RENDERER, 'components', 'HeaderBar.tsx'), 'utf8');
    expect(src).toMatch(/animation:\s*'challenge-pulse[^']*steps\(/);
    expect(src).not.toMatch(/animation:\s*'challenge-pulse[^']*ease/);
  });

  // ── JS animation drivers ──
  // A requestAnimationFrame chain wakes at the display's refresh rate (180/sec
  // on a 180Hz panel). These three drivers do slow work (12.5fps spinner, 30fps
  // particles, ambient sway) and were each converted to interval-driven ticks —
  // rAF remains legitimate ONLY for genuinely full-rate work (MascotRig's
  // drag-trailing) and one-shot next-frame coalescing.

  it('BrailleSpinner is interval-driven, not a rAF chain', () => {
    const src = read('components', 'BrailleSpinner.tsx');
    expect(src).toMatch(/setInterval\(tick/);
    expect(src).not.toMatch(/requestAnimationFrame/);
  });

  it('ThemeEffects draws from an interval, not a rAF chain', () => {
    const src = read('components', 'ThemeEffects.tsx');
    expect(src).toMatch(/setInterval\(draw/);
    // The one-shot resize coalescer may keep rAF; the draw loop may not.
    expect(src).not.toMatch(/requestAnimationFrame\(draw/);
  });

  it('MascotRig runs rAF only for the drag chain, idle from an interval', () => {
    const src = read('components', 'mascot', 'MascotRig.tsx');
    expect(src).toMatch(/setInterval\(/);
    // Every rAF request must belong to the drag-gated chain (rafTick) — an
    // unconditional `requestAnimationFrame(tick)`-style self-chain regressing
    // here would resume 180 presented frames/sec of ambient sway forever.
    const rafCalls = [...src.matchAll(/requestAnimationFrame\(\s*(\w+)/g)].map((m) => m[1]);
    expect(rafCalls.length).toBeGreaterThan(0);
    expect(rafCalls.every((fn) => fn === 'rafTick')).toBe(true);
  });

  it('bans NEW inline infinite animations without steps timing in components', () => {
    // The two above were found only by a manual sweep; this keeps the class
    // closed. An inline `animation: '... infinite'` must carry steps() (or be
    // finite). Scoped to string literals in TSX — CSS files are covered by the
    // reduced-effects test and the assertions above.
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e: string) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
      });
    const offenders: string[] = [];
    for (const f of walk(join(RENDERER, 'components'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/animation:\s*'([^']*infinite[^']*)'/g)) {
        if (!/steps\(/.test(m[1])) offenders.push(`${f.split('/components/')[1]}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // ── Blind spots closed 2026-08-07 ──
  // The assertions below exist because a real violation
  // (`animate-[version-glow_2s_ease-in-out_infinite]`, StatusBar.tsx) sat
  // undetected in a suite written specifically to catch it. The inline-style
  // sweep above only matches `animation: '...'` string literals, so a Tailwind
  // arbitrary-value class is invisible to it, and CSS keyframes were asserted
  // three-by-name rather than swept.

  // Infinite animations that deliberately do NOT carry steps(), each with the
  // reason. An entry here is a decision, not an oversight — adding one should
  // take the same thought as quantizing the animation instead.
  const ANIMATION_EXCEPTIONS: Record<string, string> = {
    'rig-breathe': 'character motion — steps() reads as juddering; gated on visibilitychange instead (MascotRig)',
    'rig-bounce-loop': 'character motion — see rig-breathe',
    'rig-float-loop': 'character motion — see rig-breathe',
    'rig-sleep-loop': 'character motion — see rig-breathe',
    'rig-dizzy-sway': 'character motion — see rig-breathe',
    'comp-twinkle': 'theme companion SVG — visibility-gated with the scene',
    'comp-spin': 'theme companion SVG — 26s period, visibility-gated with the scene',
    'comp-pulse': 'theme companion SVG — visibility-gated with the scene',
    'comp-bob': 'theme companion SVG — visibility-gated with the scene',
    'mascot-comp-float': 'theme companion float — visibility-gated with the scene',
    'buddy-breathe': 'buddy window is alwaysOnTop so visibilitychange never fires, and quantizing breathing is visible; accepted cost of an opt-in feature',
    'model-load-sweep': 'bounded by the model load, and already disabled by Reduced Effects + prefers-reduced-motion',
  };

  it('bans Tailwind arbitrary-value infinite animations without steps()', () => {
    // `animate-[name_2s_ease-in-out_infinite]` never appears as an `animation:`
    // property in TSX, so the inline sweep above cannot see it.
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e: string) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
      });
    const offenders: string[] = [];
    for (const f of walk(join(RENDERER, 'components'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/animate-\[([^\]]*infinite[^\]]*)\]/g)) {
        const name = m[1].split('_')[0];
        if (!/steps\(/.test(m[1]) && !(name in ANIMATION_EXCEPTIONS)) {
          offenders.push(`${f.split('/components/')[1]}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sweeps every stylesheet for unbudgeted infinite animations', () => {
    // Replaces three-by-name spot checks with an actual sweep, so a NEW
    // infinite keyframe in any stylesheet has to be a deliberate decision.
    const sheets = ['globals.css', 'mascot.css', 'buddy.css'];
    const offenders: string[] = [];
    for (const sheet of sheets) {
      const css = read('styles', sheet);
      for (const m of css.matchAll(/animation:\s*([\w-]+)([^;]*infinite[^;]*);/g)) {
        const [, name, rest] = m;
        if (!/steps\(/.test(rest) && !(name in ANIMATION_EXCEPTIONS)) {
          offenders.push(`${sheet}: ${name}${rest}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('defines .stepped-hover and applies it to the dense hover surfaces', () => {
    // The transcript hover fix (steps(4) scoped to .timeline-entry) generalises
    // to any surface where many hover targets are swept by one pointer motion.
    // These are the app's dense lists; a one-off button is deliberately NOT in
    // scope — it animates once, and a smooth fade there is free.
    const globals = read('styles', 'globals.css');
    expect(globals).toMatch(/\.stepped-hover\s*\{[^}]*transition-timing-function:\s*steps\(/);
    expect(globals).toMatch(/\.hover-lift\s*\{[^}]*steps\(/);
    expect(globals).toMatch(/\.card-interactive\s*\{[^}]*steps\(/);

    const settingRow = readFileSync(join(RENDERER, 'components', 'ui', 'SettingRow.tsx'), 'utf8');
    expect(settingRow).toMatch(/ROW_BASE\s*=\s*'[^']*stepped-hover/);

    const strip = readFileSync(join(RENDERER, 'components', 'SessionStrip.tsx'), 'utf8');
    expect(strip).toMatch(/transition:\s*'opacity 150ms steps\(4\), background 150ms steps\(4\)'/);
  });

  it('transitions explicit properties on session pills, never `all`', () => {
    // `transition: all` animates every animatable property that changes,
    // layout properties included, and each one presents at the full refresh
    // rate. Only transform/border-color/background-color change on these pills.
    // Match the value, not `transition:` + value — the declaration is a
    // multi-line ternary, so an adjacency regex passes vacuously.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).not.toMatch(/'all \d+ms/);
  });

  it('sweeps the model-load bar with transform, not left', () => {
    // `left` is not compositable and forces a layout pass on every presented
    // frame — the most expensive per-frame shape in the app, running for the
    // whole duration of a local model load.
    const globals = read('styles', 'globals.css');
    const kf = globals.match(/@keyframes model-load-sweep\s*\{[^}]*\}[^}]*\}/);
    expect(kf, '@keyframes model-load-sweep not found').toBeTruthy();
    expect(kf![0]).toMatch(/translateX\(/);
    expect(kf![0]).not.toMatch(/\bleft:/);
  });

  it('pauses mascot motion when the document is hidden', () => {
    // The rig loops are character motion, so they are exempt from steps() in
    // ANIMATION_EXCEPTIONS above. That exemption is only honest if they stop
    // when nobody can see them. The interval must also reset its timestamp on
    // resume, or stepSpring integrates the entire hidden period as one dt and
    // the springs fling off-model on the first visible frame.
    const rig = read('components', 'mascot', 'MascotRig.tsx');
    expect(rig).toMatch(/visibilitychange/);
    expect(rig).toMatch(/last\s*=\s*performance\.now\(\)/);

    const mascotCss = read('styles', 'mascot.css');
    expect(mascotCss).toMatch(/data-doc-hidden[^{]*\{[^}]*animation-play-state:\s*paused/);
  });
});

// The motion vocabulary (2026-08-31 spec §3). These are source-text assertions
// for the same reason the rest of this file is: nothing breaks visually when a
// token drifts back to a hand-written curve, the app just quietly grows a sixth
// bespoke easing again.
describe('motion vocabulary', () => {
  const globals = read('styles', 'globals.css');

  it('defines three curves, none of which overshoots', () => {
    // The first cut put a spring curve on the pill; Destin's verdict was "much
    // too bouncy/aggressive". Every --ease-* control point sits inside [0, 1],
    // which is what "never overshoots" means for a cubic-bezier. (The switch
    // ARRIVAL may overshoot — it is on the transform of one element — and its
    // curve is deliberately not an --ease-* token: see @keyframes switch-arrival.)
    expect(globals).toMatch(/--ease-reveal:\s*cubic-bezier\(0\.25,\s*0\.1,\s*0\.25,\s*1\)/);
    expect(globals).toMatch(/--ease-out:\s*cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
    expect(globals).toMatch(/--ease-settle:/);
    expect(globals).not.toMatch(/--ease-bounce/);
    for (const m of globals.matchAll(/--ease-[a-z]+:\s*cubic-bezier\(([^)]+)\)/g)) {
      for (const n of m[1].split(',').map(Number)) expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('defines three durations — Soft (2026-09-02), with the Spring arrival\'s length', () => {
    expect(globals).toMatch(/--dur-hover:\s*180ms/);
    expect(globals).toMatch(/--dur-reveal:\s*260ms/);
    expect(globals).toMatch(/--dur-switch:\s*380ms/);
  });

  it('arms the label window from the stylesheet, not a number tuned to an older vocabulary', () => {
    // A fixed 360ms closed before Soft's reveal-then-badge had finished, and
    // the badge popped to full size — "jank". The badge is gone; the rule stays.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/motionWindowMs\(/);
    expect(strip).toMatch(/getPropertyValue\(name\)/);
    expect(strip).not.toMatch(/useOneShotWindow\([^)]*,\s*\d+\)/);   // no literal duration at a call site
  });

  it('never draws a dot touching the pill in hand — veiled by proximity, moved while hidden', () => {
    // Destin, 2026-09-02, after a slide and then a blink: "the dragged session
    // kept visibly overlapping dots before they appeared to begin to move. it
    // would be fine if they teleport or fade in/fade out as long as they dont
    // visually touch the dragged pill." Geometric, not timed.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/const VEIL_PX = 1;/);
    expect(strip).toMatch(/r\.right > t\.left - VEIL_PX && r\.left < t\.right \+ VEIL_PX/);
    // A dot's step-aside is a jump (it is hidden); a wide neighbour still slides.
    expect(strip).toMatch(/\(dragging \|\| settle !== null\) && isDot \? '0s' : 'var\(--dur-hover\) var\(--ease-out\)'/);
    // The flow's scale stays on the dots THROUGH the settle, and the flow runs
    // as a layout effect on every commit that moves a box (R9): a yield or a
    // drop must never paint a frame the rAF loop has not sized yet.
    expect(strip).toMatch(/settle !== null && isDot\n[\s\S]{0,600}\? 'scale\(var\(--flow, 1\)\)'/);
    expect(strip).toMatch(/useLayoutEffect\(\(\) => \{\n\s+if \(!flowActive\) return;[\s\S]{0,600}flow\(bar, t, heldId\);/);
    // And the dot FLOWS around the pill (2026-09-03): scaled per frame by the
    // rAF loop, with a ghost at its mirror spot across the pill — two images
    // whose sizes sum to one, on both sides of the yield, so the yield can
    // fire at the dot's centre (R7) and show nothing. No hole beside the pill.
    expect(strip).toMatch(/scale\(var\(--flow, 1\)\)/);
    expect(strip).toMatch(/ghost\.dataset\.ghost = /);
    expect(strip).toMatch(/const mirror = at\.origin === 'right center' \? left - \(t\.width \+ G\) : left \+ \(t\.width \+ G\);/);
    expect(strip).not.toMatch(/travel\.current\.dir;\n\s+const barL/);   // the flow is direction-blind
    expect(strip).toMatch(/ghost\.removeAttribute\('data-session-id'\)/);
    expect(strip).toMatch(/twin\.style\.left = /);   // the rAF loop, not React, positions the twin
    // Hidden at once, no fade out; the class beats the inline transition list.
    expect(globals).toMatch(/\.session-pill--veiled \{ opacity: 0 !important; transition-duration: 0s !important; \}/);
    expect(globals).not.toMatch(/pill-hop|data-yield/);
    const label = read('components/header', 'pill-label-style.ts');
    expect(label).toMatch(/max-width var\(--dur-reveal\) var\(--ease-reveal\)/);
  });

  it('puts them in the theme-independent :root block', () => {
    // They must NOT live in any `[data-theme=...]` palette block — a community
    // theme that redefines only colours would otherwise drop the app's motion.
    //
    // WHY sliced this way: an earlier draft of this test cut the file at
    // Tailwind's `@theme` and asserted the tokens were not above it. EVERY
    // palette block is above it, so that assertion was true no matter where
    // the tokens landed. Assert the real shape instead: present in a bare
    // `:root`, absent from every themed block.
    expect(globals).toMatch(/(^|\n):root \{[^}]*--ease-out/);
    for (const block of globals.split(/\[data-theme=/).slice(1)) {
      expect(block.slice(0, block.indexOf('}'))).not.toMatch(/--ease-out|--dur-hover/);
    }
  });

  it('keeps the rest of :root intact beside the tokens', () => {
    // 2026-09-01: the review presets had been pasted INSIDE :root, so
    // `[data-motion="crisp"]` swallowed --bottom-chrome-total and the drawer
    // width for every page that was not under review. The tokens and these
    // two app-wide variables must share one :root block.
    const root = globals.match(/(^|\n):root \{[^}]*\}/)?.[0] ?? '';
    expect(root).toMatch(/--dur-switch/);
    expect(root).toMatch(/--bottom-chrome-total:/);
    expect(root).toMatch(/--frame-edge:/);
  });

  it('has no review scaffolds left — every round was picked on 2026-09-02', () => {
    // The speed presets ([data-motion]), the select-on modes ([data-select]),
    // the arrival alternatives ([data-arrival], plus the `?arrival=` param in
    // index.tsx) and the yield scaffold ([data-yield]) were each picked and
    // deleted; the winners are the plain values. Spring is the arrival: 14px
    // lift on an overshooting curve.
    expect(globals).not.toMatch(/data-yield|--pill-yield/);
    expect(globals).not.toMatch(/data-motion|data-arrival|--switch-lift|--switch-ease/);
    expect(read('.', 'index.tsx')).not.toMatch(/arrival/);
    expect(globals).toMatch(/@keyframes switch-arrival \{[^}]*translateY\(14px\)/);
    expect(globals).toMatch(/\.switch-arrival \{\s*animation: switch-arrival var\(--dur-switch\) cubic-bezier\(0\.34, 1\.56, 0\.64, 1\) 1;/);
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).not.toMatch(/\[data-select\]|press-dot|readSelectOn/);   // data-select-portal is the Select menu's, unrelated
  });

  it('animates the incoming conversation, never the outgoing one', () => {
    const chat = read('components', 'ChatView.tsx');
    // The gate is sessionActive, not `visible` — `visible` also flips on Ctrl+`.
    // The trailing `&& sessionActive` is what makes it one-directional: the
    // window opens on the way out too, and this is what closes it. See the
    // hook's header.
    expect(chat).toMatch(/useOneShotWindow\(\s*sessionActive\s*\)\s*&&\s*sessionActive/);
  });

  it('defines the arrival animation with a finite iteration count', () => {
    // Perpetual animation is the thing this file exists to prevent. One run.
    expect(globals).toMatch(/\.switch-arrival\s*\{[^}]*animation:[^;]*switch-arrival/);
    expect(globals).not.toMatch(/\.switch-arrival\s*\{[^}]*infinite/);
    expect(globals).not.toMatch(/session-pill--veiled[^}]*animation/);
  });

  it('gates the arrival animation on reduced motion AND Reduce Visual Effects', () => {
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.switch-arrival[^}]*\}/);
    expect(globals).toMatch(/\[data-reduced-effects\] \.switch-arrival/);
    // The veil is a plain class, not an animation — nothing to gate.
  });

  it('draws the pill in hand as a TWIN of the real pill, never a ghost or an insertion line', () => {
    // Chrome's model: the pill itself moves and the neighbours step aside, so
    // the gap IS the indicator. The 2026-09-01 shape: the in-flow pill keeps
    // its slot invisibly (still animating its own width, so the row can
    // reshape on a select-on-press) and a twin — the SAME markup and styles —
    // floats at the cursor. The old ghost was a dimmed copy with its own
    // label/colour state and a separate insertion line.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).not.toMatch(/ghostTarget/);
    expect(strip).not.toMatch(/dragLabel|dragColor/);
    expect(strip).not.toMatch(/opacity-30 scale-95/);
    expect(strip).toMatch(/visibility: isBeingDragged \? 'hidden'/);
    expect(strip).toMatch(/\{pillBody\}[\s\S]*\{pillBody\}/);            // the same body, twice
    expect(strip).toMatch(/pointerEvents: 'none'/);
    // The twin carries no data attributes: everything that walks the row by
    // [data-session-id] must find exactly one node per session.
    const twinStart = strip.indexOf('isBeingDragged && dragLeft !== null && (');
    const twin = strip.slice(twinStart, strip.indexOf('{pillBody}', twinStart));
    expect(twin).not.toMatch(/data-session/);
  });

  it('keeps the pill in hand under the cursor, with no transition on its position', () => {
    // The review cut positioned the dragged pill by its SLOT with a 150ms ease
    // on transform: it hopped 26px per slot while the cursor travelled 130px,
    // and trailed the pointer like a rubber band. The twin follows the cursor
    // 1:1 (clamped to the row); the SLOT is decided by nearest-slot against
    // SYNTHETIC settled geometry, not the pill's drawn position.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/clampFloatLeft\(/);
    expect(strip).toMatch(/layoutRects\(/);
    expect(strip).toMatch(/nextSlotId\(/);
    expect(strip).toMatch(/neighbourOffsets\(/);
    expect(strip).not.toMatch(/draggedSlotOffset|nearestPillId|clampDragDx/);
    // The twin's transition list must not name its position.
    const twinStart = strip.indexOf('isBeingDragged && dragLeft !== null && (');
    const twin = strip.slice(twinStart, strip.indexOf('{pillBody}', twinStart));
    expect(twin).toMatch(/transition: 'box-shadow/);
    expect(twin).not.toMatch(/transition: '[^']*(left|transform)/);
  });

  it('keeps the hover peek open through pointer-down and the drag', () => {
    // Clearing hover on mouse-down collapsed the peek to a dot and the click
    // re-expanded it as the active pill: open → shut → open on every click of
    // a dot. And a peek collapsing mid-drag shrank the pill under the cursor
    // while its neighbours had already stepped aside for its peek width — the
    // ~150px void of 2026-09-01. Hover is released at the drop, not before.
    const strip = read('components', 'SessionStrip.tsx');
    const down = strip.slice(strip.indexOf('const handlePointerDown'), strip.indexOf('const handlePointerMove'));
    // The ONE clear on pointer-down is ANOTHER pill's peek (R10): the pressed
    // pill's own stays open. Guarded, so a press on the peeked pill itself
    // still never shuts it.
    expect(down.match(/setHoveredId\(null\)/g)?.length).toBe(1);
    expect(down).toMatch(/hoveredRef\.current !== sessionId\) \{[\s\S]{0,160}setHoveredId\(null\);/);
    const leave = strip.slice(strip.indexOf('const handleLeave'), strip.indexOf('const handleMenuToggle'));
    expect(leave).toMatch(/dragIdRef\.current !== null\) return/);
  });

  it('keys drag state by session id, never by index', () => {
    // See drag-order.ts's header for why. A single surviving `sessions[dragIdx]`
    // puts the two index spaces back in the same code.
    //
    // NOTE the attribute is checked as PRESENT, not as gone: `data-session-idx`
    // stays. It is read from outside the renderer by main.ts (torn-off window
    // placement, inside a string tsc cannot see) and by scripts/perf-lab, both
    // of which fail SILENTLY on a rename.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/data-session-id=\{s\.id\}/);
    expect(strip).toMatch(/data-session-idx=\{idx\}/);
    expect(strip).not.toMatch(/\bdragIdx\b/);
    expect(strip).not.toMatch(/\boverIdx\b/);
  });

  it('keeps the open name in hand while dragging', () => {
    // A round that collapsed the pill in hand to a dot was built and withdrawn
    // (Destin, 2026-09-02: "i want to keep the fully expanded name"). The
    // pill's settled width in the drag's geometry is its full width.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).not.toMatch(/if \(id === sessionId\) return COLLAPSED_PILL_PX;/);
    expect(strip).toMatch(/: displayPack\.expanded\.has\(s\.id\) \|\| isHovered \|\| isActive;/);
  });

  it('packs the row into the room it really has, so a drag is judged against the widths that get drawn', () => {
    // 2026-09-03: the packer was handed the wrapper's full width (the strip's
    // own padding included) and never knew about the "+N" chip, so a full row
    // was packed ~37px too wide; the active pill, the one flex item allowed to
    // shrink, rendered 25px narrower than the width the drag geometry froze,
    // and every dot moved 25px too far — snapping back on release.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/function stripBudget\(bar: HTMLElement\)/);
    expect(strip).toMatch(/parseFloat\(cs\.paddingLeft\)[^\n]*parseFloat\(cs\.paddingRight\)/);
    expect(strip).not.toMatch(/parentElement\?\.clientWidth \?\? bar(El)?\.clientWidth;/);   // only inside stripBudget
    // Both packs — the live repack and the press-time freeze — reserve the chip.
    expect(strip.match(/overflowChipWidth: OVERFLOW_CHIP_PX/g)?.length).toBe(2);
    // The held pill's settled width is capped at the room the packer HAD, never at a re-derived number.
    expect(strip).toMatch(/Math\.max\(COLLAPSED_PILL_PX, target\.pillBudget\)/);
  });

  it('tears a pill off only above or below the window — sideways stays in the row, as in Chrome', () => {
    // Destin, R6 (2026-09-03): "i still cant drag a session into the leftmost
    // position" — reaching for the first slot overshoots past the edge, which
    // read as "outside the window" and spawned a window instead of a drop.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/const outsideOwnWindow = e\.clientY < 0 \|\| e\.clientY > window\.innerHeight;/);
    expect(strip).toMatch(/const outsideOwnWindow = clientY < 0 \|\| clientY > window\.innerHeight;/);
    expect(strip).not.toMatch(/clientX < 0/);
    expect(strip).not.toMatch(/clientX > window\.innerWidth/);
  });

  it('puts nothing but the dot and the name on a pill — the runtime lives in the menu', () => {
    // Until 2026-09-02 a native pill carried a "YouCoded · Coder" badge that
    // opened after the name on every switch — a second motion to wait for, and
    // ~96px the strip had no room for. Destin: "eliminate the 'youcoded -
    // coder' tags in session names entirely. they still cause a bit of visual
    // jank." Runtime and model now sit under the name in the All Sessions
    // menu, with the brand mark the status bar's model chip uses.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).not.toMatch(/session-pill__badge|runtimeBadgeLabel|badgeArmed/);
    expect(globals).not.toMatch(/session-pill__badge|badge-in/);
    expect(strip).toMatch(/sessionRuntimeLabel\(s\)/);
    expect(strip).toMatch(/<ProviderIcon icon=\{rt\.icon\}/);
    // And the packer budgets exactly what the label box opens to.
    expect(strip).toMatch(/pillMetrics\(s\.name, measure, font\)/);
    expect(strip).toMatch(/expandedWidth: metrics\.get\(s\.id\)/);
  });

  it('lays the name out once and fades what does not fit', () => {
    // The label box clips; the name inside is max-content so it never
    // re-ellipsises mid-animation ("theme …", "theme cont…", "theme contra…").
    // The 12px tail is LABEL_TAIL_PX: the mask stop, the name's padding and the
    // module constant must agree or the fade lands on the last letter.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/className="session-pill__name"/);
    expect(strip).not.toMatch(/text-ellipsis \$\{isActive/);
    const label = read('components/header', 'pill-label-style.ts');
    const tail = Number(label.match(/LABEL_TAIL_PX = (\d+)/)?.[1]);
    expect(tail).toBeGreaterThan(0);
    expect(globals).toMatch(new RegExp(`\\.session-pill__label\\s*\\{[^}]*calc\\(100% - ${tail}px\\)`));
    expect(globals).toMatch(new RegExp(`\\.session-pill__name\\s*\\{[^}]*width: max-content;[^}]*padding-right: ${tail}px`));
  });

  it('leaves no hand-written curve in SessionStrip', () => {
    // Five distinct curves accumulated in the renderer, three of them the same
    // overshoot with drifted numbers (1.56 / 1.5 / 1.62), because each was
    // typed out by hand. Scoped to the one file that has been converted — the
    // rest of the app is a separate cleanup with its own before/after deck.
    //
    // This bans hand-written CURVES, not hand-written timing functions:
    // `steps()` is the frame budget and is required, and the assertions at the
    // top of this file pin the two `steps()` sites in this same file.
    expect(read('components', 'SessionStrip.tsx')).not.toMatch(/cubic-bezier\(/);
  });

  it('holds the drag visuals as STATE until the drop is committed — never the isDragging ref', () => {
    // 2026-09-03 (R10, fuzzed): pointerup flips the ref at once while the drop is
    // committed after an IPC round trip; the last pointermove's render landed in
    // between whenever the hand lifted while still moving (a touchpad, a finger),
    // unmounted the twin and snapped the pill to its origin — then the commit
    // jumped everything to the new order. "jumping around the switcher on release".
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/const \[dragActive, setDragActive\] = useState\(false\);/);
    expect(strip).toMatch(/const dragging = dragId !== null && dragActive && dragLeft !== null;/);
    expect(strip.match(/const isBeingDragged = dragId === s\.id && dragActive;/g)?.length).toBe(2);
    // The ref is read only inside handlers, never in render.
    const renderStart = strip.indexOf('const dragging = dragId !== null');
    expect(strip.slice(renderStart)).not.toMatch(/isDragging\.current/);
    // Cleared in the same render as the reorder — releaseVisuals — and by the live tear-off.
    expect(strip).toMatch(/const releaseVisuals = \(\) => \{[\s\S]{0,200}setDragActive\(false\);/);
  });

  it('never glides a dot at the drop — the flow owns its two images; yields judge the visible edge', () => {
    // Fuzzed 2026-09-03: a dot the pill was over at release was held at its old
    // rect at FULL size under the settling pill, then slid 128px (the FLIP is
    // for wide pills); and a twin still opening after a cold press had its
    // centre placed with the settled width, so dots yielded 60px early.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/for \(const \[id, wasLeft\] of armed\.lefts\) \{[\s\S]{0,600}if \(dotIdsRef\.current\.has\(id\)\) continue;/);
    expect(strip).toMatch(/const leadDrawn = floatLeft !== null\n\s+\? \(tv\.dir < 0 \? floatLeft : tv\.dir > 0 \? floatLeft \+ widthNow : floatLeft \+ widthNow \/ 2\)/);
    expect(strip).toMatch(/mapToSettled\(drawn, rects, leadDrawn\) \+ \(tv\.dir < 0 \? heldWidth \/ 2 : tv\.dir > 0 \? -heldWidth \/ 2 : 0\)/);
    // Only a dot-SIZED pill flows or is veiled: the old active pill is "collapsed"
    // in the pack the moment another is pressed, but still 190px wide and closing.
    expect(strip).toMatch(/if \(w > COLLAPSED_PILL_PX \+ 1\) \{ el\.style\.removeProperty\('--flow'\);/);
    expect(strip).toMatch(/const wide = el\.offsetWidth > COLLAPSED_PILL_PX \+ 1;/);
    // After a drop the peek lock lifts on leaving the strip or pressing — never by 8px of travel.
    expect(strip).not.toMatch(/hoverLock\.current\.x\) > 8/);
    // A finger never gets a peek (a tap leaves a sticky "hover" under it), and pressing
    // one pill closes another pill's peek before the drag geometry freezes.
    expect(strip).toMatch(/if \(lastPointerType\.current === 'touch'\) return;/);
    expect(strip).toMatch(/if \(hoveredRef\.current !== null && hoveredRef\.current !== sessionId\) \{[\s\S]{0,200}setHoveredId\(null\);/);
  });

  it('opens a hover peek only after the hand rests on the dot — never in passing', () => {
    // 2026-09-03 (R8): a hand that keeps moving after a drop drifted onto the
    // next dot; its peek opened, the row widened and re-centred, then closed
    // as the hand left — "jumping/glitching back and forth on release".
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/const PEEK_DWELL_MS = 150;/);
    expect(strip).toMatch(/enterTimer\.current = setTimeout\(\(\) => \{[\s\S]{0,200}setHoveredId\(id\);\n\s+\}, PEEK_DWELL_MS\);/);
    // An open peek still follows the cursor at once.
    expect(strip).toMatch(/if \(hoveredRef\.current !== null\) \{ setHoveredId\(id\); return; \}/);
    // Leaving the dot cancels a pending peek.
    expect(strip).toMatch(/const handleLeave = useCallback\(\(\) => \{[\s\S]{0,700}clearTimeout\(enterTimer\.current\)/);
  });

  it('attaches pill hover handlers unconditionally', () => {
    // Fix: attaching them only to non-pack-expanded pills means a pill the
    // packer collapses UNDER a stationary cursor never gets its mouseenter,
    // so it stays a dot until the user moves off and back on. Gate inside the
    // handler instead, where the current pack state is read at event time.
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).not.toMatch(/onMouseEnter=\{pack\.expanded\.has\(s\.id\)\s*\?\s*undefined/);
    expect(strip).not.toMatch(/onMouseLeave=\{pack\.expanded\.has\(s\.id\)\s*\?\s*undefined/);
  });

  it('routes the session pill label through pillLabelStyle', () => {
    const strip = read('components', 'SessionStrip.tsx');
    expect(strip).toMatch(/pillLabelStyle\(/);
    // The old inline style is gone — both halves of it.
    expect(strip).not.toMatch(/maxWidth:\s*showName/);
    expect(strip).not.toMatch(/'max-width 200ms ease, opacity 150ms ease'/);
  });
});

describe('the microphone budgets every frame it presents', () => {
  // Guard for whole-branch review F3. The mic is the app's only element that
  // animates for MINUTES at a time under the user's direct attention, so it is
  // the worst possible place to lose this. The comment in globals.css claimed
  // this file pinned it and this file said nothing about voice at all.
  const globals = read('styles', 'globals.css');
  const button = read('components', 'VoiceButton.tsx');

  it('steps the breathing ring rather than smoothing it', () => {
    expect(globals).toMatch(/\.voice-mic-on\s*\{[^}]*steps\(/);
  });

  it('steps the recording dot', () => {
    expect(globals).toMatch(/\.voice-rec-dot\s*\{[^}]*steps\(/);
  });

  it('steps the loudness bars, which move for the whole dictation', () => {
    // `linear` here is a frame every refresh for as long as the mic is open:
    // the height transition retriggers on every level event, ten a second.
    expect(globals).toMatch(/\.voice-bar\s*\{\s*transition:\s*height\s+\d+ms\s+steps\(/);
    expect(globals).not.toMatch(/\.voice-bar\s*\{\s*transition:[^}]*linear/);
  });

  it('steps the level ring — the motion that actually ships', () => {
    // The other two are round-2 alternatives reachable only from the workbench;
    // this inline transition is what every user sees.
    expect(button).toMatch(/transition:\s*'box-shadow\s+\d+ms\s+steps\(\d+\)'/);
    expect(button).not.toMatch(/transition:\s*'box-shadow[^']*linear'/);
  });

  it('keeps the ring on whole-pixel steps, so it repaints only when the level moves a step', () => {
    expect(button).toMatch(/\$\{2 \+ Math\.round\(level \* 7\)\}px/);
  });
});
