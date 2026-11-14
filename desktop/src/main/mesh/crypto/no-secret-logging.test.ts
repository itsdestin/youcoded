// Enforced BY STRUCTURE: this folder has no way to write key material, codes or frame bodies
// anywhere. (1) No source file may use a logging/printing/inspection call, a file/network/process
// module, or Math.random. (2) Errors carry only a fixed code and field name, never data.
// Any of these needs a deliberate edit to THIS test, which is the point.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameReceiver, FrameSender } from './frames';
import { generateIdentity, parseIdentity, setIdFor } from './identity';
import { newSetSecret } from './keys';
import { Existing, NewDevice, normalizeCode } from './pairing';
import { makeGenesisEntry } from './roster';
import { MeshCryptoError } from './errors';
import { hpkeOpenSealed } from './hpke';
import { decode } from './cbor';

const dir = __dirname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ f, text: readFileSync(path.join(dir, f), 'utf8') }));
// Strip comments so prose that MENTIONS "console." does not trip the scan, but real calls do.
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the crypto folder cannot log, print, store or send anything', () => {
  it('finds the source files (guards against a vacuous scan)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(14);
  });
  const banned: [string, RegExp][] = [
    ['console.*', /\bconsole\s*\./],
    ['logger / log( calls', /\b(logger|log|logging|debug|trace|warn)\s*\.\s*\w+\s*\(|\b(log|debugLog|logger)\s*\(/],
    ['process.stdout/stderr', /process\s*\.\s*(stdout|stderr)/],
    ['util.inspect / debugger', /\binspect\s*\(|\bdebugger\b/],
    ['file/network/process modules', /from\s+['"](node:)?(fs|fs\/promises|net|http|https|http2|dgram|tls|child_process|worker_threads|cluster|os|electron|ws)['"]|require\(\s*['"](node:)?(fs|net|http|https|child_process|electron)['"]/],
    ['Math.random (not a CSPRNG)', /Math\s*\.\s*random/],
    ['fetch / WebSocket', /\bfetch\s*\(|\bWebSocket\b|XMLHttpRequest/],
  ];
  for (const [name, re] of banned) {
    it(`no ${name}`, () => {
      const hits = sources.filter((s) => re.test(code(s.text))).map((s) => s.f);
      expect(hits).toEqual([]);
    });
  }
  it('the only crypto module imports are node:crypto and @noble/curves', () => {
    const imports = new Set<string>();
    for (const s of sources) for (const m of code(s.text).matchAll(/from\s+'([^']+)'/g)) if (!m[1].startsWith('.')) imports.add(m[1]);
    expect([...imports].sort()).toEqual(['@noble/curves/ed25519.js', 'node:crypto']);
  });
});

describe('error text never carries secrets, codes or bodies', () => {
  const A = generateIdentity();
  const setId = setIdFor(A.signKey);
  const S = newSetSecret();
  const marker = 'SUPERSECRETBODYTEXT';
  const everything = (e: unknown): string => (e instanceof Error ? e.message + (e.stack ?? '') : String(e));
  const hexes = (b: Uint8Array): string[] => [Buffer.from(b).toString('hex'), Buffer.from(b).toString('base64')];

  function captured(f: () => unknown): string {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(MeshCryptoError);
      return everything(e);
    }
    throw new Error('expected a throw');
  }
  it('frame rejections', () => {
    const wire = new FrameSender({ identity: A, setId }).seal({ secret: S, gen: 1, group: 'g', kind: 'k', body: { marker } });
    const bad = Buffer.from(wire);
    bad[bad.length - 2] ^= 1;
    const wrongSecret = newSetSecret();
    const rx = (secret: Uint8Array) => new FrameReceiver({ setId, secretFor: () => secret, signKeyFor: () => A.signKey });
    const texts = [captured(() => rx(S).open(bad)), captured(() => rx(wrongSecret).open(wire)), captured(() => rx(S).open(Buffer.from('zz')))];
    for (const t of texts) {
      expect(t).not.toContain(marker);
      for (const secret of [S, wrongSecret, A.signSeed, A.agreeSecret]) for (const h of hexes(secret)) expect(t).not.toContain(h);
    }
  });
  it('identity, hpke, cbor and code rejections', () => {
    const texts = [captured(() => parseIdentity(Buffer.from('a0', 'hex'))), captured(() => hpkeOpenSealed(A.agreeSecret, Buffer.alloc(60), Buffer.alloc(0), Buffer.alloc(0))), captured(() => decode(Buffer.from('1800', 'hex'))), captured(() => normalizeCode('K7QD40'))];
    for (const t of texts) {
      expect(t).not.toContain('K7QD40');
      for (const h of hexes(A.agreeSecret)) expect(t).not.toContain(h);
    }
  });
  it('a pairing that fails reveals no code or secret in anything it returns', () => {
    const state = { setId, secrets: new Map([[1, S as Uint8Array]]), roster: [makeGenesisEntry(A, 'D', 'linux', 1)] };
    const E = new Existing(A, state, { onAddPrompt: () => true });
    const inv = E.openInvite('code');
    const N = new NewDevice(generateIdentity(), { room: inv.room, secret: Buffer.from('AAAAAA') }, 'code', { name: 'p', platform: 'x' });
    const out: Buffer[] = [];
    let msgs: Buffer[] = [N.start()];
    for (let i = 0; i < 6 && msgs.length; i++) {
      const next: Buffer[] = [];
      for (const m of msgs) for (const r of E.onMessage('c', m)) { out.push(r); next.push(...N.onMessage(r)); }
      msgs = next;
    }
    const all = Buffer.concat(out).toString('latin1') + JSON.stringify(N.result) + E.events.join(',');
    expect(all).not.toContain(inv.code as string);
    expect(all).not.toContain(Buffer.from(S).toString('latin1'));
    expect(E.events.join(',')).not.toContain(inv.code as string);
  });
});
