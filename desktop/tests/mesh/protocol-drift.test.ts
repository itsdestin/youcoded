// The app's copy of the relay wire types must be BYTE-FOR-BYTE the Worker's file (design S4; the Worker's own header asks
// for exactly this copy). If someone edits one side only, this fails. Skipped, with a message, when the Worker repo is not
// checked out next to this one.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import * as shared from '../../src/shared/mesh-protocol';
import * as limits from '../../src/main/mesh/crypto/limits';
import * as roster from '../../src/main/mesh/crypto/roster';

const appCopy = path.join(__dirname, '..', '..', 'src', 'shared', 'mesh-protocol.ts');
// desktop/tests/mesh -> desktop -> youcoded -> workspace root, where wecoded-marketplace sits beside youcoded
const workerFile = path.join(__dirname, '..', '..', '..', '..', 'wecoded-marketplace', 'worker', 'src', 'mesh', 'protocol.ts');

describe('mesh wire protocol: app copy vs Worker file', () => {
  const have = fs.existsSync(workerFile);
  if (!have) console.warn(`SKIPPED mesh protocol drift check: ${workerFile} not found (wecoded-marketplace is not checked out beside youcoded).`);
  it.skipIf(!have)('the two files are identical', () => {
    const a = fs.readFileSync(appCopy, 'utf8');
    const w = fs.readFileSync(workerFile, 'utf8');
    expect(a === w, 'src/shared/mesh-protocol.ts and wecoded-marketplace/worker/src/mesh/protocol.ts differ: copy the changed file over the other and run both suites').toBe(true);
  });
  it('the app copy exists and exports the version constant the client dials with', () => {
    expect(fs.readFileSync(appCopy, 'utf8')).toMatch(/export const MESH_PROTOCOL_VERSION = \d+/);
  });
  it('the roster limits (crypto/limits.ts, which is compiled on its own) equal the shared protocol numbers, and the app roster uses them', () => {
    expect(limits.MAX_SET_DEVICES).toBe(shared.MAX_DEVICES); // the relay's device cap and the roster's set size are ONE number
    expect(limits.MAX_KNOWN_KEYS).toBe(shared.MAX_KNOWN_KEYS);
    expect(limits.MAX_ADMISSIONS_PER_SIGNER).toBe(shared.MAX_ADMISSIONS_PER_SIGNER);
    expect(limits.ROSTER_MAX_PER_SIGNER).toBe(shared.ROSTER_MAX_PER_SIGNER);
    expect(roster.MAX_ENTRIES_PER_DEVICE).toBe(shared.ROSTER_MAX_PER_SIGNER);
  });
});
