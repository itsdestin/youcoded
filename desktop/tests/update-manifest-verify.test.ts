import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  parseReleaseManifest,
  verifyManifestSignature,
  hashFileSha256,
  compareVersions,
  normalizeVersion,
  verifyDownloadedUpdate,
  type ReleaseManifest,
} from '../src/main/update-manifest-verify';

// A throwaway signing key for the test — never the production key.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sign = (bytes: Buffer) => crypto.sign(null, bytes, privateKey);

let tmpDir: string;
let installerPath: string;
const INSTALLER_BYTES = Buffer.from('pretend this is a 150MB installer');
const INSTALLER_NAME = 'YouCoded-Installer-1.3.0.exe';
const INSTALLER_SHA256 = crypto.createHash('sha256').update(INSTALLER_BYTES).digest('hex');

function manifestFor(version: string): ReleaseManifest {
  return { version, assets: [{ name: INSTALLER_NAME, sha256: INSTALLER_SHA256, size: INSTALLER_BYTES.length }] };
}
function bytesOf(m: ReleaseManifest): Buffer {
  return Buffer.from(JSON.stringify(m));
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-verify-'));
  installerPath = path.join(tmpDir, INSTALLER_NAME);
  fs.writeFileSync(installerPath, INSTALLER_BYTES);
});
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); });

describe('signature verification (2026-09-10 security review, #7)', () => {
  it('accepts a genuine signature and rejects a tampered manifest', () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    const sig = sign(bytes);
    expect(verifyManifestSignature(bytes, sig, publicKeyPem)).toBe(true);
    // Flip one byte of the manifest — the signature no longer matches.
    const tampered = Buffer.from(bytes); tampered[10] ^= 0x01;
    expect(verifyManifestSignature(tampered, sig, publicKeyPem)).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
    const forged = crypto.sign(null, bytes, otherKey);
    expect(verifyManifestSignature(bytes, forged, publicKeyPem)).toBe(false);
  });

  it('returns false (not throws) for a garbage signature', () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    expect(verifyManifestSignature(bytes, Buffer.from('nonsense'), publicKeyPem)).toBe(false);
  });
});

describe('manifest parsing', () => {
  it('parses a well-formed manifest', () => {
    expect(parseReleaseManifest(bytesOf(manifestFor('1.3.0'))).version).toBe('1.3.0');
  });
  it('rejects bad JSON, missing version, empty assets, bad sha256', () => {
    expect(() => parseReleaseManifest('{ not json')).toThrow(/verify-failed/);
    expect(() => parseReleaseManifest('{"assets":[]}')).toThrow(/verify-failed/);
    expect(() => parseReleaseManifest('{"version":"1.0.0","assets":[]}')).toThrow(/verify-failed/);
    expect(() => parseReleaseManifest('{"version":"1.0.0","assets":[{"name":"a","sha256":"xyz","size":1}]}')).toThrow(/verify-failed/);
  });
});

describe('version comparison', () => {
  it('normalizes and orders', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(compareVersions('1.3.0', '1.2.4')).toBe(1);
    expect(compareVersions('1.2.4', '1.3.0')).toBe(-1);
    expect(compareVersions('v1.2.4', '1.2.4')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1); // numeric, not lexical
  });
});

describe('hashFileSha256', () => {
  it('hashes the file on disk', async () => {
    expect(await hashFileSha256(installerPath)).toBe(INSTALLER_SHA256);
  });
});

describe('verifyDownloadedUpdate — the full gate', () => {
  const base = {
    filePath: () => installerPath,
    fileName: INSTALLER_NAME,
    tag: 'v1.3.0',
    currentVersion: '1.2.4',
    publicKeyPem,
  };

  it('passes for a genuine, newer, matching update', async () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, manifestBytes: bytes, signatureBytes: sign(bytes),
    })).resolves.toMatchObject({ version: '1.3.0' });
  });

  it('rejects a bad signature with signature-invalid (no retry)', async () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, manifestBytes: bytes, signatureBytes: crypto.sign(null, bytes, otherKey),
    })).rejects.toMatchObject({ code: 'signature-invalid' });
  });

  it('rejects a downgrade with verify-failed', async () => {
    const bytes = bytesOf(manifestFor('1.2.0')); // older than running 1.2.4
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, tag: 'v1.2.0', manifestBytes: bytes, signatureBytes: sign(bytes),
    })).rejects.toMatchObject({ code: 'verify-failed' });
  });

  it('rejects a manifest whose version disagrees with the tag', async () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, tag: 'v1.4.0', manifestBytes: bytes, signatureBytes: sign(bytes),
    })).rejects.toMatchObject({ code: 'verify-failed' });
  });

  it('rejects a size or hash mismatch (swapped installer after signing)', async () => {
    // Manifest claims a different size than the file on disk.
    const m = manifestFor('1.3.0'); m.assets[0].size = 999999;
    const bytes = bytesOf(m);
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, manifestBytes: bytes, signatureBytes: sign(bytes),
    })).rejects.toMatchObject({ code: 'verify-failed' });

    const m2 = manifestFor('1.3.0'); m2.assets[0].sha256 = 'f'.repeat(64);
    const bytes2 = bytesOf(m2);
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, manifestBytes: bytes2, signatureBytes: sign(bytes2),
    })).rejects.toMatchObject({ code: 'verify-failed' });
  });

  it('rejects when the downloaded filename is not in the manifest', async () => {
    const bytes = bytesOf(manifestFor('1.3.0'));
    await expect(verifyDownloadedUpdate({
      ...base, filePath: installerPath, fileName: 'not-listed.exe', manifestBytes: bytes, signatureBytes: sign(bytes),
    })).rejects.toMatchObject({ code: 'verify-failed' });
  });
});
