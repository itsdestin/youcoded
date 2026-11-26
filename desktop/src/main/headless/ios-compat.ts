// ios-compat.ts — fills the gaps between the Node the backend is written for and the Node an iPhone can run.
//
// WHY (2026-11-25, iPhone app, card #89): the desktop and the Android app run this backend on a current Node (24).
// The only Node that runs inside an iPhone app is nodejs-mobile's Node 18 build, with V8's JIT off (Apple forbids
// runtime code generation). That leaves three kinds of gap, all filled here so no backend file has to know:
//   1. `fetch` cannot work (it needs WebAssembly, which a JIT-less V8 lacks)  → ios-fetch.ts.
//   2. Globals Node 18 keeps behind a flag or lacks (`crypto`, `File`, `AbortSignal.any`, `navigator`).
//   3. A few JavaScript library methods newer than Node 18's V8 (`toSorted`, `Object.groupBy`, …).
// Every fill is "only if missing", so loading this on a current Node (the laptop test run, unit tests) changes
// nothing. This file MUST be the first import of the iPhone entry (ios-main.ts): later imports use these at load.
import nodeCrypto from 'crypto';
import { Blob as NodeBlob } from 'buffer';
import { iosFetch } from './ios-fetch';

type AnyRecord = Record<string, unknown>;
const g = globalThis as unknown as AnyRecord;

/** Define a method only where the runtime lacks it; non-enumerable, like the real ones. */
function fill(target: object, name: string, value: unknown): void {
  if (name in target) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

/** True when this runtime's own `fetch` cannot work: no WebAssembly means undici's HTTP parser cannot load. */
export function builtinFetchIsBroken(): boolean {
  return typeof g.WebAssembly === 'undefined';
}

// ── Unicode property escapes (`\p{…}`) ───────────────────────────────────────────────────────────────────────────────
// WHY (2026-11-25): nodejs-mobile builds Node for iOS WITHOUT the Unicode data library (ICU, `--with-intl=none`), and
// without it V8 rejects every regular expression that names a Unicode property — `\p{Extended_Pictographic}`,
// `\p{Cc}` — with a SyntaxError. Several libraries the backend loads build such an expression AS THEY LOAD (zod's emoji
// check among them), so the backend could not even start. The build (ios/runtime/build-backend.mjs) finds every
// property the bundle names, works out its code-point ranges on the build machine (whose Node has the data), and
// hands them over here as __YC_UNICODE_TABLES__; this turns `\p{Name}` into those plain ranges before the expression
// reaches V8. Literals are covered too: the build makes esbuild write them as `new RegExp(...)` calls.

/** Property name → the body of a character class (ranges as `\u{…}` escapes), e.g. `Cc` → `\u{0}-\u{1F}\u{7F}-\u{9F}`. */
export type UnicodeTables = Record<string, string>;
declare const __YC_UNICODE_TABLES__: UnicodeTables | undefined;

/** Does this runtime understand `\p{…}` itself? */
export function unicodePropertiesWork(): boolean {
  try { new RegExp('\\p{L}', 'u'); return true; } catch { return false; }
}

/** Replace every `\p{Name}` / `\P{Name}` in a pattern with plain ranges. A name with no table is left alone, so V8
 *  reports it exactly as it would have (never a silently wrong match). */
export function rewriteUnicodeProperties(pattern: string, tables: UnicodeTables): string {
  if (pattern.indexOf('\\p{') < 0 && pattern.indexOf('\\P{') < 0) return pattern;
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[i + 1];
      if ((next === 'p' || next === 'P') && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3);
        const body = end > 0 ? tables[pattern.slice(i + 3, end)] : undefined;
        if (body !== undefined && end > 0) {
          if (next === 'p') out += inClass ? body : `[${body}]`;
          // "Not this property" can only be written as its own class; inside another class there is no plain
          // spelling, so that one case is left for V8 to refuse loudly.
          else if (!inClass) out += `[^${body}]`;
          else { out += pattern.slice(i, end + 1); }
          i = end;
          continue;
        }
      }
      out += c + (next ?? '');
      i++;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

/** Make `new RegExp(pattern)` accept `\p{…}` on a runtime without Unicode data. No-op where it already works. */
export function installRegExpPropertyFallback(tables: UnicodeTables, force = false): void {
  if (!force && unicodePropertiesWork()) return;
  const Native = RegExp as RegExpConstructor & { __ycPatched?: boolean };
  if (Native.__ycPatched) return;
  const Patched = function RegExp(this: unknown, pattern: unknown, flags?: string): RegExp {
    const p = typeof pattern === 'string' ? rewriteUnicodeProperties(pattern, tables) : pattern;
    // `new.target` keeps subclasses (and `Reflect.construct`) working; a plain call behaves like RegExp(...).
    return new.target
      ? Reflect.construct(Native, flags === undefined ? [p] : [p, flags], new.target === Patched ? Native : new.target) as RegExp
      : (flags === undefined ? (Native as (p: unknown) => RegExp)(p) : (Native as (p: unknown, f: string) => RegExp)(p, flags));
  } as unknown as RegExpConstructor & { __ycPatched?: boolean };
  // Same prototype object, so `x instanceof RegExp`, literals and every method are untouched.
  (Patched as unknown as { prototype: RegExp }).prototype = Native.prototype;
  Object.setPrototypeOf(Patched, Native);
  Patched.__ycPatched = true;
  Object.defineProperty(Native.prototype, 'constructor', { value: Patched, writable: true, configurable: true });
  (globalThis as unknown as { RegExp: RegExpConstructor }).RegExp = Patched;
}

/** Node 18 loads its whole built-in fetch (undici) the first time ANY of `Headers`, `Request`, `Response` or
 *  `FormData` is touched — and that load starts compiling the WebAssembly HTTP parser, which without WebAssembly
 *  becomes an unhandled rejection in the log on every launch ("WebAssembly is not defined"). The parser is never
 *  used (ios-fetch.ts does the networking), so the load is done once here with a stand-in whose compile simply
 *  never finishes, then the stand-in is removed so nothing else mistakes the phone for one that has WebAssembly. */
function quietBuiltinFetchLoad(): void {
  const never = () => new Promise<never>(() => {});
  g.WebAssembly = { compile: never, instantiate: never, Module: class {}, Instance: class {} };
  try { void new Headers(); } catch { /* benign: this only pre-loads a library to keep one line out of the log; fetch itself is ios-fetch.ts */ } finally { delete g.WebAssembly; }
}

/** What must be true for the backend to live inside an app instead of being a program of its own. Call once, from
 *  the iPhone entry only.
 *  - An uncaught error is logged, never fatal: on a computer a crashed backend is restarted by its host; here the
 *    "crash" would be the whole app disappearing from the person's hand.
 *  - `process.exit` cannot be allowed to run on the phone (it ends the app without a word). It prints a line the
 *    app watches for (BackendRunner.swift shows "close and reopen YouCoded") and then holds this thread still, so
 *    code that asked to exit really does stop running. */
export function installInProcessGuards(): void {
  process.on('uncaughtException', (e) => console.error('[ios] uncaught exception:', e));
  // WHY the backend's own SIGTERM/SIGINT handlers are refused in-process (found in the simulator, 2026-11-25): on a
  // computer they shut the backend down and exit. Inside the app the signal is meant for the APP (iOS or Xcode ending
  // it); a handler here would run the exit guard below and leave a half-alive app that ignores being closed. With no
  // handler, the signal ends the process as the sender intended.
  if (process.env.YOUCODED_IN_PROCESS === '1' || (process.platform as string) === 'ios') {
    const on = process.on.bind(process);
    process.on = ((event: string, listener: (...a: unknown[]) => void) => (event === 'SIGTERM' || event === 'SIGINT' ? process : on(event as never, listener as never))) as typeof process.on;
  }
  // Only when the backend really is inside an app (the Swift shell says so); a laptop run of this entry exits like any program.
  if (process.env.YOUCODED_IN_PROCESS !== '1' && (process.platform as string) !== 'ios') return;
  const hold = (code?: number | string | null): never => {
    try { require('fs').writeSync(1, `YOUCODED_HEADLESS_EXIT ${code ?? 0}\n`); } catch { /* benign: if the line cannot be written the app's own start timeout still shows the same screen */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('unreachable');
  };
  process.exit = hold as typeof process.exit;
  (process as unknown as { reallyExit: unknown }).reallyExit = hold;
}

export function installIosCompat(opts: { forceFetch?: boolean } = {}): void {
  // 0. Regular expressions first: modules loaded after this build `\p{…}` expressions as they load.
  installRegExpPropertyFallback(typeof __YC_UNICODE_TABLES__ === 'undefined' ? {} : __YC_UNICODE_TABLES__);

  // 1. fetch. WHY replaced only when broken: on a runtime where the built-in works, it stays the one in use, so a
  // laptop run of this entry behaves like the desktop.
  if (opts.forceFetch || builtinFetchIsBroken()) {
    g.fetch = iosFetch;
  }
  if (builtinFetchIsBroken()) quietBuiltinFetchLoad();

  // 2. Globals.
  // Node 18 has Web Crypto but only as require('crypto').webcrypto; Node 19+ (and all backend code) uses the global.
  if (typeof g.crypto === 'undefined') {
    Object.defineProperty(g, 'crypto', { value: nodeCrypto.webcrypto, writable: true, configurable: true });
  }
  if (typeof g.Blob === 'undefined') g.Blob = NodeBlob;
  if (typeof g.File === 'undefined') {
    // Node 20 added the global. Same shape: a Blob with a name and a modified time.
    const B = g.Blob as typeof Blob;
    g.File = class File extends B {
      readonly name: string;
      readonly lastModified: number;
      readonly webkitRelativePath = '';
      constructor(bits: BlobPart[], name: string, options: FilePropertyBag = {}) {
        super(bits, options);
        this.name = String(name);
        this.lastModified = options.lastModified ?? Date.now();
      }
      get [Symbol.toStringTag](): string { return 'File'; }
    };
  }
  const AS = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal };
  if (typeof AS.any !== 'function') {
    // Node 20.3 added it: one signal that aborts when the first of several does, with that signal's reason.
    AS.any = (signals: AbortSignal[]): AbortSignal => {
      const controller = new AbortController();
      const list = Array.from(signals);
      const stop = (s: AbortSignal) => {
        controller.abort(s.reason);
        for (const other of list) other.removeEventListener('abort', handlers.get(other)!);
      };
      const handlers = new Map<AbortSignal, () => void>();
      for (const s of list) {
        if (s.aborted) { controller.abort(s.reason); return controller.signal; }
      }
      for (const s of list) {
        const h = () => stop(s);
        handlers.set(s, h);
        s.addEventListener('abort', h, { once: true });
      }
      return controller.signal;
    };
  }

  // 3. JavaScript library methods newer than Node 18's V8 (10.2).
  fill(Array.prototype, 'toSorted', function <T>(this: T[], cmp?: (a: T, b: T) => number): T[] { return [...this].sort(cmp); });
  fill(Array.prototype, 'toReversed', function <T>(this: T[]): T[] { return [...this].reverse(); });
  fill(Array.prototype, 'toSpliced', function <T>(this: T[], ...args: [number, number, ...T[]]): T[] { const c = [...this]; c.splice(...args); return c; });
  fill(Array.prototype, 'with', function <T>(this: T[], index: number, value: T): T[] {
    const i = index < 0 ? this.length + index : index;
    if (i < 0 || i >= this.length) throw new RangeError('Invalid index');
    const c = [...this]; c[i] = value; return c;
  });
  fill(Array, 'fromAsync', async function <T, U>(items: AsyncIterable<T> | Iterable<T | Promise<T>>, mapFn?: (v: T, i: number) => U | Promise<U>): Promise<Array<T | U>> {
    const out: Array<T | U> = [];
    let i = 0;
    for await (const v of items as AsyncIterable<T>) out.push(mapFn ? await mapFn(v, i++) : v);
    return out;
  });
  fill(Object, 'groupBy', function <T>(items: Iterable<T>, keyFn: (v: T, i: number) => PropertyKey): Record<PropertyKey, T[]> {
    const out = Object.create(null) as Record<PropertyKey, T[]>;
    let i = 0;
    for (const v of items) { const k = keyFn(v, i++); (out[k] ??= []).push(v); }
    return out;
  });
  fill(Map, 'groupBy', function <K, T>(items: Iterable<T>, keyFn: (v: T, i: number) => K): Map<K, T[]> {
    const out = new Map<K, T[]>();
    let i = 0;
    for (const v of items) { const k = keyFn(v, i++); const list = out.get(k); if (list) list.push(v); else out.set(k, [v]); }
    return out;
  });
  fill(Promise, 'withResolvers', function <T>(): { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (e?: unknown) => void } {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (e?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  });
  fill(String.prototype, 'isWellFormed', function (this: string): boolean {
    // A lone surrogate is the only way a JavaScript string is not valid Unicode.
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(this));
  });
  fill(String.prototype, 'toWellFormed', function (this: string): string {
    return String(this).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  });
  const setFills: Record<string, (this: Set<unknown>, other: Set<unknown>) => unknown> = {
    union(other) { const r = new Set(this); for (const v of other) r.add(v); return r; },
    intersection(other) { const r = new Set<unknown>(); for (const v of this) if (other.has(v)) r.add(v); return r; },
    difference(other) { const r = new Set(this); for (const v of other) r.delete(v); return r; },
    symmetricDifference(other) { const r = new Set(this); for (const v of other) { if (r.has(v)) r.delete(v); else r.add(v); } return r; },
    isSubsetOf(other) { for (const v of this) if (!other.has(v)) return false; return true; },
    isSupersetOf(other) { for (const v of other) if (!this.has(v)) return false; return true; },
    isDisjointFrom(other) { for (const v of this) if (other.has(v)) return false; return true; },
  };
  for (const [name, fn] of Object.entries(setFills)) fill(Set.prototype, name, fn);
}
