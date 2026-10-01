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

/** Every `ipcMain.handle/on/once(...)` call (or the same call on any receiver ending in `ipcMain`/`ipc`), as `file: channel expression`. */
function ipcRegistrations(): string[] {
  const out: string[] = [];
  for (const file of sources(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/\.(handle|on|once)\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['handle', 'on', 'once'].includes(n.expression.name.text)
        && /(^|\.)(ipcMain|ipc)$/.test(n.expression.expression.getText(sf)) && n.arguments.length >= 2) {
        out.push(`${path.relative(root, file).split(path.sep).join('/')}: ${n.arguments[0].getText(sf)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out.sort();
}

/** Every string `case '<channel>':` label in the phone door's switch. */
function remoteCases(): string[] {
  const file = path.join(root, 'remote-server.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCaseClause(n) && ts.isStringLiteralLike(n.expression)) out.push(n.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.sort();
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
