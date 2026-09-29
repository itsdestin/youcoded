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

/** channel -> the set of keys of the payload OBJECT LITERAL some call passes (spreads/ternaries skipped). */
function payloadKeys(file: string, callee: (e: ts.Expression) => boolean): Map<string, Set<string>[]> {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Set<string>[]>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && callee(n.expression) && n.arguments.length >= 2) {
      const [c, p] = n.arguments;
      let ch: string | undefined;
      if (ts.isStringLiteral(c)) ch = c.text;
      else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'IPC') ch = byValue.get(c.name.text);
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

function handlerKeys(): Map<string, Set<string>> {
  const local = localChannelConstants();
  const out = new Map<string, Set<string>>();
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
  for (const file of walk(path.join(root, 'src', 'main'))) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('ipcMain')) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['handle', 'on'].includes(n.expression.name.text)
        && n.expression.expression.getText(sf).endsWith('ipcMain') && n.arguments.length >= 2) {
        const [c, fn] = n.arguments;
        let ch: string | undefined;
        if (ts.isStringLiteral(c)) ch = c.text;
        else if (ts.isPropertyAccessExpression(c)) {
          const t = c.getText(sf);
          ch = t.startsWith('IPC.') ? byValue.get(c.name.text) : local.get(t);
        }
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ch) {
          const p = fn.parameters[1];
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
  return out;
}

describe('the desktop handler reads the keys preload sends', () => {
  it('every key a handler destructures is a key preload writes for that channel', () => {
    const handlers = handlerKeys();
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
    expect(compared).toBeGreaterThan(120);
    expect(wrong).toEqual([]);
  });
});

