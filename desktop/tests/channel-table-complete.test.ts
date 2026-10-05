// The end of the move into the channel table: NO feature channel is served by hand-written code on either door.
//
// WHY this exists: the table is only the one place a feature lives if nothing else is allowed to grow beside it. A
// stray `ipcMain.handle` / `ipcMain.on` for the computer's windows, or a `case '<feature>:...'` in the phone's switch in
// remote-server.ts, would be a second copy of a feature that drifts from the table's (the exact problem the move fixed).
// This reads the source as code and fails on either, except for the few named, reasoned exceptions below; every
// exception must still exist, so the list can only shrink.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { CHANNEL_TABLE } from '../src/main/ipc/channel-table';

const root = path.join(__dirname, '..', 'src', 'main');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

// WHY (R4-1, closing the R3-8 review leftovers): the first version of this scan only saw `ipcMain.handle/on/once(...)`
// written out in full, and only string `case 'x:y':` labels inside remote-server.ts. Each of those is one easy way round
// the guard (`ipcMain.handleOnce`, `const m = ipcMain; m.handle(...)`, `const { handle } = ipcMain`, `case IPC.X:`, a
// second `switch` in another file). The scanners below take the file's text, so the self-tests at the bottom can feed
// them each evasion and prove every one is caught.

/** What stands for the Electron ipcMain object in this file: bare names (`ipcMain`, a parameter typed `IpcMain*`, a variable assigned from an
 *  alias) and PROPERTY names proven to hold it (`this.bus = ipcMain`, `{ ipc: ipcMain }`, a class field or constructor parameter
 *  property typed `IpcMain*`). Property names are matched by name inside this one file only, so an unrelated `.on(` object that was
 *  never assigned ipcMain is not flagged. (R4-1: the first version also treated every object named `ipc` as ipcMain.) */
function ipcAliases(sf: ts.SourceFile): { names: Set<string>; props: Set<string> } {
  const names = new Set<string>(['ipcMain']);
  const props = new Set<string>();
  const isAlias = (e: ts.Expression | undefined): boolean => !!e && ((ts.isIdentifier(e) && names.has(e.text))
    || (ts.isPropertyAccessExpression(e) && (e.name.text === 'ipcMain' || props.has(e.name.text)))
    || (ts.isParenthesizedExpression(e) && isAlias(e.expression)) || (ts.isAsExpression(e) && isAlias(e.expression))
    || (ts.isNonNullExpression(e) && isAlias(e.expression)));
  const typedIpc = (t: ts.TypeNode | undefined) => !!t && /\bIpcMain\w*\b/.test(t.getText(sf));
  // Several passes so an alias of an alias resolves whatever order the statements are written in.
  for (let pass = 0; pass < 3; pass++) {
    const visit = (n: ts.Node) => {
      if (ts.isParameter(n) && ts.isIdentifier(n.name) && typedIpc(n.type)) {
        names.add(n.name.text);
        if (n.modifiers?.length) props.add(n.name.text); // constructor(private bus: IpcMain) -> this.bus
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isAlias(n.initializer)) names.add(n.name.text);
      if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name) && (isAlias(n.initializer) || typedIpc(n.type))) props.add(n.name.text);
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && isAlias(n.initializer)) props.add(n.name.text); // { ipc: ipcMain }
      if (ts.isShorthandPropertyAssignment(n) && names.has(n.name.text)) props.add(n.name.text);                   // { ipcMain }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isAlias(n.right)) {
        if (ts.isIdentifier(n.left)) names.add(n.left.text);
        else if (ts.isPropertyAccessExpression(n.left)) props.add(n.left.name.text);                               // this.x = ipcMain
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { names, props };
}

const REGISTERING = new Set(['handle', 'handleOnce', 'on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

/** Every way of registering an Electron IPC listener, as `channel expression`: the five direct methods on ipcMain or any alias of it,
 *  `ipcMain['handle'](...)`, a registering method pulled off by destructuring or assignment (`const { handle } = ipcMain`, `const h = ipcMain.handle`). */
export function scanIpcRegistrations(file: string, text: string): string[] {
  if (!/ipc|IpcMain/i.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = ipcAliases(sf);
  const isIpc = (e: ts.Expression): boolean => (ts.isIdentifier(e) && aliases.names.has(e.text))
    || (ts.isPropertyAccessExpression(e) && (e.name.text === 'ipcMain' || aliases.props.has(e.name.text)))
    || (ts.isParenthesizedExpression(e) && isIpc(e.expression)) || (ts.isNonNullExpression(e) && isIpc(e.expression))
    || (ts.isAsExpression(e) && isIpc(e.expression));
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '';
      const recv = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
      if (recv && REGISTERING.has(method) && isIpc(recv) && n.arguments.length >= 2) out.push(n.arguments[0].getText(sf));
      // `ipcMain[m]('x:y', f)`: a method name chosen at run time can be any registering method.
      if (recv && ts.isElementAccessExpression(callee) && !ts.isStringLiteralLike(callee.argumentExpression) && isIpc(recv)) out.push('<computed method>');
      // `ipcMain.handle.bind(ipcMain)(...)`-style: a registering method detached then called.
      if (recv && ['bind', 'call', 'apply'].includes(method) && ts.isPropertyAccessExpression(recv) && REGISTERING.has(recv.name.text) && isIpc(recv.expression)) out.push(`<detached ${recv.name.text}>`);
    }
    // A registering method taken off without calling it: `const reg = ipcMain.handle`.
    if (ts.isPropertyAccessExpression(n) && REGISTERING.has(n.name.text) && isIpc(n.expression)
      && !(ts.isCallExpression(n.parent) && n.parent.expression === n)
      && !(ts.isPropertyAccessExpression(n.parent) && ['bind', 'call', 'apply'].includes(n.parent.name.text))) out.push(`<detached ${n.name.text}>`);
    // `const { handle } = ipcMain`.
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isIpc(n.initializer)
      && n.name.elements.some((el) => REGISTERING.has((el.propertyName ?? el.name).getText(sf)))) out.push('<destructured registering method>');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What a `case` label looks like when it names a channel: a string with a colon (`'x:y'`); anything that is not a plain literal (`IPC.X`, a
 *  template, a call, a computed expression); an identifier that holds such a string in this file (`const CH = 'x:y'; case CH:`); or an
 *  IMPORTED identifier (its value lives elsewhere, so it cannot be shown to be harmless). Numbers and local numeric/enum tags are not
 *  channels. */
function channelShapedLabel(e: ts.Expression, ctx: { strings: Map<string, string>; imported: Set<string> }): string | null {
  if (ts.isStringLiteralLike(e)) return e.text.includes(':') ? e.text : null;
  if (ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))) return null;
  if (ts.isIdentifier(e)) {
    const v = ctx.strings.get(e.text);
    if (v !== undefined) return v.includes(':') ? `<constant ${e.text} = ${v}>` : null;
    return ctx.imported.has(e.text) ? `<imported ${e.text}>` : null;
  }
  return `<computed ${e.getText().slice(0, 40)}>`;
}

/** Every channel-shaped `case` label in a file. `strict` (the phone dispatcher) also reports every non-string label, so `case IPC.X:`
 *  or `case CH:` there cannot hide a channel behind a constant. */
export function scanChannelCases(file: string, text: string, strict = false): string[] {
  if (!/\bcase\b/.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const ctx = { strings: new Map<string, string>(), imported: new Set<string>() };
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)) ctx.strings.set(n.name.text, n.initializer.text);
    if (ts.isImportSpecifier(n)) ctx.imported.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCaseClause(n)) {
      const label = strict ? (ts.isStringLiteralLike(n.expression) ? n.expression.text : `<computed ${n.expression.getText(sf).slice(0, 40)}>`) : channelShapedLabel(n.expression, ctx);
      if (label !== null) out.push(label);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');

// WHY the scan runs ONCE and is warmed in beforeAll under its own budget (test-suite-hygiene: a file's one-time cost never lands inside
// the first test): it parses every file of desktop/src/main (measured about 1 s on a quiet machine, over 30 s under full-suite load), and five tests read the result.
const SCAN_BUDGET_MS = 90_000;
let scanned: { registrations: string[]; cases: string[] } | null = null;
function scan() {
  if (scanned) return scanned;
  const registrations: string[] = [];
  const cases: string[] = [];
  for (const file of sources(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const isDoor = rel(file) === 'remote-server.ts';
    for (const c of scanIpcRegistrations(file, text)) registrations.push(`${rel(file)}: ${c}`);
    // The phone door's own labels are listed bare (that is how the exceptions name them); elsewhere with the file.
    for (const l of scanChannelCases(file, text, isDoor)) cases.push(isDoor ? l : `${rel(file)}: ${l}`);
  }
  return (scanned = { registrations: registrations.sort(), cases: cases.sort() });
}
beforeAll(() => { scan(); }, SCAN_BUDGET_MS);

/** Every Electron-registration in all of desktop/src/main, as `file: channel expression`. */
const ipcRegistrations = () => scan().registrations;

/** Every channel-shaped `case` label anywhere in desktop/src/main, as `label` for remote-server.ts (the phone door) and `file: label` elsewhere. */
const remoteCases = () => scan().cases;

// The exceptions, each with its reason. None is a feature: they are the door's own wiring or connection housekeeping.
const ALLOWED_REGISTRATIONS: Record<string, string> = {
  'ipc/channel-table.ts: def.name':
    'the computer door itself: the ONE place every table entry is registered with Electron',
  'ipc-handlers.ts: IPC.REMOTE_REHYDRATE':
    'connection housekeeping: preload\'s shape parity with the phone\'s Refresh button (the phone\'s Refresh is filled by session:open, one-core R5-2); a window IS the copy and says so here',
};
const ALLOWED_CASES: Record<string, string> = {
  'client:ready': 'connection housekeeping: the page is listening, so the host sends the session list, topic names and last status',
  'remote:ping': 'connection housekeeping: the phone\'s wake check',
  'remote:request-outcome': 'connection housekeeping: "did my action run?" for a request the phone sent before it lost its connection',
};

describe('no feature channel is served by hand-written code on either door', () => {
  it('the computer door registers only the table and its named exceptions', () => {
    expect(ipcRegistrations().filter((r) => !(r in ALLOWED_REGISTRATIONS))).toEqual([]);
  });

  it('the phone door has a `case` only for its named connection-housekeeping exceptions', () => {
    expect(remoteCases().filter((c) => !(c in ALLOWED_CASES))).toEqual([]);
  });

  it('every exception is still real, so the lists can only shrink', () => {
    expect(Object.keys(ALLOWED_REGISTRATIONS).filter((k) => !ipcRegistrations().includes(k))).toEqual([]);
    expect(Object.keys(ALLOWED_CASES).filter((c) => !remoteCases().includes(c))).toEqual([]);
  });

  it('an exception is never a channel that also has a table entry (the table would shadow or duplicate it)', () => {
    const inTable = new Set(CHANNEL_TABLE.map((d) => d.name));
    expect(Object.keys(ALLOWED_CASES).filter((c) => inTable.has(c))).toEqual([]);
  });

  it('the scan sees real registrations and cases, so an empty result cannot pass for the wrong reason', () => {
    expect(ipcRegistrations().length).toBeGreaterThanOrEqual(Object.keys(ALLOWED_REGISTRATIONS).length);
    expect(remoteCases().length).toBeGreaterThanOrEqual(Object.keys(ALLOWED_CASES).length);
    // The table is the one place features live: it holds the whole of what both doors serve.
    expect(CHANNEL_TABLE.length).toBeGreaterThan(400);
  });
});

// The scanners themselves, fed each way round the guard. Without these an evasion the scanner cannot see would pass silently.
describe('the scanners catch every way round the guard', () => {
  const regs = (code: string) => scanIpcRegistrations('x.ts', `import { ipcMain } from 'electron';\n${code}`);
  it('catches handle, on, once, handleOnce and addListener', () => {
    for (const m of ['handle', 'on', 'once', 'handleOnce', 'addListener']) expect(regs(`ipcMain.${m}('a:b', () => 1);`)).toEqual([`'a:b'`]);
  });
  it('catches an aliased ipcMain, including an alias of an alias and a typed parameter', () => {
    expect(regs(`const m = ipcMain; m.handle('a:b', f);`)).toEqual([`'a:b'`]);
    expect(regs(`const m = ipcMain; const n = m; n.on('a:b', f);`)).toEqual([`'a:b'`]);
    expect(regs(`function r(bus: IpcMain) { bus.handle('a:b', f); }`)).toEqual([`'a:b'`]);
    expect(regs(`ipcMain['handle']('a:b', f);`)).toEqual([`'a:b'`]);
  });
  it('catches a registering method taken off ipcMain', () => {
    expect(regs(`const { handle } = ipcMain; handle('a:b', f);`)).toEqual(['<destructured registering method>']);
    expect(regs(`const reg = ipcMain.handle; reg('a:b', f);`)).toEqual(['<detached handle>']);
    expect(regs(`ipcMain.handle.bind(ipcMain)('a:b', f);`)).toEqual(['<detached handle>']);
  });
  it('catches a property alias (this.x = ipcMain, { ipc: ipcMain }, a typed field or constructor property) and a computed method name', () => {
    expect(regs(`class A { go() { this.bus = ipcMain; this.bus.handle('a:b', f); } }`)).toEqual([`'a:b'`]);
    expect(regs(`const deps = { ipc: ipcMain }; deps.ipc.on('a:b', f);`)).toEqual([`'a:b'`]);
    expect(regs(`class A { private bus: IpcMain; go() { this.bus.once('a:b', f); } }`)).toEqual([`'a:b'`]);
    expect(regs(`class A { constructor(private bus: IpcMain) {} go() { this.bus.handle('a:b', f); } }`)).toEqual([`'a:b'`]);
    expect(regs(`const m = 'handle'; ipcMain[m]('a:b', f);`)).toEqual(['<computed method>']);
    expect(regs(`(ipcMain as any)[m]('a:b', f);`)).toEqual(['<computed method>']);
  });
  it('does not flag an unrelated object that happens to be called ipc or bus', () => {
    expect(regs(`const ipc = makeSocket(); ipc.on('data', f); this.bus.on('x', f);`)).toEqual([]);
  });
  it('catches an identifier case label that holds a channel string, or is imported, outside the phone door', () => {
    expect(scanChannelCases('x.ts', `const CH = 'a:b'; switch (t) { case CH: break; }`)).toEqual(['<constant CH = a:b>']);
    expect(scanChannelCases('x.ts', `import { CH } from './c'; switch (t) { case CH: break; }`)).toEqual(['<imported CH>']);
    expect(scanChannelCases('x.ts', `const T_BOOL = 7; switch (t) { case T_BOOL: break; }`)).toEqual([]);
  });
  it('does not flag cleanup or unrelated receivers', () => {
    expect(regs(`ipcMain.off('a:b', f); ipcMain.removeHandler('a:b'); emitter.on('x', f); window.on('closed', f);`)).toEqual([]);
  });
  it('catches a case that is not a string literal, a channel-shaped case anywhere, and a computed case in the phone door', () => {
    expect(scanChannelCases('x.ts', `switch (t) { case IPC.X: break; }`)).toEqual(['<computed IPC.X>']);
    expect(scanChannelCases('x.ts', ['switch (t) { case `a:$', '{b}`: break; }'].join(''))).toEqual([expect.stringContaining('<computed')]);
    expect(scanChannelCases('x.ts', `switch (t) { case 'a:b': break; case 'plain': break; case 3: break; case T_BOOL: break; }`)).toEqual(['a:b']);
    expect(scanChannelCases('remote-server.ts', `switch (t) { case CH: break; case 'x:y': break; }`, true)).toEqual(['<computed CH>', 'x:y']);
  });
});
