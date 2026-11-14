// The app's copy of the relay wire types must be BYTE-FOR-BYTE the Worker's file (design S4; the Worker's own header asks
// for exactly this copy). If someone edits one side only, this fails. Skipped, with a message, when the Worker repo is not
// checked out next to this one.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

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
});
