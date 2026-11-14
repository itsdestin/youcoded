// Pins the public surface of the mesh crypto library: what later parts (transport, storage, UI)
// may import from './index'. Removing or renaming an export breaks this test on purpose.
// It also makes the barrel file reachable for the dead-code check while nothing in the app
// imports it yet (the feature ships switched OFF).
import { describe, expect, it } from 'vitest';
import * as mesh from './index';

describe('mesh crypto public surface', () => {
  it('exports the documented API', () => {
    const must = [
      'MeshCryptoError', 'encode', 'decode', 'generateIdentity', 'identityFromSecrets', 'serializeIdentity', 'parseIdentity', 'deviceIdFor', 'setIdFor', 'fingerprintFor',
      'newSetSecret', 'purposeKey', 'frameKey', 'sealSecretTo', 'openSecret', 'FrameSender', 'FrameReceiver', 'newSessionId', 'peekHeader',
      'signEntry', 'verifyEntry', 'verifyRosterLog', 'makeGenesisEntry', 'makeAddEntry', 'makeRemoveEntry', 'makeRenameEntry', 'sanitizeDeviceName',
      'Existing', 'NewDevice', 'generateCode', 'normalizeCode', 'shortAuthString', 'CODE_ALPHABET', 'CODE_LENGTH', 'MAX_FAILURES',
      'answerRelayChallenge', 'RelayAuthVerifier',
    ];
    for (const name of must) expect(mesh, name).toHaveProperty(name);
  });
  it('code format constants are the documented defaults (final format is a pending product choice)', () => {
    expect(mesh.CODE_LENGTH).toBe(6);
    expect(mesh.CODE_ALPHABET).toHaveLength(32);
    expect(mesh.MAX_FAILURES).toBe(3);
  });
});
