// Enforced BY STRUCTURE: this folder has no way to write key material, codes or frame bodies
// anywhere. (1) No source file may use a logging/printing/inspection call, a file/network/process
// module, or Math.random. (2) Errors carry only a fixed code and field name, never data.
// Any of these needs a deliberate edit to THIS test, which is the point.
import { readdirSync, readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameReceiver, FrameSender } from './frames';
import { generateIdentity, parseIdentity, setIdFor } from './identity';
import { newSetSecret } from './keys';
import { Existing, NewDevice, normalizeCode, type PairingSuccess } from './pairing';
import { CPace } from './cpace';
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

describe('secret-bearing objects print nothing secret', () => {
  const forms = (o: unknown): string[] => [
    JSON.stringify(o),
    inspect(o, { showHidden: true, depth: 10, getters: true }),
    // customInspect:false + showHidden lists accessor NAMES (as "[signSeed]: [Getter]") but not their values; a caller
    // that also passes getters:true is deliberately evaluating the accessors, exactly as if it called them.
    inspect(o, { customInspect: false, showHidden: true, depth: 10 }),
    String(o),
    `${o as string}`,
    JSON.stringify({ wrapped: [o] }),
    inspect({ wrapped: [o] }, { depth: 10, showHidden: true }),
  ];
  // Every way a byte string could show up in text: hex, base64, base64url, utf8 text, and node's spaced byte dump.
  const spellings = (b: Uint8Array): string[] => {
    const buf = Buffer.from(b);
    return [buf.toString('hex'), buf.toString('base64'), buf.toString('base64url'), buf.toString('latin1'), [...buf.subarray(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join(' ')];
  };
  // JSON of a Buffer is {"type":"Buffer","data":[1,2,...]} and inspect of one lists decimals: look for the first 6 bytes as decimals too.
  const decimals = (b: Uint8Array): RegExp => new RegExp([...Buffer.from(b).subarray(0, 6)].join('[,\\s]+'));
  const expectClean = (o: unknown, secrets: Uint8Array[]): void => {
    for (const text of forms(o)) for (const s of secrets) {
      for (const sp of spellings(s)) expect(text).not.toContain(sp);
      expect(text).not.toMatch(decimals(s));
    }
  };
  it('a device identity: its seed and agreement secret never show through JSON, inspect, toString or a wrapping object', () => {
    const id = generateIdentity();
    expectClean(id, [id.signSeed, id.agreeSecret]);
    expect(String(id)).toContain(id.deviceId.toString('hex')); // the public id is fine to show
    expect(Object.keys(id)).toEqual([]);
  });
  it('a CPace party never prints its scalar or the code', () => {
    const y = randomBytes(32);
    const prs = Buffer.from('K7QD4M');
    const cp = new CPace({ prs, ci: Buffer.from('ci'), sid: randomBytes(16), role: 'initiator', scalar: y });
    expectClean(cp, [y, prs]);
  });
  it('an invite, the existing device and the new device never print the code, the QR secret or the set secret', () => {
    const A = generateIdentity();
    const S = newSetSecret();
    const E = new Existing(A, { setId: setIdFor(A.signKey), secrets: new Map([[1, S as Uint8Array]]), roster: [makeGenesisEntry(A, 'D', 'linux', 1)] }, { onAddPrompt: () => true });
    const qr = E.openInvite('qr');
    const NI = generateIdentity();
    const N = new NewDevice(NI, { room: qr.room, secret: qr.secret }, 'qr', { name: 'p', platform: 'x' });
    N.start();
    for (const o of [qr, E, N]) expectClean(o, [qr.secret, S, A.signSeed, A.agreeSecret, NI.signSeed, NI.agreeSecret]);
    const code = E.openInvite('code');
    expect(code.code).toMatch(/^[2-9A-Z]{6}$/); // the caller can still read it deliberately
    for (const o of [code, E]) for (const text of forms(o)) expect(text).not.toContain(code.code as string);
  });
  it('a successful pairing result never prints the set secret or the new device secrets', () => {
    const A = generateIdentity();
    const S = newSetSecret();
    const E = new Existing(A, { setId: setIdFor(A.signKey), secrets: new Map([[1, S as Uint8Array]]), roster: [makeGenesisEntry(A, 'D', 'linux', 1)] }, { onAddPrompt: () => true });
    const inv = E.openInvite('code');
    const NI = generateIdentity();
    const N = new NewDevice(NI, { room: inv.room, secret: inv.secret }, 'code', { name: 'p', platform: 'x' });
    let msgs: Buffer[] = [N.start()];
    for (let i = 0; i < 12 && msgs.length; i++) {
      const next: Buffer[] = [];
      for (const m of msgs) for (const r of E.onMessage('c', m)) next.push(...N.onMessage(r));
      msgs = next;
    }
    const res = N.result as PairingSuccess;
    expect(res.ok).toBe(true);
    expect(res.secrets.get(1)?.equals(Buffer.from(S))).toBe(true); // readable on purpose
    expectClean(res, [S, NI.signSeed, NI.agreeSecret]);
    expectClean(N, [S, NI.signSeed, NI.agreeSecret]);
  });
});
