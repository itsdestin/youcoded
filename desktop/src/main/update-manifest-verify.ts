// update-manifest-verify.ts — verifying that a downloaded update is genuine.
//
// WHY (2026-09-10 security review, #7): the updater used to run whatever it
// downloaded after checking only the host. Now each release publishes a signed
// manifest — `youcoded-release.json { version, assets: [{ name, sha256, size }] }`
// plus a detached ed25519 signature `youcoded-release.json.sig` — and the app
// checks, before launching anything:
//   1. the signature is valid for the embedded public key (else the manifest was
//      forged or corrupted);
//   2. the downloaded file's SHA-256 and size match its manifest entry (else the
//      installer was swapped after signing);
//   3. the manifest's version matches the release tag and is NEWER than the
//      running version (no downgrade attacks).
//
// Pure and dependency-light so it can be unit-tested with a throwaway key. The
// caller supplies the public key (production key embedded in update-signing-key.ts;
// tests pass their own), so this file hard-codes no trust.

import fs from 'fs';
import crypto from 'crypto';
import { UpdateInstallError } from './update-installer';

export interface ReleaseAsset {
  name: string;
  sha256: string; // lowercase hex
  size: number;
}

export interface ReleaseManifest {
  version: string;
  assets: ReleaseAsset[];
}

/** Parse + shape-check the manifest JSON. Throws verify-failed on anything off. */
export function parseReleaseManifest(bytes: Buffer | string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString());
  } catch {
    throw new UpdateInstallError('verify-failed', 'manifest is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new UpdateInstallError('verify-failed', 'manifest is not an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'string' || !obj.version.trim()) {
    throw new UpdateInstallError('verify-failed', 'manifest has no version');
  }
  if (!Array.isArray(obj.assets) || obj.assets.length === 0) {
    throw new UpdateInstallError('verify-failed', 'manifest has no assets');
  }
  const assets: ReleaseAsset[] = obj.assets.map((a, i) => {
    const e = a as Record<string, unknown>;
    if (typeof e?.name !== 'string' || typeof e?.sha256 !== 'string' || typeof e?.size !== 'number') {
      throw new UpdateInstallError('verify-failed', `manifest asset ${i} is malformed`);
    }
    if (!/^[0-9a-f]{64}$/i.test(e.sha256)) {
      throw new UpdateInstallError('verify-failed', `manifest asset ${i} has a bad sha256`);
    }
    return { name: e.name, sha256: e.sha256.toLowerCase(), size: e.size };
  });
  return { version: obj.version.trim(), assets };
}

/**
 * Verify the detached ed25519 signature over the manifest's RAW bytes. Returns
 * true/false; never throws on a bad signature (a malformed key still throws,
 * which is a build error, not an attack). ed25519 uses the `null` algorithm.
 */
export function verifyManifestSignature(manifestBytes: Buffer, signature: Buffer, publicKeyPem: string): boolean {
  const key = crypto.createPublicKey(publicKeyPem);
  try {
    return crypto.verify(null, manifestBytes, key, signature);
  } catch {
    // A signature of the wrong length/format for the algorithm makes verify()
    // throw rather than return false — treat that as "not valid".
    return false;
  }
}

/** SHA-256 of a file, streamed so a 150 MB installer isn't held in memory. */
export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Normalize a version/tag: drop a leading `v` and surrounding whitespace. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/** Compare dotted numeric versions. >0 if a>b, <0 if a<b, 0 if equal on the
 *  numeric X.Y.Z parts. A pre-release suffix (e.g. `-beta`) is ignored for the
 *  ordering; exact-tag equality is checked separately. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => normalizeVersion(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface VerifyUpdateInput {
  /** Path to the downloaded installer on disk. */
  filePath: string;
  /** The installer's filename, matched against a manifest asset `name`. */
  fileName: string;
  /** Raw bytes of youcoded-release.json. */
  manifestBytes: Buffer;
  /** Raw bytes of youcoded-release.json.sig. */
  signatureBytes: Buffer;
  /** The release tag we downloaded from (e.g. `v1.3.0`). */
  tag: string;
  /** The version currently running (app.getVersion()). */
  currentVersion: string;
  /** The public key to trust (embedded key in production). */
  publicKeyPem: string;
}

/**
 * Full gate: signature → manifest shape → tag/version/downgrade → this file's
 * hash+size. Resolves on success; rejects with UpdateInstallError:
 *   'signature-invalid' — the signature didn't verify (no retry; the manifest is
 *                          forged or the key is wrong — retrying re-downloads the
 *                          same bad thing).
 *   'verify-failed'     — a hash/size/version mismatch or a malformed manifest
 *                          (retry once: a corrupted download can succeed next time).
 */
export async function verifyDownloadedUpdate(input: VerifyUpdateInput): Promise<ReleaseManifest> {
  const { filePath, fileName, manifestBytes, signatureBytes, tag, currentVersion, publicKeyPem } = input;

  // 1. Signature first — a manifest we can't trust tells us nothing.
  if (!verifyManifestSignature(manifestBytes, signatureBytes, publicKeyPem)) {
    throw new UpdateInstallError('signature-invalid', 'manifest signature did not verify');
  }

  // 2. Shape.
  const manifest = parseReleaseManifest(manifestBytes);

  // 3. Version must match the tag we fetched, and be newer than what we run.
  if (normalizeVersion(manifest.version) !== normalizeVersion(tag)) {
    throw new UpdateInstallError('verify-failed', `manifest version ${manifest.version} != tag ${tag}`);
  }
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    throw new UpdateInstallError('verify-failed', `refusing downgrade: ${manifest.version} <= running ${currentVersion}`);
  }

  // 4. This file's integrity.
  const entry = manifest.assets.find((a) => a.name === fileName);
  if (!entry) {
    throw new UpdateInstallError('verify-failed', `no manifest entry for ${fileName}`);
  }
  const actualSize = fs.statSync(filePath).size;
  if (actualSize !== entry.size) {
    throw new UpdateInstallError('verify-failed', `size ${actualSize} != manifest ${entry.size}`);
  }
  const actualHash = await hashFileSha256(filePath);
  if (actualHash.toLowerCase() !== entry.sha256.toLowerCase()) {
    throw new UpdateInstallError('verify-failed', 'sha256 mismatch');
  }
  return manifest;
}
