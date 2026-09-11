// tooltip-adoption.test.ts — the three ways a `title=` swap goes wrong silently.
//
// Converting the app's browser-drawn hints to <Tooltip> is a mechanical sweep
// over ~230 sites, and every one of these was hit for real during it. None of
// them fails a typecheck, and only one of them fails an existing test.
//
// 1. `title` is not always a hint. `<Dialog title>`, `<AgentSection title>` and
//    `<SessionPreviewPane title>` all take it as DATA — a heading, or a string
//    the component threads down. Wrapping one moves a heading into a hover
//    bubble and deletes the real prop. Caught three times by hand.
//
// 2. A wrapper around a mapped element STEALS ITS KEY. `<Tooltip><div key={i}>`
//    leaves the array element with no key at all, and React quietly re-renders
//    the wrong rows.
//
// 3. Cloning REPLACES a handler the control already had. QuickChips' rows and
//    SessionDrawer's resize grip carry their own onPointerDown/Move/Up; the
//    primitive composes now, and `tooltip-primitive.test.tsx` pins that. This
//    file only makes sure the composition path stays covered as sites are added.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', 'src', 'renderer');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'workbench' ? [] : tsxFiles(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

/** Components whose `title` is content they render, never a hover hint. */
const TITLE_IS_DATA = ['Dialog', 'AgentSection', 'SessionPreviewPane', 'SettingRow', 'Callout', 'ErrorState', 'WizardHeader'];

/** Components that forward every unknown prop to a real DOM node, so wrapping
 *  one in a hint is the same as wrapping the element it renders. */
const FORWARDS = ['Button', 'CloseButton', 'IconBtn', 'IconButton', 'Toggle'];

type Site = { file: string; line: number; tag: string; head: string; wrapper: string };

function tooltipSites(): Site[] {
  const out: Site[] = [];
  for (const file of tsxFiles(ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<Tooltip\b[^>]*>/g)) {
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 900);
      const tag = after.match(/<([A-Za-z][A-Za-z0-9.]*)/);
      if (!tag) continue;
      const openTag = after.slice(tag.index!);
      const gt = openTag.indexOf('>');
      out.push({
        file: relative(ROOT, file),
        line: src.slice(0, m.index!).split('\n').length,
        tag: tag[1],
        head: gt > 0 ? openTag.slice(0, gt) : openTag.slice(0, 400),
        wrapper: m[0],
      });
    }
  }
  return out;
}

describe('the hint swap cannot break the control it describes', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard matching nothing PASSES and reads as clean.
    expect(tooltipSites().length).toBeGreaterThan(40);
  });

  it('never wraps a component whose `title` is a heading, not a hint', () => {
    const bad = tooltipSites()
      .filter((s) => TITLE_IS_DATA.includes(s.tag))
      .map((s) => `${s.file}:${s.line} wraps <${s.tag}>`);
    expect(
      bad,
      'These take `title` as content they render. Wrapping one hides a heading in a hover '
        + 'bubble and deletes the prop — it happened to <SessionPreviewPane>, <AgentSection> '
        + 'and <Dialog> during the 2026-09-10 sweep. Pass the title, do not wrap.',
    ).toEqual([]);
  });

  it('only wraps an element, or a component that forwards to one', () => {
    const bad = tooltipSites()
      .filter((s) => /^[A-Z]/.test(s.tag) && !FORWARDS.includes(s.tag))
      .map((s) => `${s.file}:${s.line} wraps <${s.tag}>`);
    expect(
      bad,
      'A hint clones its child and injects pointer handlers and a ref, so the child must '
        + 'reach a real DOM node. If this component does forward its props and a ref, add it '
        + 'to FORWARDS above — deliberately, having checked.',
    ).toEqual([]);
  });

  it('never leaves a list key on the wrapped child', () => {
    const bad = tooltipSites()
      .filter((s) => /\bkey=/.test(s.head) && !/\bkey=/.test(s.wrapper))
      .map((s) => `${s.file}:${s.line} <${s.tag}> keeps its key`);
    expect(
      bad,
      'The wrapper is the element in the array now, so the key belongs on <Tooltip>. Left on '
        + 'the child it names nothing, and React re-renders the wrong rows.',
    ).toEqual([]);
  });
});
