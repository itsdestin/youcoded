import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
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
const MAY_CANCEL: Record<string, string> = {
  // Ctrl+wheel / trackpad pinch → app zoom. Passive on the desktop app (the browser has nothing to cancel there:
  // its pinch zoom is switched off in main.ts), cancelable only on remote browsers / Android WebView, where the
  // browser's own page zoom must be stopped. Bails out before preventDefault unless ctrlKey is set, so plain
  // scrolling is never touched on either.
  'src/renderer/hooks/useZoomControls.ts': 'pinch-to-zoom the app (passive on desktop; cancelable off-desktop only)',
  // Finger-drag scrolling of the xterm terminal on a touch device: preventDefault stops xterm's own text
  // selection. Registered on the terminal's own container, and only when the device has touch.
  'src/renderer/components/TerminalView.tsx': 'touch-drag scrolling of the terminal (touch devices only)',
};

// Files that register under a name the scan cannot resolve; each was read and the names are not wheel/touch.
const DYNAMIC_NAMES_REVIEWED: Record<string, string> = {
  'src/renderer/components/TimelineEntryHint.tsx': 'EVENTS is a fixed list of mouse/pointer hover events for the hint tooltip',
};

const ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Every `const NAME = '...'` string constant in `text` (module level or not), name -> value. */
export function stringConstants(text: string): Map<string, string> {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = new Map<string, string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)
      && (ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const)) out.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const WATCHED = new Set(['wheel', 'mousewheel', 'touchstart', 'touchmove']);

/**
 * Every wheel/touch registration in `text` that could make a scroll wait for the page, found with the TypeScript
 * parser (review fix 7, 2026-10-04). WHY not a regex: the first version stopped at the first `;` (a handler
 * body containing one hid a later `{ passive: false }`), missed `el?.addEventListener` and a bare
 * `addEventListener(...)`, ignored event names held in a variable or loop, and read `passive: true && x` as passive.
 * Rules, per call to anything named addEventListener:
 *  - the event name is a literal in the watched set, OR is not a literal at all (a variable / loop / template —
 *    it could be a wheel event, so it must prove itself passive);
 *  - it is fine only if the options argument is an object literal whose `passive` is exactly the literal `true`;
 *  - the one exception: an options-free (or passive-free) call on `window` / `document` with a literal watched
 *    name, where Chromium already forces wheel/touchstart/touchmove passive.
 */
export function blockingRegistrations(text: string, consts: ReadonlyMap<string, string> = new Map()): string[] {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const nameOf = (e: ts.Expression): string | null => {
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isIdentifier(e)) return e.text;
    return null;
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && nameOf(n.expression) === 'addEventListener' && n.arguments.length >= 1) {
      const evArg = n.arguments[0];
      // a literal, or a name that is a string constant somewhere in the renderer (custom app events are held in
      // constants like REMOTE_RECONNECTED_EVENT)
      const literal = ts.isStringLiteralLike(evArg) ? evArg.text : ts.isIdentifier(evArg) ? (consts.get(evArg.text) ?? null) : null;
      if (literal === null || WATCHED.has(literal)) {
        const opts = n.arguments[2];
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
        const recv = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : null;
        const onGlobal = !!recv && ts.isIdentifier(recv) && (recv.text === 'window' || recv.text === 'document');
        const defaultPassive = literal !== null && onGlobal && (!opts || (optsKnown && !passiveProp));
        if (!passiveTrue && !defaultPassive) out.push(n.getText(sf).replace(/\s+/g, ' ').slice(0, 140));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('wheel scrolling stays native', () => {
  it('no renderer file registers a wheel/touch listener that can make a scroll wait, outside the allowlist', () => {
    const offenders: string[] = [];
    const files = walk(join(ROOT, 'src/renderer'));
    const consts = new Map<string, string>();
    for (const file of files) for (const [k, v] of stringConstants(readFileSync(file, 'utf8'))) consts.set(k, v);
    for (const file of files) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8');
      if (blockingRegistrations(text, consts).length && !(rel in MAY_CANCEL) && !(rel in DYNAMIC_NAMES_REVIEWED)) offenders.push(rel);
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

  it('every allowlisted file still exists and still needs its exemption', () => {
    for (const rel of Object.keys(DYNAMIC_NAMES_REVIEWED)) {
      expect(blockingRegistrations(readFileSync(join(ROOT, rel), 'utf8')), `${rel} no longer needs its review note`).not.toEqual([]);
    }
    for (const rel of Object.keys(MAY_CANCEL)) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(blockingRegistrations(text), `${rel} no longer has a blocking listener — drop it from the allowlist`).not.toEqual([]);
    }
  });

  // Seen red: every shape the first (regex) version missed, plus the ones it caught, and what must pass.
  it('the scan itself catches each hole and lets passive and default-passive registrations through', () => {
    const bad = [
      "window.addEventListener('wheel', h, { passive: false, capture: true });",
      "window.addEventListener('wheel', () => { a(); b(); }, { passive: false });",          // `;` inside the handler body
      "el?.addEventListener('wheel', h, { passive: false });",                              // optional chaining
      "addEventListener('wheel', h, { passive: false });",                                  // no receiver
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
      "for (const ev of ['wheel', 'touchstart']) el.addEventListener(ev, h, { passive: true });",
      "document.addEventListener('touchstart', h);",                                        // Chromium forces passive here
      "window.addEventListener('keydown', h);",                                             // not a scroll event
      "el.addEventListener('click', h, { passive: false });",
    ];
    for (const src of good) expect(blockingRegistrations(src), src).toEqual([]);
    // a constant that holds a custom event name is resolved; one that holds 'wheel' is not waved through
    expect(blockingRegistrations("window.addEventListener(OPEN_EVENT, h);", new Map([['OPEN_EVENT', 'app:open']]))).toEqual([]);
    expect(blockingRegistrations("window.addEventListener(WHEELY, h, { passive: false });", new Map([['WHEELY', 'wheel']]))).toHaveLength(1);
  });
});
