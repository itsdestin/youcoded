import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

// EVERY SCROLL AREA FADES, WITH THE APP'S ONE FADE.
//
// Destin, 2026-10-15: "scrollable areas should always have a scroll-fade applied that matches
// the fade used elsewhere in the app." The design guide (Popups and side panels) says the same:
// never a hand-made gradient, never a scroll area with no fade. The one fade is `.scroll-mask`
// (styles/scroll-mask.css) — CSS-only, so adding it costs a box nothing.
//
// WHAT THIS CHECKS, over every renderer .tsx file the app ships (tests and the workbench's own
// dev/ pages excluded):
//   1. An element whose className carries a scroll class (overflow-auto, overflow-y-auto,
//      overflow-x-auto, overflow-scroll … with any `sm:`/`max-sm:` prefix) or whose style says
//      overflow/overflowX/overflowY 'auto'|'scroll' (inline, or a const it names) must also carry
//      `scroll-mask` (or its one-direction twins `scroll-mask-x` / `scroll-mask-y`) in its
//      className — or be listed in EXCEPTIONS below with its reason.
//   2. A scroll class written OUTSIDE an element's className (a class-string constant) must sit
//      in the same string as `scroll-mask`, so whoever uses the constant gets both.
//   3. The retired painted band (`.scroll-fade` / `.scroll-fade-x`) is gone from code and CSS.
//   4. Renderer CSS declares no overflow:auto|scroll outside the listed exceptions.
// It reads source with the TypeScript parser, so comments never count.
// WHY a test and not an ast-grep rule: it follows `style={NAME}` to the const it names, ties CSS
// to TSX, and fails when an exception stops matching — a rule can do none of the three.
//
// Exceptions the scan cannot see, recorded here so the list is whole:
//   • The message box (InputBar.tsx) sets its textarea's overflow by script; its fade is on the
//     text's wrapper, following the textarea (`scroll-mask--follow`).
//   • The terminal (xterm): draws its own viewport; out of scope by Destin's brief.
//   • Pages (components/pages/page-kit.ts): a page's own scroll areas get the kit's automatic fade,
//     and the page document itself fades on its frame (`.scroll-mask-frame`, PageHost.tsx).

const SRC = join(__dirname, '..', 'src', 'renderer');

/** A real exception: the file, a piece of text unique to the element (or literal), and why. */
interface Exception { file: string; has: string; why: string }
const EXCEPTIONS: Exception[] = [
  {
    file: 'components/ChatView.tsx',
    has: 'chat-scroll flex-1 min-h-0 overflow-y-auto',
    why: 'A mask makes the scroller a backdrop root, so the frosted chat bubbles inside would stop ' +
      'blurring the wallpaper (float-chrome-pops.test.ts pins "never a mask on .chat-scroll"). The ' +
      'Minimalist layout fades the transcript with ChatEdgeFade, a masked wallpaper copy laid over it.',
  },
  {
    file: 'components/SessionPreviewPane.tsx',
    has: 'relative min-h-0 flex-1 overflow-y-auto py-3',
    why: 'The conversation preview\'s bubbles are frosted like the chat\'s — same backdrop-root reason.',
  },
  {
    file: 'components/marketplace/MarketplaceScreen.tsx',
    has: 'relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col',
    why: 'The page\'s hero, filter bar and cards are frosted glass; a mask on the page scroller made the ' +
      'wallpaper show through them unblurred (screenshots, 2026-10-15). Needs a ChatEdgeFade-style overlay.',
  },
  {
    file: 'components/library/LibraryScreen.tsx',
    has: 'relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col',
    why: 'Same as the Marketplace page: its tab pill and cards are frosted glass.',
  },
];

const CLASS_TOKEN = /(?<![\w-])(?:[\w-]+:)*overflow(?:-[xy])?-(?:auto|scroll)(?![\w-])/;
const STYLE_TOKEN = /\boverflow[XY]?\s*:\s*['"`](?:auto|scroll)['"`]/;
const FADE = /(?<![\w-])scroll-mask(?:-[xy])?(?![\w-])/;

export interface Finding { file: string; line: number; text: string }

/** Scans one file's source; returns the scroll areas with no fade and how many it saw. */
export function scanSource(file: string, source: string): { bare: Finding[]; areas: number } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bare: Finding[] = [];
  let areas = 0;
  const at = (node: ts.Node, text: string): Finding =>
    ({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.replace(/\s+/g, ' ').slice(0, 160) });

  // Top-level `const NAME = …` initialisers, so style={NAME} can be read through.
  const consts = new Map<string, ts.Expression>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    }
  }
  const attrText = (attrs: ts.JsxAttributes, name: string): { text: string; ident?: string } => {
    for (const p of attrs.properties) {
      if (!ts.isJsxAttribute(p) || p.name.getText(sf) !== name || !p.initializer) continue;
      const init = p.initializer;
      const expr = ts.isJsxExpression(init) ? init.expression : init;
      if (expr && ts.isIdentifier(expr) && consts.has(expr.text)) {
        return { text: consts.get(expr.text)!.getText(sf), ident: expr.text };
      }
      return { text: init.getText(sf) };
    }
    return { text: '' };
  };

  // Names of style consts used by an element that carries the fade (rule 1 covers them).
  const coveredStyleConsts = new Set<string>();
  const inAttr = (node: ts.Node, names: string[]): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return names.includes(p.name.getText(sf));
    }
    return false;
  };

  const visitElements = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const cls = attrText(node.attributes, 'className');
      const style = attrText(node.attributes, 'style');
      if (CLASS_TOKEN.test(cls.text) || STYLE_TOKEN.test(style.text)) {
        areas++;
        if (FADE.test(cls.text)) { if (style.ident) coveredStyleConsts.add(style.ident); }
        else bare.push(at(node, node.getText(sf).split('\n')[0] + ' ' + cls.text + ' ' + style.text));
      }
    }
    ts.forEachChild(node, visitElements);
  };
  visitElements(sf);

  // Rule 2: scroll classes / overflow styles written outside an element's attributes.
  const visitLiterals = (node: ts.Node) => {
    const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
    if (isText && CLASS_TOKEN.test(node.getText(sf)) && !inAttr(node, ['className', 'style']) && !FADE.test(node.getText(sf))) {
      bare.push(at(node, node.getText(sf)));
    }
    if (ts.isPropertyAssignment(node) && STYLE_TOKEN.test(node.getText(sf)) && !inAttr(node, ['style', 'className'])) {
      // Inside `const NAME = {…}`: fine when an element with the fade uses it as its style.
      let decl: ts.Node | undefined = node.parent;
      while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
      const name = decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : '';
      if (!coveredStyleConsts.has(name)) bare.push(at(node, `${name}: ${node.getText(sf)}`));
    }
    ts.forEachChild(node, visitLiterals);
  };
  visitLiterals(sf);
  return { bare, areas };
}

function walk(dir: string, ext: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'dev' && dir === SRC ? [] : walk(full, ext);
    return ext.some((e) => full.endsWith(e)) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}
const rel = (f: string) => relative(SRC, f).split('\\').join('/');
const excepted = (f: Finding) => EXCEPTIONS.find((e) => e.file === f.file && f.text.includes(e.has));

describe('every scroll area fades (the one scroll fade)', () => {
  const files = walk(SRC, ['.tsx', '.ts']);
  const results = files.map((f) => ({ file: rel(f), ...scanSource(rel(f), readFileSync(f, 'utf8')) }));
  const all = results.flatMap((r) => r.bare);

  it('the scan sees the app\'s scroll areas (non-vacuity)', () => {
    expect(results.reduce((n, r) => n + r.areas, 0)).toBeGreaterThan(60);
  });

  it('flags a bare scroll area, and passes one with the fade (proof the guard bites)', () => {
    const bad = scanSource('x.tsx', `const S = { overflowY: 'auto' } as const;
      const A = () => <div className="max-h-40 overflow-y-auto" />;
      const B = () => <ul style={{ overflowX: 'scroll' }} />;
      const C = () => <div className={\`flex \${x ? 'sm:overflow-auto' : ''}\`} />;
      const D = () => <textarea style={S} />;
      const E = 'p-2 overflow-x-auto';`);
    // Line 1 is the style const (only a faded element may use it), 2–5 the elements, 6 the string.
    expect(bad.bare.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const good = scanSource('y.tsx', `const S = { overflowY: 'auto' } as const;
      const A = () => <div className="scroll-mask max-h-40 overflow-y-auto" />;
      const D = () => <textarea className="scroll-mask" style={S} />;
      const E = 'scroll-mask p-2 overflow-x-auto';
      // a comment about overflow-y-auto never counts
      const F = () => <div className="overflow-hidden scroll-masked" />;`);
    expect(good.bare).toEqual([]);
    expect(good.areas).toBe(2);
  });

  it('no scroll area ships without the fade', () => {
    const missing = all.filter((f) => !excepted(f));
    expect(missing, `These scroll without the app's one fade:\n  ${missing.map((f) => `${f.file}:${f.line}  ${f.text}`).join('\n  ')}\n\n` +
      'Add `scroll-mask` to the element that scrolls (styles/scroll-mask.css): CSS-only, no hook, it fades only an edge ' +
      'with more to see (`scroll-mask-x` / `scroll-mask-y` for a box repeated many times that scrolls one way only). If the box has its own border or fill, put those on a wrapper and the fade on the scroller, or ' +
      'the mask fades the frame too. A real exception goes in EXCEPTIONS above, with its reason.').toEqual([]);
  });

  it('every exception still matches something (the list cannot go stale)', () => {
    const stale = EXCEPTIONS.filter((e) => !all.some((f) => f.file === e.file && f.text.includes(e.has)));
    expect(stale, 'These exceptions match nothing any more — delete them').toEqual([]);
  });

  it('the painted band (.scroll-fade / .scroll-fade-x) is gone', () => {
    const painted = /(?<![\w-])scroll-fade(?:-x)?(?![\w-])/;
    const users: string[] = [];
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node) => {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && painted.test(n.getText(sf))) users.push(`${rel(f)}: ${n.getText(sf)}`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const css = walk(SRC, ['.css']).filter((f) => /\.scroll-fade(?:-x)?(?![\w-])/.test(stripCssComments(readFileSync(f, 'utf8')))).map(rel);
    expect([...users, ...css], 'Use .scroll-mask — the painted band was retired 2026-10-15').toEqual([]);
  });

  it('renderer CSS scrolls only where listed', () => {
    // Every CSS overflow:auto|scroll is a scroll area the className scan cannot see.
    const CSS_ALLOWED: Record<string, string> = {};
    const found = walk(SRC, ['.css']).flatMap((f) => {
      const text = stripCssComments(readFileSync(f, 'utf8'));
      return [...text.matchAll(/([^{};]*)\{[^}]*\boverflow(?:-[xy])?\s*:\s*[^;}]*\b(auto|scroll)\b/g)]
        .map((m) => `${rel(f)}: ${m[1].trim()}`);
    }).filter((k) => !(k in CSS_ALLOWED));
    expect(found, 'A CSS rule makes these scroll: give the element .scroll-mask in its className and the overflow there, or list it').toEqual([]);
  });
});

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
