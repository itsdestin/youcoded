import { describe, it, expect } from 'vitest';
import { visitParents } from 'unist-util-visit-parents';
import type { Root, Element, Text, RootContent } from 'hast';
import { rehypeLinkTokens } from './rehype-link-tokens';
import { detectLinkTokens } from './markdown-linkify';

// The pre-fix implementation (indexOf + splice per text node), kept verbatim as the reference.
function oldPass(tree: Root, filepaths: boolean) {
  visitParents(tree, 'text', (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return;
    const index = (parent as Element | Root).children.indexOf(node as Text);
    if (index === -1) return;
    if (ancestors.some((a) => a.type === 'element' && (a as Element).tagName === 'a')) return;
    const inPreBlock = ancestors.some((a) => a.type === 'element' && (a as Element).tagName === 'pre');
    const textNode = node as Text;
    const matches = detectLinkTokens(textNode.value, { filepaths });
    if (matches.length === 0) return;
    const replacements: RootContent[] = [];
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) replacements.push({ type: 'text', value: textNode.value.slice(cursor, m.start) });
      const child: Text = { type: 'text', value: m.text };
      replacements.push(m.kind === 'url'
        ? ({ type: 'element', tagName: 'a', properties: { href: m.value }, children: [child] } as Element)
        : ({ type: 'element', tagName: 'filepath-token', properties: { 'data-path': m.value, 'data-raw': m.text, ...(inPreBlock ? { 'data-in-code': 'true' } : {}) }, children: [child] } as Element));
      cursor = m.end;
    }
    if (cursor < textNode.value.length) replacements.push({ type: 'text', value: textNode.value.slice(cursor) });
    (parent as Element | Root).children.splice(index, 1, ...replacements);
    return index + replacements.length;
  });
}

const run = (tree: Root, filepaths: boolean) => (rehypeLinkTokens as any)({ filepaths })(tree);
const t = (value: string): Text => ({ type: 'text', value });
const el = (tagName: string, children: RootContent[]): Element => ({ type: 'element', tagName, properties: {}, children });

// Small seeded PRNG so a failure reproduces.
function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const PIECES = ['plain ', 'see https://example.com/a?b=1 ', '/home/u/proj/file.ts ', 'src/a/b.tsx:12 ', 'x = 1;\n', 'C:\\Users\\a\\b.txt ', '(https://x.io)', ' ~/notes/todo.md '];
function randomTree(rand: () => number, depth = 0): RootContent[] {
  const n = 1 + Math.floor(rand() * 6);
  const out: RootContent[] = [];
  for (let i = 0; i < n; i++) {
    if (depth < 3 && rand() < 0.4) {
      const tag = ['span', 'a', 'pre', 'code', 'p'][Math.floor(rand() * 5)];
      out.push(el(tag, randomTree(rand, depth + 1)));
    } else {
      let s = ''; const k = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < k; j++) s += PIECES[Math.floor(rand() * PIECES.length)];
      out.push(t(s));
    }
  }
  return out;
}

describe('rehypeLinkTokens', () => {
  it('matches the old indexOf/splice pass exactly on 300 random trees', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const filepaths of [false, true]) {
        const a: Root = { type: 'root', children: randomTree(rng(seed)) };
        const b: Root = JSON.parse(JSON.stringify(a));
        oldPass(a, filepaths);
        run(b, filepaths);
        expect(JSON.parse(JSON.stringify(b)), `seed ${seed} filepaths ${filepaths}`).toEqual(JSON.parse(JSON.stringify(a)));
      }
    }
  });

  it('reads each child of a huge highlighted block a bounded number of times (linear, not quadratic)', () => {
    // A highlight.js code block: one <code> with ~10 direct children per line, half of them text.
    const reads = (lines: number) => {
      const kids: RootContent[] = [];
      for (let i = 0; i < lines; i++) {
        kids.push(el('span', [t('const')]), t(' x = '), el('span', [t('1')]), t(`; // https://example.com/${i}\n`));
      }
      let count = 0;
      const counted = new Proxy(kids, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) count++;
          return Reflect.get(target, key, receiver);
        },
      });
      const code = el('code', []);
      code.children = counted as RootContent[];
      const tree: Root = { type: 'root', children: [el('pre', [code])] };
      run(tree, true);
      return { count, total: kids.length };
    };
    const small = reads(500);
    const big = reads(2000);
    // Old pass: indexOf scans ~N/2 children per text node, so reads grow ~N^2 (about 16x for 4x lines).
    expect(big.count).toBeLessThanOrEqual(big.total * 4);
    expect(big.count / small.count).toBeLessThan(6);
  });
});
