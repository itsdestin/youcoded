// Known-answer test for the signed roster statement the relay verifies (review finding 8), plus the meeting-id rule.
// The vectors file is byte-identical to the Worker's (wecoded-marketplace/worker/test/mesh-roster-vectors.json); a drift test
// below fails if only one side is edited, and the Worker's own test reproduces the same bytes with its independent encoder.
// Regenerate (deliberately, after a wire change) with MESH_WRITE_VECTORS=1.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { identityFromSecrets, deviceIdFor, setIdFor } from '../../src/main/mesh/crypto/identity';
import { meetingIdFor, rosterStatementMessage, signRosterStatement } from '../../src/main/mesh/crypto/relay-auth';
import { verifySig } from '../../src/main/mesh/crypto/identity';
import { sha256, toHex, utf8, LABEL } from '../../src/main/mesh/crypto/bytes';

const file = path.join(__dirname, 'mesh-roster-vectors.json');
const workerFile = path.join(__dirname, '..', '..', '..', '..', 'wecoded-marketplace', 'worker', 'test', 'mesh-roster-vectors.json');
const h = (b: Uint8Array): string => toHex(b);
const fill = (n: number, v: number): Buffer => Buffer.alloc(n, v);

function build() {
  const signer = identityFromSecrets(fill(32, 0x11), fill(32, 0x12));
  const other = identityFromSecrets(fill(32, 0x21), fill(32, 0x22));
  const room = setIdFor(signer.signKey);
  const mk = (name: string, kind: 'add' | 'remove' | 'rename', at: number, seen: Buffer[]) => {
    const st = { kind, room, target: kind === 'rename' ? signer.deviceId : other.deviceId, targetKey: kind === 'add' ? other.signKey : null, entry: fill(32, 0x30 + seen.length), seen, at };
    const { sig, message } = signRosterStatement(signer, st);
    return {
      name,
      statement: { kind, room: h(room), signer: h(signer.deviceId), target: h(st.target), targetKey: st.targetKey ? h(st.targetKey) : null, entry: h(st.entry), seen: seen.map(h), at },
      messageHex: h(message),
      sigHex: h(sig),
    };
  };
  return {
    about: 'Known answers for the relay roster statement: message = "youcoded-mesh/v1/relay-roster\\0" || canonicalCBOR{kind,room,signer,target,targetKey|null,entry,seen[],at}; sig = Ed25519(signerKey, message). Shared byte-for-byte by the app and the Worker.',
    signerSignKey: h(signer.signKey),
    signerDevice: h(signer.deviceId),
    targetSignKey: h(other.signKey),
    cases: [
      mk('add, one seen id, small clock', 'add', 1000, [fill(32, 0x41)]),
      mk('add, two seen ids, millisecond clock above 2^32', 'add', 1_800_000_000_123, [fill(32, 0x42), fill(32, 0x43)]),
      mk('remove, key is null', 'remove', 24, [fill(32, 0x44)]),
      mk('remove, three seen ids, clock 255 and 65536', 'remove', 65_536, [fill(32, 0x45), fill(32, 0x46), fill(32, 0x47)]),
      mk('rename, target is the signer, key is null', 'rename', 5000, [fill(32, 0x48)]),
      mk('rename, 64 seen ids (the app\'s limit), large clock', 'rename', 1_800_000_000_999, Array.from({ length: 64 }, (_, i) => fill(32, 0x50 + i))),
    ],
    meetingId: { meetingPartUtf8: 'K7QD4MXW9R2PH', idHex: h(meetingIdFor(utf8('K7QD4MXW9R2PH'))) },
  };
}

describe('relay roster statement: known answers', () => {
  if (process.env.MESH_WRITE_VECTORS === '1') {
    it('writes the vectors', () => { fs.writeFileSync(file, JSON.stringify(build(), null, 2) + '\n'); });
  }
  const v = JSON.parse(fs.readFileSync(file, 'utf8')) as ReturnType<typeof build>;

  it('the vectors file still equals what the app code produces (signatures are deterministic)', () => {
    expect(v).toEqual(build());
  });
  it('each case: the message bytes and a signature that verifies under the signer key', () => {
    for (const c of v.cases) {
      const s = c.statement;
      const msg = rosterStatementMessage({ kind: s.kind, room: Buffer.from(s.room, 'hex'), signer: Buffer.from(s.signer, 'hex'), target: Buffer.from(s.target, 'hex'), targetKey: s.targetKey ? Buffer.from(s.targetKey, 'hex') : null, entry: Buffer.from(s.entry, 'hex'), seen: s.seen.map((x) => Buffer.from(x, 'hex')), at: s.at });
      expect(h(msg), c.name).toBe(c.messageHex);
      expect(verifySig(Buffer.from(v.signerSignKey, 'hex'), msg, Buffer.from(c.sigHex, 'hex')), c.name).toBe(true);
      const bad = Buffer.from(msg); bad[bad.length - 1] ^= 1;
      expect(verifySig(Buffer.from(v.signerSignKey, 'hex'), bad, Buffer.from(c.sigHex, 'hex')), `${c.name} tampered`).toBe(false);
    }
    expect(h(deviceIdFor(Buffer.from(v.targetSignKey, 'hex')))).toBe(v.cases[0]!.statement.target);
  });
  it('the meeting id depends on the meeting part alone, and is a plain SHA-256 with a fixed label', () => {
    expect(v.meetingId.idHex).toBe(h(sha256(utf8(LABEL + 'meet\0'), utf8(v.meetingId.meetingPartUtf8))));
    expect(h(meetingIdFor(utf8('K7QD4MXW9R2PH')))).not.toBe(h(meetingIdFor(utf8('K7QD4MXW9R2PJ'))));
  });
  const have = fs.existsSync(workerFile);
  if (!have) console.warn(`SKIPPED roster-vector drift check: ${workerFile} not found.`);
  it.skipIf(!have)('the app and the Worker hold byte-identical vectors', () => {
    expect(fs.readFileSync(file, 'utf8') === fs.readFileSync(workerFile, 'utf8'), 'mesh-roster-vectors.json differs between the app and the Worker: regenerate with MESH_WRITE_VECTORS=1 and copy it over').toBe(true);
  });
});
