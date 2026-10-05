// Design options for the "motion-nav" task of the Home page redesign. Round 1's three options
// (picked: c, "Glide and grow") are in git at 30723d2e0; c is now built into the page itself
// (home-assistant-page-motion.ts). What stays here are two PRACTICE-ONLY review screens of the
// built page, so Destin can judge motion in one big pane (each becomes the practice screen
// pages/page/page-home#v-motion-nav-<key>). See types.ts.
import type { HomeVariants } from './types';

// WHY every card starts closed: there is more to open, and it differs from the plain connected
// screen, so the review pictures are not look-alikes.
const DATA = { startOpen: [] as string[] };

export const VARIANTS: HomeVariants = {
  // The built page with every movement at quarter speed, to see what it is doing.
  // WHY patch animate(): each motion starts through Element.animate, so slowing it there
  // slows all of them (delays included) without touching the page.
  slow: {
    label: 'Motion at quarter speed',
    data: DATA,
    js: String.raw`
(function () {
  var real = Element.prototype.animate;
  Element.prototype.animate = function () { var a = real.apply(this, arguments); a.playbackRate = 0.25; return a; };
})();`,
  },
  // The built page with its motion switched off (the page's own check), for comparison.
  before: {
    label: 'Without the new motion',
    data: DATA,
    sameAs: { name: 'pages/page/page-home#v-motion-nav-slow', why: 'the same page at rest; only its movement differs' },
    js: String.raw`window.__motionOff = true;`,
  },
};
