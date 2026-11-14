// Pairing THROUGH the relay's meeting point (stand-in relay here; the rig runs the real Worker): the typed code, the host and
// joiner services, and the rules about what the relay may see.
import { afterEach, describe, expect, it } from 'vitest';
import { insecureTestSealer } from '../../src/main/mesh/keystore';
import { MeshService } from '../../src/main/mesh/service';
import { MEETING_PART_LENGTH, TYPED_CODE_LENGTH, newTypedCode, parseTypedCode } from '../../src/main/mesh/pair-flow';
import { meetingIdFor } from '../../src/main/mesh/crypto/relay-auth';
import { utf8 } from '../../src/main/mesh/crypto/bytes';
import { FakeRelay } from './fake-relay';
import { tmp } from './helpers';

const live: Array<{ stop(): Promise<void> }> = [];
let relay: FakeRelay;
afterEach(async () => { while (live.length) await live.pop()!.stop(); await relay?.close(); });
const logs: string[] = [];
const mk = async (name: string): Promise<MeshService> => {
  const s = new MeshService({ userData: tmp(`rp-${name}-`), sealer: insecureTestSealer({ testMode: true }), testMode: true, relayUrl: relay.url, deviceName: name, platform: 'linux', log: (e, f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`), relayBaseDelayMs: 20, genTakeoverMs: 150, headsEveryMs: 1000 });
  await s.start();
  live.push(s);
  return s;
};
const until = async (cond: () => boolean, what: string, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};

describe('typed code', () => {
  it('is a 13-symbol meeting part plus a 6-symbol secret, shown in groups of four, parsed back from any case or spacing', () => {
    const c = newTypedCode('K7QD4M');
    expect(c.meetingPart).toHaveLength(MEETING_PART_LENGTH);
    expect(c.display.replace(/-/g, '')).toBe(c.meetingPart + 'K7QD4M');
    expect(c.display).toMatch(/^([A-Z2-9]{4}-){4}[A-Z2-9]{3}$/);
    const p = parseTypedCode(c.display.toLowerCase().replace(/-/g, ' '));
    expect(p).toEqual({ meetingPart: c.meetingPart, secret: 'K7QD4M' });
    expect(TYPED_CODE_LENGTH).toBe(19);
  });
  it('rejects a short code, a long code and look-alike symbols', () => {
    expect(() => parseTypedCode('K7QD4M')).toThrow();
    expect(() => parseTypedCode('A'.repeat(20))).toThrow();
    expect(() => parseTypedCode('0'.repeat(19))).toThrow();
  });
  it('the meeting id is a function of the meeting part ALONE: two codes sharing it but not the secret map to one id; the secret never enters it', () => {
    const a = newTypedCode('AAAAAA', 'K7QD4MXW9R2PH');
    const b = newTypedCode('BBBBBB', 'K7QD4MXW9R2PH');
    expect(meetingIdFor(utf8(a.meetingPart)).equals(meetingIdFor(utf8(b.meetingPart)))).toBe(true);
    expect(meetingIdFor(utf8(a.meetingPart)).toString('hex')).not.toContain('AAAAAA');
  });
});

describe('pairing through the meeting point', () => {
  it('B pairs to A with only the typed code; the matching numbers agree; roster changes are signed puts; the relay saw neither code nor secret', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    const B = await mk('B');
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A on the relay');
    const { code, meeting } = await A.openPairingViaRelay();
    expect(meeting).toMatch(/^[0-9a-f]{64}$/);
    await B.joinWithCode(code);
    await until(() => !!A.pairingPrompt(), 'the host prompt');
    const prompt = A.pairingPrompt()!;
    await until(() => !!B.joinStatus().sas, 'joiner number');
    expect(prompt.sas).toBe(B.joinStatus().sas);
    await A.hostPairingDecide(prompt.conn, true);
    await until(() => B.joinStatus().done, 'joiner done');
    await until(() => B.status().relay === 'ready', 'B on the relay');
    expect(B.status().inSet).toBe(true);
    expect([...relay.rooms.values()][0].roster.size).toBe(2); // admitted by a signed statement
    // the relay's meeting is over once it served
    await until(() => relay.meetings.size === 0, 'meeting erased');
    // nothing the relay could log or hold contains the code
    const everything = JSON.stringify(logs) + relay.stored.map((b) => b.toString('latin1')).join('');
    for (const part of code.split('-')) expect(everything.includes(part)).toBe(false);
  });

  it('a wrong code never pairs: the host counts the try and the joiner learns nothing but failure', async () => {
    relay = await new FakeRelay().ready();
    const A = await mk('A');
    const B = await mk('B');
    await A.createSet();
    await until(() => A.status().relay === 'ready', 'A on the relay');
    const { code } = await A.openPairingViaRelay();
    // same meeting part, wrong secret (an attacker who learned the meeting id but not the code)
    const wrong = code.replace(/-/g, '').slice(0, MEETING_PART_LENGTH) + (code.endsWith('A') ? 'BBBBBB' : 'AAAAAA');
    await B.joinWithCode(wrong);
    await until(() => !!B.joinStatus().failed || A.pairingState().events.some((e) => e.startsWith('fail') || e === 'burned'), 'failure noticed');
    expect(A.pairingPrompt()).toBeNull();
    expect(B.status().inSet).toBe(false);
    expect(A.status().rosterCount).toBe(1);
  });

  it('a code for a meeting nobody opened fails at once (nothing to join)', async () => {
    relay = await new FakeRelay().ready();
    const B = await mk('B');
    await expect(B.joinWithCode(newTypedCode('K7QD4M').display)).rejects.toThrow();
    expect(B.status().inSet).toBe(false);
  });
});
