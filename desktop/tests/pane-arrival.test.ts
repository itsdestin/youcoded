// Destin, 2026-09-18: "add animations for opening the files/games panels so they
// feel less poppy ... all animations should be interruptible and smooth ... need
// to be aware of performance and how existing animations are structured".
//
// A stylesheet is not an ast-grep language here, so the shape of the pane's
// arrival is pinned as text. Every assertion below is a way this animation could
// be "improved" into a defect this repo has already shipped or measured.
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readSource } from './helpers/guard-scope';

const css = readSource(join(RENDERER, 'styles', 'motion.css')).replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const keyframes = css.slice(css.indexOf('@keyframes pane-arrival'), css.indexOf('.drawer-pane.pane-arriving {'));

describe('the Files / Games pane arrives without laying anything out', () => {
  it('animates opacity and clip-path ONLY — never a transform, never a width', () => {
    expect(keyframes).toContain('opacity');
    expect(keyframes).toContain('clip-path');
    // transform: a transform-animating parent of .layer-surface children inside an
    // overflow-hidden box is the paint bug shipped twice on Windows Electron.
    // width/margin/flex/left/right: animating the pane's box re-wraps the whole
    // transcript every frame.
    expect(keyframes).not.toMatch(/transform|translate|scale|width|margin|flex|left\s*:|right\s*:/);
  });

  it('runs once, on the motion tokens, and leaves nothing behind when it ends', () => {
    const at = css.indexOf('animation: pane-arrival');
    const decl = css.slice(at, css.indexOf(';', at));
    expect(decl).toContain('var(--dur-reveal)');
    expect(decl).toMatch(/var\(--ease-(out|reveal)\)/);
    expect(decl).toMatch(/\s1$/);                       // one iteration
    expect(decl).not.toMatch(/infinite|forwards|both|\d+ms|cubic-bezier/);
  });

  it('is keyed on a CLASS the view sets when the pane OPENS, never the bare pane', () => {
    // The pane element is re-created on every session switch and every
    // chat/terminal toggle. Keyed on `.drawer-pane` alone, an already-open panel
    // wiped in again each time.
    expect(css).toContain('.drawer-pane.pane-arriving { animation: pane-arrival');
    expect(css).not.toMatch(/(^|\n)\s*\.framed-shell > \.drawer-pane[^{]*\{[^}]*pane-arrival/);
  });

  it('answers to BOTH reduced-motion gates', () => {
    const media = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('animation: pane-arrival'));
    expect(media).toBeGreaterThan(-1);
    expect(css.slice(media, css.indexOf('\n}', media))).toContain('.drawer-pane.pane-arriving { animation: none; }');
    expect(css).toContain('[data-reduced-effects] .drawer-pane.pane-arriving { animation: none; }');
  });
});
