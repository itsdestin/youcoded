// The end of the move into the channel table: NO feature channel is served by hand-written code on either door.
//
// WHY this exists: the table is only the one place a feature lives if nothing else is allowed to grow beside it. A
// stray `ipcMain.handle` / `ipcMain.on` for the computer's windows, or a `case '<feature>:...'` in the phone's switch in
// remote-server.ts, would be a second copy of a feature that drifts from the table's (the exact problem the move fixed).
// This reads the source as code and fails on either, except for the few named, reasoned exceptions below; every
// exception must still exist, so the list can only shrink.
import { describe, it, expect } from 'vitest';
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

/** Names that stand for the Electron ipcMain object in this file: `ipcMain`/`ipc`, a parameter typed `IpcMain…`, and anything assigned from an alias. */
function ipcAliases(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>(['ipcMain', 'ipc']);
  const isAlias = (e: ts.Expression | undefined): boolean => !!e && ((ts.isIdentifier(e) && names.has(e.text))
    || (ts.isPropertyAccessExpression(e) && e.name.text === 'ipcMain')
    || (ts.isParenthesizedExpression(e) && isAlias(e.expression)) || (ts.isAsExpression(e) && isAlias(e.expression)));
  // Two passes so `const a = ipcMain; const b = a;` resolves whatever order they are written in.
  for (let pass = 0; pass < 2; pass++) {
    const visit = (n: ts.Node) => {
      if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && /\bIpcMain\w*\b/.test(n.type.getText(sf))) names.add(n.name.text);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isAlias(n.initializer)) names.add(n.name.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isAlias(n.right)) names.add(n.left.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return names;
}

const REGISTERING = new Set(['handle', 'handleOnce', 'on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

/** Every way of registering an Electron IPC listener, as `channel expression`: the five direct methods on ipcMain or any alias of it,
 *  `ipcMain['handle'](...)`, a registering method pulled off by destructuring or assignment (`const { handle } = ipcMain`, `const h = ipcMain.handle`). */
export function scanIpcRegistrations(file: string, text: string): string[] {
  if (!/ipc|IpcMain/i.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = ipcAliases(sf);
  const isIpc = (e: ts.Expression): boolean => (ts.isIdentifier(e) && aliases.has(e.text))
    || (ts.isPropertyAccessExpression(e) && e.name.text === 'ipcMain') || (ts.isParenthesizedExpression(e) && isIpc(e.expression));
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '';
      const recv = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
      if (recv && REGISTERING.has(method) && isIpc(recv) && n.arguments.length >= 2) out.push(n.arguments[0].getText(sf));
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

/** What a `case` label looks like when it names a channel: a string with a colon (`'x:y'`), or anything that is not a plain literal and
 *  not a bare constant (`IPC.X`, a template, a call, a computed expression). Numbers and bare identifiers (enum/numeric tags) are not channels. */
function channelShapedLabel(e: ts.Expression): string | null {
  if (ts.isStringLiteralLike(e)) return e.text.includes(':') ? e.text : null;
  if (ts.isNumericLiteral(e) || ts.isIdentifier(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))) return null;
  return `<computed ${e.getText().slice(0, 40)}>`;
}

/** Every channel-shaped `case` label in a file. `strict` (the phone dispatcher) also reports every non-string label, so `case IPC.X:`
 *  or `case CH:` there cannot hide a channel behind a constant. */
export function scanChannelCases(file: string, text: string, strict = false): string[] {
  if (!/\bcase\b/.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCaseClause(n)) {
      const label = strict ? (ts.isStringLiteralLike(n.expression) ? n.expression.text : `<computed ${n.expression.getText(sf).slice(0, 40)}>`) : channelShapedLabel(n.expression);
      if (label !== null) out.push(label);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');

/** Every Electron-registration in all of desktop/src/main, as `file: channel expression`. */
function ipcRegistrations(): string[] {
  return sources(root).flatMap((file) => scanIpcRegistrations(file, fs.readFileSync(file, 'utf8')).map((c) => `${rel(file)}: ${c}`)).sort();
}

/** Every channel-shaped `case` label anywhere in desktop/src/main, as `label` for remote-server.ts (the phone door) and `file: label` elsewhere. */
function remoteCases(): string[] {
  return sources(root).flatMap((file) => {
    const isDoor = rel(file) === 'remote-server.ts';
    return scanChannelCases(file, fs.readFileSync(file, 'utf8'), isDoor).map((l) => (isDoor ? l : `${rel(file)}: ${l}`));
  }).sort();
}

// The exceptions, each with its reason. None is a feature: they are the door's own wiring or connection housekeeping.
const ALLOWED_REGISTRATIONS: Record<string, string> = {
  'ipc/channel-table.ts: def.name':
    'the computer door itself: the ONE place every table entry is registered with Electron',
  'chat-snapshot.ts: RESPONSE_CHANNEL':
    'a private reply listener for the chat snapshot main asks a window for (a request/answer pair between main and one renderer, not a feature a caller invokes)',
  'ipc-handlers.ts: IPC.REMOTE_REHYDRATE':
    'connection housekeeping: the phone\'s refresh of its own copy is answered in remote-server.ts; a window IS the copy and says so here. It cannot be a table entry, because the table is consulted first and would swallow the phone\'s',
};
const ALLOWED_CASES: Record<string, string> = {
  'client:ready': 'connection housekeeping: starts a phone\'s catch-up sequence',
  'remote:ping': 'connection housekeeping: the phone\'s wake check, answered in every phase',
  'remote:rehydrate': 'connection housekeeping: re-sends a phone\'s copy of the conversation (see the desktop half above)',
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
  it('does not flag cleanup or unrelated receivers', () => {
    expect(regs(`ipcMain.off('a:b', f); ipcMain.removeHandler('a:b'); emitter.on('x', f); window.on('closed', f);`)).toEqual([]);
  });
  it('catches a case that is not a string literal, a channel-shaped case anywhere, and a computed case in the phone door', () => {
    expect(scanChannelCases('x.ts', `switch (t) { case IPC.X: break; }`)).toEqual(['<computed IPC.X>']);
    expect(scanChannelCases('x.ts', 'switch (t) { case `a:${b}`: break; }')).toEqual([expect.stringContaining('<computed')]);
    expect(scanChannelCases('x.ts', `switch (t) { case 'a:b': break; case 'plain': break; case 3: break; case T_BOOL: break; }`)).toEqual(['a:b']);
    expect(scanChannelCases('remote-server.ts', `switch (t) { case CH: break; case 'x:y': break; }`, true)).toEqual(['<computed CH>', 'x:y']);
  });
});
