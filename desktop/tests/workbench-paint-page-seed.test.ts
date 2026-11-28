// @vitest-environment jsdom
// workbench-paint-page-seed.test.ts — the workbench's paint-studio sample opens with a painted picture, at a size that follows the paper.
//
// WHY (card #175): the website's "paint" picture is shot from this sample. One run came out with the strokes counted ("34 strokes")
// but the canvas blank, because the paper took its real size after the first draw and nothing redrew. This runs the page's own script
// against a recording canvas: it must paint many strokes in several colours, redraw when the paper's size changes later, and draw the
// same thing for the same final size however it got there.
import { describe, it, expect } from 'vitest';
import { seedPages } from '../src/renderer/dev/workbench/fixtures/pages';

type Call = { fn: string; style: string; width: number; args: number[] };

function openPaint(paperWidth: () => number) {
  const html = seedPages().find((p) => p.id === 'page-paint')!.html as string;
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script>'));
  const calls: Call[] = [];
  let observer: (() => void) | null = null;
  // A canvas that records what is painted and forgets it when the canvas is resized (as a real one does).
  document.querySelectorAll('canvas').forEach((cv) => {
    let style = ''; let width = 0;
    const ctx: Record<string, unknown> = {
      save() {}, restore() {}, beginPath() {}, setTransform() {}, moveTo() {}, lineTo() {}, rect() {}, ellipse() {}, clearRect() { calls.length = 0; },
      stroke() { calls.push({ fn: 'stroke', style, width, args: [] }); },
    };
    Object.defineProperty(ctx, 'strokeStyle', { set: (v: string) => { style = v; }, get: () => style });
    Object.defineProperty(ctx, 'lineWidth', { set: (v: number) => { width = v; }, get: () => width });
    (cv as HTMLCanvasElement).getContext = (() => ctx) as never;
  });
  const paper = document.getElementById('paper')!;
  paper.getBoundingClientRect = () => ({ width: paperWidth(), height: paperWidth() * 0.64, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { constructor(cb: () => void) { observer = cb; } observe() {} disconnect() {} };
  new Function('window', 'document', script)(window, document);
  return { calls, paper, resizeNow: () => observer?.(), count: () => document.getElementById('count')!.textContent };
}

describe('the workbench paint-studio sample', () => {
  it('opens with a painted picture: many strokes in several colours', () => {
    const page = openPaint(() => 800);
    expect(Number(page.count())).toBeGreaterThan(20);
    expect(page.calls.length).toBe(Number(page.count()));
    expect(new Set(page.calls.map((c) => c.style)).size).toBeGreaterThanOrEqual(6);
  });

  it('is redrawn when the paper takes its real size after the first draw', () => {
    let w = 0; // not laid out yet: the first draw has nothing to paint at
    const page = openPaint(() => w);
    w = 900; page.resizeNow();
    expect(page.calls.length).toBe(Number(page.count()));
    expect(page.calls.length).toBeGreaterThan(20);
    // The seed is drawn for a 1100-wide paper: at 900 the first sky band (70 wide) must be scaled to 70 * 900/1100.
    expect(page.calls[0].width).toBeCloseTo(70 * 900 / 1100, 1);
  });

  it('draws the same picture for the same final size, whatever sizes it passed through', () => {
    let w = 500;
    const a = openPaint(() => w); w = 900; a.resizeNow();
    const b = openPaint(() => 900);
    expect(a.calls.map((c) => `${c.style}:${c.width.toFixed(2)}`)).toEqual(b.calls.map((c) => `${c.style}:${c.width.toFixed(2)}`));
  });
});
