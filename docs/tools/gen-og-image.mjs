#!/usr/bin/env node
// gen-og-image.mjs — rebuild docs/og-image.png from the LIVE PAGE.
//
// WHY THIS EXISTS: og-image.png is the picture every link preview shows —
// Slack, iMessage, Discord, Twitter, a Chrome tab hover card, the KDE taskbar's
// media tooltip. It shipped in 56c5e77c as a dark screenshot of the app with a
// "YouCoded Assistant / Agentic AI for Everyone" caption baked in, and the
// landing-page redesign then replaced the site around it. For a day the site was
// bright purple and every shared link showed a grey window from the previous
// design (reported by Destin 2026-09-04: "renders as a gray youcoded window
// instead of the site").
//
// The fix is the same rule the rest of docs/ already follows: the picture is a
// photograph of the real thing, not a drawing of it, so it cannot drift again
// without someone noticing the page itself changed. Re-run this whenever the
// hero changes.
//
// Usage (needs a static server on the docs/ directory):
//   cd docs && python3 -m http.server 8914 --bind 127.0.0.1 &
//   node docs/tools/gen-og-image.mjs http://127.0.0.1:8914/index.html
//
// It shells out to the workspace's ui-probe (own headless Chrome, own free
// debugging port) and ImageMagick, both of which the review rig already needs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:8914/index.html';
const OUT = resolve(process.argv[3] ?? 'docs/og-image.png');
const PROBE = process.env.UI_PROBE
  ?? resolve(process.cwd(), '../scripts/ui-probe.mjs');   // youcoded-dev/scripts

// Rendered at 1600 CSS px and downsampled to 1200, because 1600 is a normal
// desktop width — the layout in the card is then the layout a visitor gets —
// and the 0.75 downsample cleans up the type. 1600x840 is exactly the 1200x630
// aspect Open Graph wants, and it lands the crop just above the app window's
// chip row, so the window reads as continuing past the bottom edge.
const VIEW = '1600x1000';
const CROP = '1600x840+0+0';

// Everything that has to be TRUE before the shutter, as one expression: the
// demo window's still picture has loaded (otherwise the window is empty), and
// the intro has released the hero. Waiting on this instead of sleeping is what
// stops the capture from landing mid-intro with the headline half-swapped —
// which it did twice before this became a --wait.
// WHY the still and not the live demo (2026-11-13): the page no longer starts
// the demo on its own -- it waits for the visitor's pointer, because starting
// it froze the page (see the speed pass in index.html). The still is a
// photograph of the same app in the same look, so the card looks the same.
const READY = "(function(){var p=document.querySelector('.embed-poster');"
  + "return !!p && p.complete && p.naturalWidth > 0 && "
  + "!document.body.classList.contains('intro-mode');})()";

// Then pin the two things that are still moving at shutter time. cycler-static
// is the page's OWN reduced-motion path for the headline, so the card gets the
// resting word ("Yours.") rather than whichever of the three was passing
// through. The mascots get their resting pose for the same reason.
const FREEZE = "(function(){"
  + "document.body.classList.add('cycler-static');"
  + "document.body.classList.remove('intro-mode');"
  + "document.querySelectorAll('.mascot').forEach(function(c){"
  + "c.removeAttribute('data-run');c.setAttribute('data-face','welcome');});"
  + "var s=document.createElement('style');"
  + "s.textContent='.m-rig *{animation:none !important}';"
  + "document.head.appendChild(s);return 'frozen';})()";

const tmp = mkdtempSync(join(tmpdir(), 'og-'));
const raw = join(tmp, 'page.png');
try {
  execFileSync('node', [PROBE, URL_ARG, '--size', VIEW, '--wait', READY,
    '--settle', '2500', '--eval', FREEZE, '--settle', '600', '--shot', raw,
    '--fail-on-error'], { stdio: 'inherit' });
  execFileSync('magick', [raw, '-crop', CROP, '+repage',
    '-resize', '1200x630', '-strip', OUT], { stdio: 'inherit' });
  console.log('wrote ' + OUT);
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
