// The desktop wire and the phone wire carry the SAME payload object for a channel (one-core R2).
//
// WHY: until R2 preload.ts passed positional arguments (ipcRenderer.invoke(ch, a, b)) while
// remote-shim.ts sent one object ({ a, b }); the two could never share a handler, and two
// same-typed positionals could be swapped without the compiler noticing. Preload now sends the
// object the shim sends. This reads both files as code (not text) and compares, per channel, the
// object KEYS each side writes, so a key renamed on one side fails here instead of shipping as a
// handler that quietly reads `undefined`.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { IPC } from '../src/shared/backend-contract';
import { readSource } from './helpers/guard-scope';

const root = path.join(__dirname, '..');
const byValue = new Map<string, string>(Object.entries(IPC).map(([k, v]) => [k, v as string]));

// WHY (2026-09-29 one-core R2 review): channels registered through the submodule constant maps
// (ARTIFACT_IPC, GIT_IPC, PROJECT_IPC, CHATSEARCH_IPC, DOC_COMMENTS_IPC) and file-local string
// constants (voice-handlers.ts's AUDIO_CHANNEL) used to be recognised on the handler side only, and
// an unrecognised channel was skipped SILENTLY, so the riskiest shapes could lose their guard with
// no red. ONE resolver now serves preload, shim and handlers, and a handler that takes an object
// but whose channel cannot be resolved fails the run (see `unresolved` below). The maps stay the
// single source of names (they live beside their handlers); nothing is duplicated into the contract.
/** Constant objects such as ARTIFACT_IPC that hold channel names outside the shared contract. */
function localChannelConstants(): Map<string, string> {
  const out = new Map<string, string>();
  const dirs = ['artifacts', 'git', 'project', 'doc-comments', 'chatsearch-index'];
  for (const d of dirs) {
    const f = path.join(root, 'src', 'main', d, 'ipc-channels.ts');
    if (!fs.existsSync(f)) continue;
    const src = readSource(f);
    for (const blk of src.matchAll(/export const (\w+_IPC) = \{([\s\S]*?)\n\}/g)) {
      for (const m of blk[2].matchAll(/^\s*(\w+)\s*:\s*['"]([^'"]+)['"]/gm)) out.set(`${blk[1]}.${m[1]}`, m[2]);
    }
  }
  return out;
}
const localConsts = localChannelConstants();

/** Top-level `const NAME = 'literal'` in one file (voice-handlers.ts: `const AUDIO_CHANNEL = 'voice:audio'`). */
function fileStringConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteral(d.initializer)) out.set(d.name.text, d.initializer.text);
    }
  }
  return out;
}

/** The channel name an expression stands for, or undefined when it is not statically resolvable. */
function resolveChannel(c: ts.Expression, sf: ts.SourceFile, fileConsts: Map<string, string>): string | undefined {
  if (ts.isStringLiteral(c) || ts.isNoSubstitutionTemplateLiteral(c)) return c.text;
  if (ts.isIdentifier(c)) return fileConsts.get(c.text);
  if (ts.isPropertyAccessExpression(c)) {
    const t = c.getText(sf);
    return t.startsWith('IPC.') ? byValue.get(c.name.text) : localConsts.get(t);
  }
  return undefined;
}

/** channel -> the set of keys of the payload OBJECT LITERAL some call passes (spreads/ternaries skipped). */
function payloadKeys(file: string, callee: (e: ts.Expression) => boolean): Map<string, Set<string>[]> {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Set<string>[]>();
  const fileConsts = fileStringConsts(sf);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && callee(n.expression) && n.arguments.length >= 2) {
      const [c, p] = n.arguments;
      const ch = resolveChannel(c, sf, fileConsts);
      if (ch && ts.isObjectLiteralExpression(p)) {
        const keys = new Set<string>();
        for (const prop of p.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) keys.add(prop.name.text);
          else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) keys.add(prop.name.text);
        }
        (out.get(ch) ?? out.set(ch, []).get(ch)!).push(keys);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const preload = payloadKeys('src/main/preload.ts', (e) =>
  ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'ipcRenderer' && ['invoke', 'send'].includes(e.name.text));
const shim = payloadKeys('src/renderer/remote-shim.ts', (e) => ts.isIdentifier(e) && ['invoke', 'fire'].includes(e.text));

describe('preload and remote-shim send the same object keys for a channel', () => {
  it('parsed a meaningful number of channels on both sides', () => {
    expect(preload.size).toBeGreaterThan(150);
    expect(shim.size).toBeGreaterThan(150);
  });

  it('every channel both sides send as an object uses the same keys', () => {
    const different: string[] = [];
    let compared = 0;
    for (const [ch, pSets] of preload) {
      const sSets = shim.get(ch);
      if (!sSets) continue;
      compared++;
      const p = [...pSets[0]].sort().join(',');
      if (!sSets.some((s) => [...s].sort().join(',') === p)) {
        different.push(`${ch}: preload {${p}} vs shim ${sSets.map((s) => `{${[...s].sort().join(',')}}`).join(' | ')}`);
      }
    }
    // Not vacuous: a parse that stopped matching would compare nothing and pass.
    expect(compared).toBeGreaterThan(120);
    expect(different).toEqual([]);
  });
});

// ── The handler side ───────────────────────────────────────────────────────────
// The other half of the same drift: preload sends { sessionId, text } but the handler destructures
// { sessionId, message } and gets `message === undefined` with no error anywhere.

// WHY (2026-09-30 one-core R3-7): a family moved into the channel table has no `ipcMain.handle` call left to scan,
// so the table's own entries are scanned too: `defineChannel({ name: IPC.X, handler: ({ a, b }, ctx) => ... })`
// reads its keys from the FIRST parameter (an ipcMain handler's first is the event). Without this the scan shrinks to
// nothing as the last family moves, and the check that a handler reads the keys preload sends would silently stop
// covering the very channels the table now serves.
/** Keys a handler reads that the PHONE DOOR sets itself (an entry's `remotePayload`), so preload never sends them.
 *  WHY per channel (2026-10-01 one-core R3-8, R3-7 review): the exemption used to cover these two names for EVERY
 *  channel, so a handler on any other channel that misspelled into `maxBytes` would have passed. Now only the three
 *  entries whose remotePayload sets the key are exempt, and only for that key. */
const DOOR_SET_KEYS = new Map<string, Set<string>>([
  ['artifacts:resolve-path', new Set(['trackedOnly'])],
  ['artifacts:get', new Set(['maxBytes'])],
  ['artifacts:read-binary', new Set(['maxBytes'])],
]);

function tableHandlerKeys(): { keys: Map<string, Set<string>>; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = new Map<string, Set<string>>();
  const dir = path.join(root, 'src', 'main', 'ipc');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const file = path.join(dir, name);
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('defineChannel')) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'defineChannel' && n.arguments.length === 1 && ts.isObjectLiteralExpression(n.arguments[0])) {
        const props = n.arguments[0].properties;
        const nameProp = props.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'name');
        const handler = props.find((p) => p.name?.getText(sf) === 'handler');
        const fn = handler && ts.isPropertyAssignment(handler) ? handler.initializer : handler && ts.isMethodDeclaration(handler) ? handler : undefined;
        const ch = nameProp ? resolveChannel(nameProp.initializer, sf, fileStringConsts(sf)) : undefined;
        if (nameProp && !ch) unresolved.push(`${path.relative(root, file)}: ${nameProp.initializer.getText(sf)}`);
        const p0 = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) ? fn.parameters[0] : undefined;
        if (ch && p0 && ts.isObjectBindingPattern(p0.name)) {
          const set = out.get(ch) ?? out.set(ch, new Set()).get(ch)!;
          for (const el of p0.name.elements) {
            if (el.dotDotDotToken) continue;
            const key = el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf);
            if (!DOOR_SET_KEYS.get(ch)?.has(key)) set.add(key);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { keys: out, unresolved };
}

function handlerKeys(): { keys: Map<string, Set<string>>; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = new Map<string, Set<string>>();
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
  for (const file of walk(path.join(root, 'src', 'main'))) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('ipcMain')) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const fileConsts = fileStringConsts(sf);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['handle', 'on'].includes(n.expression.name.text)
        && n.expression.expression.getText(sf).endsWith('ipcMain') && n.arguments.length >= 2) {
        const [c, fn] = n.arguments;
        const ch = resolveChannel(c, sf, fileConsts);
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const p = fn.parameters[1];
          // An object-taking handler whose channel we cannot name is a guard silently lost.
          if (!ch && p && ts.isObjectBindingPattern(p.name)) unresolved.push(`${path.relative(root, file)}: ${c.getText(sf)}`);
          if (!ch) { ts.forEachChild(n, visit); return; }
          if (p && ts.isObjectBindingPattern(p.name)) {
            const keys = new Set<string>();
            for (const el of p.name.elements) {
              if (el.dotDotDotToken) continue;
              keys.add(el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf));
            }
            (out.get(ch) ?? out.set(ch, new Set()).get(ch)!);
            for (const k of keys) out.get(ch)!.add(k);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { keys: out, unresolved };
}

describe('the desktop handler reads the keys preload sends', () => {
  it('every key a handler destructures is a key preload writes for that channel', () => {
    const direct = handlerKeys();
    const table = tableHandlerKeys();
    const handlers = new Map(direct.keys);
    for (const [ch, ks] of table.keys) handlers.set(ch, new Set([...(handlers.get(ch) ?? []), ...ks]));
    const unresolved = [...direct.unresolved, ...table.unresolved];
    expect(unresolved).toEqual([]);
    let compared = 0;
    const wrong: string[] = [];
    for (const [ch, hk] of handlers) {
      const pSets = preload.get(ch);
      if (!pSets) continue;
      compared++;
      const sent = new Set(pSets.flatMap((s) => [...s]));
      const missing = [...hk].filter((k) => !sent.has(k));
      if (missing.length) wrong.push(`${ch}: handler reads {${missing.join(',')}} but preload sends {${[...sent].join(',')}}`);
    }
    // WHY a ratio, not a floor (2026-09-30 one-core R3-6, R3-5 review): each family moved into the channel table
    // leaves this scan (its handlers are typed against ChannelTypes by the compiler instead), so any fixed floor
    // had to be lowered by hand every run. What must hold at ANY size is that the scan finds handlers at all
    // and that nearly every one it finds is a channel preload also sends; a parse that stopped matching either
    // side drops that share to 0 and fails. (Handlers preload never sends are desktop-internal: window,
    // dialog and the like, a small minority.)
    // WHY the table scan carries the floor (2026-09-30 one-core R3-7, R3-6 review): `handlers.size > 0` held only while
    // some ipcMain handler still took an object; once every family is in the table that scan finds nothing and the
    // check failed for the wrong reason. The table only ever GROWS, so a floor on ITS entries never needs lowering,
    // and a parse that stopped matching them (the real failure) still drops it to 0 and fails.
    expect(table.keys.size, 'the scan found no channel-table handlers that read keys').toBeGreaterThan(100);
    expect(compared / handlers.size).toBeGreaterThanOrEqual(0.8);
    // Not vacuous for the riskiest shapes: each constant-map family (and the voice audio channel,
    // named by a file-local constant) must actually be reaching the comparison.
    const seen = [...handlers.keys()].filter((k) => preload.has(k));
    // WHY (2026-09-30 one-core R3-7): artifacts, git and project are table entries now (scanned through their entries); the
    // chatsearch handlers read `p?.key` rather than destructuring, so they have no keys to compare.
    for (const prefix of ['artifacts:', 'git:', 'project:', 'voice:audio']) {
      expect(seen.some((k) => k.startsWith(prefix)), `no ${prefix} channel was compared`).toBe(true);
    }
    expect(wrong).toEqual([]);
  });
});

