import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * Wheel and trackpad scrolling belong to the browser engine, everywhere.
 *
 * The chat once carried a homemade scroll engine: a wheel listener that could
 * cancel the browser's own scroll (`passive: false` + preventDefault), then
 * re-applied each delta times a "burst" multiplier and ran its own friction
 * glide. On the engine YouCoded ships (measured 2026-09-29, Electron 41 on a
 * Wayland trackpad) that fought the engine's built-in behaviour, which already
 * coasts after a flick, stops when fingers rest on the pad, and boosts repeated
 * flicks. The result was scrolling that ran up to 4× ahead of the fingers,
 * kept going after the user stopped, and stuttered while a reply streamed.
 *
 * So: a wheel listener in the renderer must be passive (read-only), except the
 * ones listed here, each with its reason. A new entry needs the same kind of
 * reason — and must leave plain (non-Ctrl) wheel scrolling to the browser.
 *
 * Fix 3 (2026-10-04) widened this from "cannot cancel the scroll" to "cannot make the scroll wait": a
 * NON-passive wheel/touch listener makes the browser ask the page's main thread before it scrolls, so with the
 * page busy (a reply streaming, a terminal flood) every scroll sat ~400 ms behind a 400 ms block — measured with
 * scripts/perf-lab/scroll-deferral.mjs. So touchstart / touchmove / mousewheel are covered too, and a
 * registration must say `passive: true` in the call itself. The only call that may omit it is one on
 * `window` or `document` itself, where Chromium already forces wheel/touchstart/touchmove passive.
 */
/** A site that may stay blocking: the file, a snippet that must appear in the offending call, and why. */
const MAY_CANCEL: Array<{ file: string; site: string; why: string }> = [
  // Ctrl+wheel / trackpad pinch → app zoom. Passive on the desktop app (the browser has nothing to cancel there:
  // its pinch zoom is switched off in main.ts), cancelable only on remote browsers / Android WebView, where the
  // browser's own page zoom must be stopped. Bails out before preventDefault unless ctrlKey is set, so plain
  // scrolling is never touched on either.
  { file: 'src/renderer/hooks/useZoomControls.ts', site: 'SCROLL_NEVER_WAITS', why: 'pinch-to-zoom the app (passive on desktop; cancelable off-desktop only)' },
  // Finger-drag scrolling of the xterm terminal on a touch device: preventDefault stops xterm's own text
  // selection. Registered on the terminal's own container, and only when the device has touch.
  { file: 'src/renderer/components/TerminalView.tsx', site: 'onTouchMove', why: 'touch-drag scrolling of the terminal (touch devices only)' },
  // A fixed list of mouse/pointer hover events for the hint tooltip; the name is a variable the scan cannot resolve.
  { file: 'src/renderer/components/TimelineEntryHint.tsx', site: 'el.addEventListener(type, fn)', why: 'EVENTS holds hover events, none of them wheel/touch' },
];

const ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const parse = (text: string) => ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The `const NAME = '...'` string constants declared in ONE file, name -> value. */
export function stringConstants(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)
      && (ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const)) out.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, visit);
  };
  visit(parse(text));
  return out;
}

/**
 * The constants visible in `file`: its own, plus the ones it imports by name from a relative module. Per file (a
 * constant in one file never stands for a same-named one in another).
 */
export function constantsFor(file: string, cache = new Map<string, Map<string, string>>()): Map<string, string> {
  const hit = cache.get(file);
  if (hit) return hit;
  const text = readFileSync(file, 'utf8');
  const out = stringConstants(text);
  cache.set(file, out);
  for (const st of parse(text).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
    const base = resolve(dirname(file), st.moduleSpecifier.text);
    const target = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e).find(existsSync);
    const named = st.importClause?.namedBindings;
    if (!target || !named || !ts.isNamedImports(named)) continue;
    const theirs = constantsFor(target, cache);
    for (const el of named.elements) {
      const v = theirs.get((el.propertyName ?? el.name).text);
      if (v !== undefined) out.set(el.name.text, v);
    }
  }
  return out;
}

const WATCHED = new Set(['wheel', 'mousewheel', 'touchstart', 'touchmove']);
const HANDLER_PROPS = new Set(['onwheel', 'onmousewheel', 'ontouchstart', 'ontouchmove']);

/**
 * Every wheel/touch registration in `text` that could make a scroll wait for the page, found with the TypeScript
 * parser. WHY not a regex: the first version stopped at the first `;`, missed `el?.addEventListener` and a bare
 * `addEventListener(...)`, ignored event names held in a variable, and read `passive: true && x` as passive.
 * Rules, per call to anything named addEventListener (also `x['addEventListener'](…)` and `….call/apply(target, …)`):
 *  - the event name is a literal (or a string constant resolved from the file's own or imported constants) in the
 *    watched set, OR is not resolvable at all (a variable / loop / template — it could be a wheel event);
 *  - it is fine only if the options argument is an object literal whose `passive` is exactly the literal `true`;
 *  - the one exception: an options-free (or passive-free) call on `window` / `document` with a literal watched
 *    name, where Chromium already forces wheel/touchstart/touchmove passive.
 * Also flagged: assigning `el.onwheel = …` / `onmousewheel` / `ontouchstart` / `ontouchmove` (a handler property
 * cannot be passive), and any OTHER call that is handed a watched event name as a string argument (a wrapper such
 * as `on(window, 'wheel', …)` that registers for you) unless it is a remove/query call.
 */
export function blockingRegistrations(text: string, consts: ReadonlyMap<string, string> = new Map()): string[] {
  const sf = parse(text);
  const out: string[] = [];
  const nameOf = (e: ts.Expression): string | null => {
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
    if (ts.isIdentifier(e)) return e.text;
    return null;
  };
  const eventName = (e: ts.Expression): string | null =>
    ts.isStringLiteralLike(e) ? e.text : ts.isIdentifier(e) ? (consts.get(e.text) ?? null) : null;
  const flag = (n: ts.Node) => out.push(n.getText(sf).replace(/\s+/g, ' ').slice(0, 140));
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      let callee = n.expression;
      let args = [...n.arguments];
      let recv: ts.Expression | null = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : null;
      // addEventListener.call(target, 'wheel', h, opts) / .apply: the target is the first argument
      if (nameOf(callee) === 'call' && ts.isPropertyAccessExpression(callee) && nameOf(callee.expression) === 'addEventListener') {
        recv = args[0] ?? null; args = args.slice(1); callee = callee.expression;
      }
      if (nameOf(callee) === 'addEventListener' && args.length >= 1) {
        const literal = eventName(args[0]);
        if (literal === null || WATCHED.has(literal)) {
          const opts = args[2];
          let passiveProp: ts.Expression | undefined;
          let optsKnown = false;
          if (opts && ts.isObjectLiteralExpression(opts)) {
            optsKnown = true;
            for (const p of opts.properties) {
              if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'passive') passiveProp = p.initializer;
              // `{ passive }` shorthand and `{ ...spread }` hide the value: not provably passive
              if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'passive') passiveProp = p.name;
              if (ts.isSpreadAssignment(p)) optsKnown = false;
            }
          }
          const passiveTrue = optsKnown && passiveProp?.kind === ts.SyntaxKind.TrueKeyword;
          const onGlobal = !!recv && ts.isIdentifier(recv) && (recv.text === 'window' || recv.text === 'document');
          const defaultPassive = literal !== null && onGlobal && (!opts || (optsKnown && !passiveProp));
          if (!passiveTrue && !defaultPassive) flag(n);
        }
      } else if (!/^(remove|query|get|has|matches|includes|indexOf)/i.test(nameOf(callee) ?? '')) {
        // a wrapper that registers for the caller: any call handed a watched event name
        if (n.arguments.some((a) => ts.isStringLiteralLike(a) && WATCHED.has(a.text)) && !/addEventListener|removeEventListener/.test(nameOf(callee) ?? '')) flag(n);
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = n.left;
      const prop = ts.isPropertyAccessExpression(left) ? left.name.text : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : null;
      if (prop && HANDLER_PROPS.has(prop.toLowerCase())) flag(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('wheel scrolling stays native', () => {
  const files = walk(join(ROOT, 'src/renderer'));
  const cache = new Map<string, Map<string, string>>();
  const sitesIn = (file: string) => blockingRegistrations(readFileSync(file, 'utf8'), constantsFor(file, cache));
  const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');

  // WHY the explicit timeout: this parses every renderer file with the TypeScript compiler. It takes ~2 s alone but
  // exceeded the 30 s default when the full suite runs ~1,100 files in parallel (seen red in `verify.sh --full`).
  it('no renderer call site registers a wheel/touch listener that can make a scroll wait, outside the allowlist', { timeout: 120_000 }, () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const site of sitesIn(file)) {
        if (!MAY_CANCEL.some((m) => m.file === rel(file) && site.includes(m.site))) offenders.push(`${rel(file)} :: ${site}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the chat view has no wheel handler of its own', () => {
    const chat = readFileSync(join(ROOT, 'src/renderer/components/ChatView.tsx'), 'utf8');
    // The only wheel mention allowed is the passive, read-only "user took over"
    // signal in the scroll-anchor restore (a loop over event names).
    expect(chat).not.toMatch(/addEventListener\(\s*['"]wheel['"]/);
    expect(chat).not.toMatch(/onWheel\s*=/);
  });

  it('every allowlisted call site still exists and still needs its exemption', () => {
    for (const m of MAY_CANCEL) {
      const found = sitesIn(join(ROOT, m.file)).filter((x) => x.includes(m.site));
      expect(found, `${m.file} :: ${m.site} no longer has a blocking registration — drop it from the allowlist`).not.toEqual([]);
    }
  });

  // Seen red: every shape the first (regex) version missed, plus the ones it caught, and what must pass.
  it('the scan itself catches each hole and lets passive and default-passive registrations through', () => {
    const bad = [
      "window.addEventListener('wheel', h, { passive: false, capture: true });",
      "window.addEventListener('wheel', () => { a(); b(); }, { passive: false });",          // `;` inside the handler body
      "el?.addEventListener('wheel', h, { passive: false });",                              // optional chaining
      "addEventListener('wheel', h, { passive: false });",                                  // no receiver
      "window['addEventListener']('wheel', h, { passive: false });",                        // element access
      "addEventListener.call(window, 'wheel', h, { passive: false });",                     // .call
      "el.addEventListener.call(el, 'touchmove', h);",
      "window.addEventListener.apply(window, ['wheel', h, { passive: false }]);".replace('.apply(window, [', '.call(window, ').replace(']);', ');'),
      "el.onwheel = h;",                                                                    // handler properties
      "window.ontouchmove = h;",
      "el['onmousewheel'] = h;",
      "on(window, 'wheel', h);",                                                            // a wrapper that registers for you
      "bindEvent(el, 'touchstart', h, { passive: false });",
      "for (const ev of ['wheel', 'touchstart']) el.addEventListener(ev, h, { passive: false });", // name in a variable
      "el.addEventListener(name, h);",                                                      // unknown name, no options
      "window.addEventListener('wheel', h, { passive: true && cond });",                    // not the literal true
      "window.addEventListener('wheel', h, { passive: cond });",
      "window.addEventListener('wheel', h, { passive });",
      "window.addEventListener('wheel', h, { ...base });",
      "window.addEventListener('wheel', h, opts);",
      "el.addEventListener('touchmove', h, { capture: true, passive: cond });",
      "el.addEventListener('touchstart', h);",                                              // element-level: not default-passive
      "window.addEventListener('mousewheel', h, { passive: false });",
      "document.addEventListener('touchstart', h, { passive: false });",
    ];
    for (const src of bad) expect(blockingRegistrations(src), src).toHaveLength(1);
    const good = [
      "window.addEventListener('wheel', h, { passive: true, capture: true });",
      "el?.addEventListener('wheel', h, { passive: true });",
      "window['addEventListener']('wheel', h, { passive: true });",
      "addEventListener.call(window, 'wheel', h, { passive: true });",
      "for (const ev of ['wheel', 'touchstart']) el.addEventListener(ev, h, { passive: true });",
      "document.addEventListener('touchstart', h);",                                        // Chromium forces passive here
      "window.addEventListener('keydown', h);",                                             // not a scroll event
      "el.addEventListener('click', h, { passive: false });",
      "el.removeEventListener('wheel', h);",
      "el.onclick = h;",
      "const t = list.includes('wheel');",
    ];
    for (const src of good) expect(blockingRegistrations(src), src).toEqual([]);
    // a constant that holds a custom event name is resolved; one that holds 'wheel' is not waved through
    expect(blockingRegistrations("window.addEventListener(OPEN_EVENT, h);", new Map([['OPEN_EVENT', 'app:open']]))).toEqual([]);
    expect(blockingRegistrations("window.addEventListener(WHEELY, h, { passive: false });", new Map([['WHEELY', 'wheel']]))).toHaveLength(1);
  });

  it('constants are per file: a same-named constant in another file is not borrowed', () => {
    expect(stringConstants("const EVT = 'wheel';").get('EVT')).toBe('wheel');
    // this file declares nothing: its EVT is unresolved, so a registration under it must prove itself passive
    expect(blockingRegistrations("window.addEventListener(EVT, h);", new Map())).toHaveLength(1);
  });
});
