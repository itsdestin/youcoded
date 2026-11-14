// Pairing over a hostile in-memory pipe. Ported from the T5 prototype's run-pairing.mjs scenarios
// (the pipe sees every message and may read, drop, replay, reorder and inject; E counts failures;
// nothing else is trusted), plus the cases the T5 gap list adds. The prototype's Monte Carlo and
// timing runs are research output, not regression checks, and are not ported.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH, Existing, INVITE_LIFETIME_MS, MAX_CONNECTIONS, MAX_FAILURES, MAX_MESSAGE_BYTES, MIN_ROOM_BYTES, NewDevice, PROMPT_LIFETIME_MS, generateCode, normalizeCode, shortAuthString, type AddPromptInfo, type ExistingState, type Invite, type PairingSuccess } from './pairing';
import { CPace } from './cpace';
import { decode, encode } from './cbor';
import { FrameReceiver, FrameSender } from './frames';
import { generateIdentity, setIdFor, type DeviceIdentity } from './identity';
import { LABEL, sha256, toHex } from './bytes';
import { makeGenesisEntry } from './roster';
import { newSetSecret } from './keys';
import { MeshCryptoError } from './errors';

const tOf = (b: Uint8Array): string => {
  try {
    return String((decode(b) as { t: string }).t);
  } catch {
    return '?';
  }
};

interface Item { dir: 'N2E' | 'E2N'; conn: string; bytes: Buffer }
interface Adv { mangle?: (item: Item, ctx: { q: Item[] }) => Item[] }

function makeSet(opts: { approve?: boolean | undefined; now?: () => number } = {}) {
  const id = generateIdentity();
  const setId = setIdFor(id.signKey);
  const state: ExistingState = { setId, secrets: new Map([[1, newSetSecret()]]), roster: [makeGenesisEntry(id, 'Desktop', 'linux', 1)] };
  const prompts: AddPromptInfo[] = [];
  const added: unknown[] = [];
  const E = new Existing(id, state, {
    onAddPrompt: (info) => {
      prompts.push(info);
      return 'approve' in opts ? opts.approve : true;
    },
    onAdded: (e) => added.push(e),
    now: opts.now,
  });
  return { id, state, E, prompts, added };
}
const newDev = (inv: Pick<Invite, 'room' | 'secret' | 'fingerprint'>, mode: 'qr' | 'code', name = 'Phone', withFp = false) =>
  new NewDevice(generateIdentity(), { room: inv.room, secret: inv.secret, fingerprint: withFp ? inv.fingerprint : undefined }, mode, { name, platform: 'android' });

/** Run N against E through a pipe. */
function pipeRun(E: Existing, N: NewDevice, adv: Adv = {}): Item[] {
  const log: Item[] = [];
  const q: Item[] = [{ dir: 'N2E', conn: 'n1', bytes: N.start() }];
  for (let steps = 0; q.length && steps < 200; steps++) {
    const item = q.shift() as Item;
    log.push(item);
    const deliver = adv.mangle ? adv.mangle(item, { q }) : [item];
    for (const d of deliver) {
      if (d.dir === 'N2E') for (const r of E.onMessage(d.conn, d.bytes)) q.push({ dir: 'E2N', conn: d.conn, bytes: r });
      else if (d.conn === 'n1') for (const r of N.onMessage(d.bytes)) q.push({ dir: 'N2E', conn: 'n1', bytes: r });
    }
  }
  return log;
}
/** The pipe-only attacker plays N itself against E with a guessed secret. */
function attacker(E: Existing, inv: Invite, guess: string, tag: string, mode: 'qr' | 'code' = 'code'): NewDevice {
  const A = newDev({ room: inv.room, secret: Buffer.from(guess), fingerprint: inv.fingerprint }, mode, 'attacker');
  let msgs: Buffer[] = [A.start()];
  for (let i = 0; i < 10 && msgs.length; i++) {
    const next: Buffer[] = [];
    for (const m of msgs) for (const r of E.onMessage(tag, m)) next.push(...A.onMessage(r));
    msgs = next;
  }
  return A;
}
const wrongCode = (not: string): string => {
  for (;;) {
    const c = generateCode();
    if (c !== not) return c;
  }
};

describe('typed code, honest devices, a recording pipe', () => {
  const { E, state, prompts, added, id } = makeSet();
  const inv = E.openInvite('code');
  const N = newDev(inv, 'code', 'Phone');
  const log = pipeRun(E, N);
  it('completes; both sides show the same matching number', () => {
    expect(N.result?.ok).toBe(true);
    if (!N.result?.ok) return;
    expect(N.result.sas).toBe(prompts[0].sas);
    expect(N.result.sas).toMatch(/^\d{4}$/);
  });
  it('key confirmation happens BEFORE "Add this device?"; the name appears only then', () => {
    expect(E.events).toEqual(['pake1', 'confirm-ok', 'prompt', 'welcome-sent']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe('Phone');
  });
  it('the set secret, signed roster and a first real frame arrive', () => {
    if (!N.result?.ok) throw new Error('not paired');
    const paired: PairingSuccess = N.result;
    expect(paired.existing.deviceId).toEqual(id.deviceId);
    expect(N.result.secrets.get(1)?.equals(Buffer.from(state.secrets.get(1) as Uint8Array))).toBe(true);
    expect(N.result.roster).toHaveLength(2);
    expect(added).toHaveLength(1);
    const sender = new FrameSender({ identity: id, setId: state.setId });
    const wire = sender.seal({ secret: state.secrets.get(1) as Uint8Array, gen: 1, group: 'chat:x', kind: 'lines', body: { ok: 1 } });
    const rx = new FrameReceiver({ setId: N.result.setId, secretFor: (g) => N.result?.ok ? N.result.secrets.get(g) : undefined, signKeyFor: (d) => (N.result?.ok ? N.result.devices.get(toHex(d))?.signKey : undefined) });
    expect((rx.open(wire).body as { ok: number }).ok).toBe(1);
  });
  it('the recording pipe saw none of: the device name, the code, the set secret', () => {
    const seen = Buffer.concat(log.map((l) => l.bytes));
    expect(seen.includes(Buffer.from('Phone'))).toBe(false);
    expect(seen.includes(inv.secret)).toBe(false);
    expect(seen.includes(Buffer.from(state.secrets.get(1) as Uint8Array))).toBe(false);
  });
  it('the code is single-use: spent after one success; the right code replayed afterwards is refused', () => {
    expect(E.isSpent).toBe(true);
    const again = attacker(E, inv, inv.code as string, 'late');
    expect(again.result).toEqual({ ok: false, why: 'closed' });
  });
});

describe('QR pairing', () => {
  it('completes and delivers the secret; the QR secret is 128 bits', () => {
    const { E, state } = makeSet();
    const inv = E.openInvite('qr');
    expect(inv.secret.length).toBe(16);
    const N = newDev(inv, 'qr', 'Laptop', true);
    pipeRun(E, N);
    expect(N.result?.ok).toBe(true);
    if (N.result?.ok) expect(N.result.secrets.get(1)?.equals(Buffer.from(state.secrets.get(1) as Uint8Array))).toBe(true);
  });
  it('a QR whose fingerprint does not match the answering device is refused by N', () => {
    const { E } = makeSet();
    const inv = E.openInvite('qr');
    const N = new NewDevice(generateIdentity(), { room: inv.room, secret: inv.secret, fingerprint: randomBytes(32) }, 'qr', { name: 'Laptop', platform: 'linux' });
    pipeRun(E, N);
    expect(N.result).toEqual({ ok: false, why: 'fingerprint mismatch' });
  });
  it('a typed-code invite and a QR invite are different protocols (mode is bound into the transcript)', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    const N = new NewDevice(generateIdentity(), { room: inv.room, secret: inv.secret }, 'qr', { name: 'x', platform: 'y' });
    pipeRun(E, N);
    expect(N.result?.ok).toBe(false);
  });
});

describe('a pipe that drops, replays, reorders and injects', () => {
  it('dropping the confirmation: no prompt on E, no result on N', () => {
    const { E, prompts } = makeSet();
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    pipeRun(E, N, { mangle: (it) => (tOf(it.bytes) === 'cN' ? [] : [it]) });
    expect(prompts).toHaveLength(0);
    expect(N.result).toBeNull();
  });
  it('a confirmation held back, then delivered late and twice: accepted at most once', () => {
    const { E, prompts } = makeSet();
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    const held: Item[] = [];
    pipeRun(E, N, { mangle: (it) => { if (tOf(it.bytes) === 'cN') { held.push(it); return []; } return [it]; } });
    for (const h of held) {
      E.onMessage(h.conn, h.bytes);
      E.onMessage(h.conn, h.bytes);
    }
    expect(E.events.filter((e) => e === 'confirm-ok')).toHaveLength(1);
    expect(prompts).toHaveLength(0); // N never saw E's answer, so it never sent its name
    expect(N.result).toBeNull();
  });
  it('garbage and a forged welcome injected into N are ignored; the real welcome still completes', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    pipeRun(E, N, { mangle: (it, { q }) => {
      if (it.dir === 'E2N' && tOf(it.bytes) === 'cE') {
        q.push({ dir: 'E2N', conn: 'n1', bytes: encode({ t: 'welcome', ct: randomBytes(300) }) });
        q.push({ dir: 'E2N', conn: 'n1', bytes: randomBytes(50) });
      }
      return [it];
    } });
    expect(N.result?.ok).toBe(true);
  });
  it('replaying a whole recorded session: no second prompt at the spent code; 1 failure and no prompt at a fresh code', () => {
    const { E, prompts } = makeSet();
    const inv = E.openInvite('code');
    const log = pipeRun(E, newDev(inv, 'code'));
    const before = E.failureCount;
    for (const l of log.filter((x) => x.dir === 'N2E')) E.onMessage('replay', l.bytes);
    expect(E.failureCount).toBe(before);
    expect(prompts).toHaveLength(1);
    const { E: E2, prompts: p2 } = makeSet();
    E2.openInvite('code');
    for (const l of log.filter((x) => x.dir === 'N2E')) E2.onMessage('replay', l.bytes);
    expect(E2.failureCount).toBe(1);
    expect(p2).toHaveLength(0);
    expect(E2.events).not.toContain('confirm-ok');
  });
  it('messages out of order, for an unknown connection, or after a drop are ignored and cost nothing', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    expect(E.onMessage('nobody', encode({ t: 'cN', mac: randomBytes(32) }))).toEqual([]);
    expect(E.onMessage('nobody', encode({ t: 'hello', ct: randomBytes(40) }))).toEqual([]);
    const N = newDev(inv, 'code');
    const first = E.onMessage('c', N.start());
    expect(first).toHaveLength(1);
    E.dropConnection('c');
    expect(E.onMessage('c', encode({ t: 'cN', mac: randomBytes(32) }))).toEqual([]);
    expect(E.failureCount).toBe(0);
  });
});

describe('online guessing: the code burns after 3 failures counted on E', () => {
  it('three wrong guesses burn it; afterwards even the CORRECT code is refused and no prompt is shown', () => {
    const { E, prompts } = makeSet();
    const inv = E.openInvite('code');
    const attempts = [0, 1, 2].map((i) => attacker(E, inv, wrongCode(inv.code as string), 'evil' + i));
    expect(attempts.every((a) => a.result?.ok === false)).toBe(true);
    expect(E.failureCount).toBe(MAX_FAILURES);
    expect(E.isBurned).toBe(true);
    const legit = newDev(inv, 'code');
    pipeRun(E, legit);
    expect(legit.result).toEqual({ ok: false, why: 'closed' });
    expect(prompts).toHaveLength(0);
    expect(E.evaluatedCount).toBe(3); // no 4th guess is ever checked
  });
  it('50 simultaneous connections still get at most 3 evaluated confirmations', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    const attackers = Array.from({ length: 50 }, (_, i) => ({ A: newDev({ room: inv.room, secret: Buffer.from(wrongCode(inv.code as string)), fingerprint: inv.fingerprint }, 'code', 'a'), tag: 'p' + i }));
    const replies = attackers.map(({ A, tag }) => ({ A, tag, r: E.onMessage(tag, A.start()) }));
    const second = replies.map(({ A, tag, r }) => ({ tag, r: r.flatMap((m) => A.onMessage(m)) }));
    second.forEach(({ tag, r }) => r.forEach((m) => E.onMessage(tag, m)));
    expect(E.evaluatedCount).toBeLessThanOrEqual(MAX_FAILURES);
  });
  it('connections beyond the cap get "busy" and cost no guess', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    const answers = Array.from({ length: MAX_CONNECTIONS + 4 }, (_, i) => E.onMessage('c' + i, newDev(inv, 'code').start()));
    expect(answers.filter((a) => tOf(a[0]) === 'busy')).toHaveLength(4);
    expect(E.failureCount).toBe(0);
  });
  it('a full man in the middle with guessed codes: E counts 1 failure, N is left waiting and has revealed nothing', () => {
    const { E, prompts } = makeSet();
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    const ci = encode([LABEL + 'pair', 'code']);
    const sid = sha256(Buffer.from(LABEL + 'pair/sid\0'), inv.room).subarray(0, 16);
    const mitm = new CPace({ prs: Buffer.from('ZZZZZZ'), ci, sid, role: 'responder' });
    pipeRun(E, N, { mangle: (it) => {
      if (it.dir === 'N2E' && tOf(it.bytes) === 'pake1') {
        mitm.finish({ Y: (decode(it.bytes) as { Y: Buffer }).Y, AD: Buffer.alloc(0) });
        attacker(E, inv, wrongCode(inv.code as string), 'mitm-to-E');
        return [{ dir: 'E2N', conn: 'n1', bytes: encode({ t: 'pake2', Y: mitm.Y }) }];
      }
      return [];
    } });
    expect(E.failureCount).toBe(1);
    expect(prompts).toHaveLength(0);
    expect(N.stageName).toBe('await-cE');
    expect(N.sas).toBeUndefined(); // no matching number until the other side proved the code
  });
  it('a low-order point in pake1 is rejected and counted', () => {
    const { E } = makeSet();
    E.openInvite('code');
    const out = E.onMessage('c', encode({ t: 'pake1', Y: Buffer.alloc(32) }));
    expect(tOf(out[0])).toBe('rejected');
    expect(E.failureCount).toBe(1);
  });
});

describe('approval, expiry and what leaves E before "yes"', () => {
  it('declining sends no set secret and no roster', () => {
    const { E, state } = makeSet({ approve: false });
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    const log = pipeRun(E, N);
    expect(N.result).toEqual({ ok: false, why: 'declined' });
    const sent = Buffer.concat(log.filter((l) => l.dir === 'E2N').map((l) => l.bytes));
    expect(sent.includes(Buffer.from(state.secrets.get(1) as Uint8Array))).toBe(false);
    expect(E.events).not.toContain('welcome-sent');
  });
  it('a human answering later: nothing sealed under the set secret leaves E until decide(true)', () => {
    const { E, prompts } = makeSet({ approve: undefined });
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    pipeRun(E, N);
    expect(prompts).toHaveLength(1);
    expect(N.result).toBeNull();
    expect(E.events).not.toContain('welcome-sent');
    const [welcome] = E.decide('n1', true);
    expect(N.onMessage(welcome)).toEqual([]);
    expect(N.result?.ok).toBe(true);
    expect(E.decide('n1', true)).toEqual([]); // a second yes does nothing
  });
  it('decide() for an unknown connection or the wrong stage does nothing', () => {
    const { E } = makeSet({ approve: undefined });
    E.openInvite('code');
    expect(E.decide('nobody', true)).toEqual([]);
  });
  it('the invite expires after 5 minutes', () => {
    let t = 1_000_000;
    const { E } = makeSet({ now: () => t });
    const inv = E.openInvite('code');
    t += INVITE_LIFETIME_MS + 1;
    const N = newDev(inv, 'code');
    pipeRun(E, N);
    expect(N.result).toEqual({ ok: false, why: 'closed' });
  });
  it('a yes that comes after the prompt lifetime is refused', () => {
    let t = 1_000_000;
    const { E } = makeSet({ approve: undefined, now: () => t });
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    pipeRun(E, N);
    t += PROMPT_LIFETIME_MS + 1;
    const out = E.decide('n1', true);
    expect(tOf(out[0])).toBe('closed');
    expect(E.events).not.toContain('welcome-sent');
  });
  it('device names are sanitised before they reach the prompt and the roster', () => {
    const { E, prompts, added } = makeSet();
    const inv = E.openInvite('code');
    pipeRun(E, newDev(inv, 'code', 'Lap‮top\u0007'));
    expect(prompts[0].name).toBe('Laptop');
    expect((added[0] as { body: { name: string } }).body.name).toBe('Laptop');
    expect(prompts[0].fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
  it('a meeting point shorter than 64 bits is refused', () => {
    const { E } = makeSet();
    expect(() => E.openInvite('code', Buffer.alloc(MIN_ROOM_BYTES - 1))).toThrowError(MeshCryptoError);
    expect(() => E.openInvite('code', Buffer.alloc(MIN_ROOM_BYTES))).not.toThrow();
  });
  it('reopening an invite resets the budget and drops old connections', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    attacker(E, inv, wrongCode(inv.code as string), 'x');
    expect(E.failureCount).toBe(1);
    E.openInvite('code');
    expect(E.failureCount).toBe(0);
  });
});

describe('message size cap', () => {
  it('an oversized message is ignored without parsing and costs nothing', () => {
    const { E } = makeSet();
    E.openInvite('code');
    expect(E.onMessage('c', Buffer.alloc(MAX_MESSAGE_BYTES + 1))).toEqual([]);
    expect(E.failureCount).toBe(0);
  });
  it('N ignores an oversized message too', () => {
    const { E } = makeSet();
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    N.start();
    N.onMessage(Buffer.alloc(MAX_MESSAGE_BYTES + 1));
    expect(N.result).toBeNull();
  });
});

describe('what N refuses even from an authenticated E', () => {
  function pairWith(mutate: (s: ExistingState, id: DeviceIdentity) => void): NewDevice {
    const { E, state, id } = makeSet();
    mutate(state, id);
    const inv = E.openInvite('code');
    const N = newDev(inv, 'code');
    pipeRun(E, N);
    return N;
  }
  it('a set id that does not match the roster genesis', () => {
    expect(pairWith((s) => { s.setId = randomBytes(32); }).result).toEqual({ ok: false, why: 'set id does not match roster' });
  });
  it('a roster E itself is not part of', () => {
    const N = pairWith((s) => { s.roster = [makeGenesisEntry(generateIdentity(), 'Other', 'linux', 1)]; });
    expect(N.result?.ok).toBe(false);
    expect((N.result as { why: string }).why).toBe('bad roster');
  });
  it('a roster whose signatures are tampered', () => {
    const N = pairWith((s) => { s.roster = [{ ...s.roster[0], at: 777 }]; });
    expect((N.result as { why: string }).why).toBe('bad roster');
  });
});

describe('code format helpers', () => {
  it('the alphabet has exactly 32 distinct symbols and no look-alikes (0, 1, I, O)', () => {
    expect(CODE_ALPHABET.length).toBe(32);
    expect(new Set(CODE_ALPHABET).size).toBe(32);
    for (const ch of '01IO') expect(CODE_ALPHABET.includes(ch)).toBe(false);
  });
  it('generated codes have the configured length and alphabet, and are not all alike', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      for (const ch of c) expect(CODE_ALPHABET.includes(ch)).toBe(true);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(190);
  });
  it('every symbol is equally likely (mask of a byte over a 32-symbol alphabet has no bias)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) for (const ch of generateCode(8)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = (4000 * 8) / 32;
    for (const ch of CODE_ALPHABET) expect(Math.abs((counts.get(ch) ?? 0) - expected)).toBeLessThan(expected * 0.2);
  });
  it('normalizeCode accepts case, spaces and dashes; refuses the rest with invalid-code', () => {
    expect(normalizeCode('k7qd-4m')).toBe('K7QD4M');
    expect(normalizeCode(' K7Q D4M ')).toBe('K7QD4M');
    for (const bad of ['K7QD4', 'K7QD4MM', 'K7QD40', 'K7QD41', 'K7QDIM', 'K7QDOM', '', 'K7QD4!']) {
      expect(() => normalizeCode(bad), bad).toThrowError(MeshCryptoError);
    }
  });
  it('shortAuthString is stable, zero-padded and derived from the key (pinned)', () => {
    expect(shortAuthString(Buffer.alloc(64, 1))).toBe('7547');
    expect(shortAuthString(Buffer.alloc(64, 2), 6)).toBe('915064');
    expect(shortAuthString(Buffer.alloc(64, 1))).not.toBe(shortAuthString(Buffer.alloc(64, 3)));
  });
});
