import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { buildManifest, serializeManifest, signManifest, findInstallers } from '../scripts/generate-release-manifest.mjs';
import { verifyDownloadedUpdate } from '../src/main/update-manifest-verify';

// Proves the release-signing script and the app's verifier agree end to end: a
// manifest built + signed by the CI script must pass the exact check the app runs.
// If the two ever drift (e.g. serialization changes on one side), this goes red.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let dir: string;
const EXE = 'YouCoded-Setup-1.3.0.exe';
const DMG = 'YouCoded-1.3.0-arm64.dmg';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-manifest-'));
  // Two "installers" plus a non-installer file that must be ignored.
  fs.writeFileSync(path.join(dir, EXE), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(dir, DMG), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'not an installer');
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('release manifest → app verifier round trip (2026-09-10 #7)', () => {
  it('finds only installer files', () => {
    const names = findInstallers(dir).map((f: string) => path.basename(f)).sort();
    expect(names).toEqual([DMG, EXE].sort());
  });

  it('a script-signed manifest verifies for each installer with the matching public key', async () => {
    const manifest = buildManifest(dir, 'v1.3.0');
    const bytes = serializeManifest(manifest);
    const sig = signManifest(bytes, privateKeyPem);

    for (const name of [EXE, DMG]) {
      await expect(verifyDownloadedUpdate({
        filePath: path.join(dir, name),
        fileName: name,
        manifestBytes: bytes,
        signatureBytes: sig,
        tag: 'v1.3.0',
        currentVersion: '1.2.4',
        publicKeyPem,
      })).resolves.toMatchObject({ version: '1.3.0' });
    }
  });

  it('the verifier rejects it under a DIFFERENT public key (proves the signature is real)', async () => {
    const manifest = buildManifest(dir, 'v1.3.0');
    const bytes = serializeManifest(manifest);
    const sig = signManifest(bytes, privateKeyPem);
    const wrongPub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await expect(verifyDownloadedUpdate({
      filePath: path.join(dir, EXE), fileName: EXE,
      manifestBytes: bytes, signatureBytes: sig, tag: 'v1.3.0', currentVersion: '1.2.4', publicKeyPem: wrongPub,
    })).rejects.toMatchObject({ code: 'signature-invalid' });
  });
});
