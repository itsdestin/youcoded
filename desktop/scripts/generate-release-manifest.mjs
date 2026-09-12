// generate-release-manifest.mjs — build + sign the release manifest the in-app
// updater verifies (2026-09-10 security review, #7).
//
// Produces two files next to the installers:
//   youcoded-release.json      { version, assets: [{ name, sha256, size }] }
//   youcoded-release.json.sig  detached ed25519 signature of that file's bytes
//
// The desktop app embeds the matching PUBLIC key and, before running any
// downloaded installer, checks this signature, then each installer's SHA-256 and
// size, then that the version matches the tag and is newer than what's running.
//
// CLI (run by the release workflow's sign-manifest step):
//   node scripts/generate-release-manifest.mjs --dir <assets> --version <v> [--key <pemfile>]
// The private key is read from --key, or the UPDATE_SIGNING_KEY env var (PEM).
//
// The build/sign functions are exported so a test can round-trip them against the
// app's verifier (tests/release-manifest-roundtrip.test.ts).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

// Installer types we publish and the app can be asked to verify. The manifest
// lists all of them so any platform's download can be checked; the app matches
// its downloaded file by basename.
const INSTALLER_EXTENSIONS = ['.exe', '.dmg', '.AppImage', '.deb', '.rpm', '.pacman'];

function isInstaller(name) {
  return INSTALLER_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Recursively collect installer files under `dir`. */
export function findInstallers(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findInstallers(full));
    else if (entry.isFile() && isInstaller(entry.name)) out.push(full);
  }
  return out;
}

/** Build the manifest object over the installers found in `dir`. `name` is the
 *  basename, which is what the release asset is named and what the app matches. */
export function buildManifest(dir, version) {
  const files = findInstallers(dir);
  if (files.length === 0) throw new Error(`no installer files found under ${dir}`);
  const seen = new Set();
  const assets = files.map((full) => {
    const name = path.basename(full);
    if (seen.has(name)) throw new Error(`duplicate installer basename: ${name}`);
    seen.add(name);
    const buf = fs.readFileSync(full);
    return { name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  });
  // Store the version without a leading `v`; the app normalizes both sides.
  return { version: String(version).replace(/^v/i, ''), assets };
}

/** Serialize the manifest to the exact bytes that get written, hashed and
 *  signed. Stable key order via JSON.stringify of a plain object. */
export function serializeManifest(manifest) {
  return Buffer.from(JSON.stringify(manifest, null, 2));
}

/** ed25519-sign the manifest bytes with a PKCS8 PEM private key. */
export function signManifest(manifestBytes, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, manifestBytes, key);
}

/** Pull a PEM public key out of text: a .pem file, or the app's
 *  src/main/update-signing-key.ts, which embeds one in a string. */
export function publicKeyPemFrom(text) {
  const m = String(text).match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/);
  if (!m) throw new Error('no PUBLIC KEY block found');
  return `${m[0]}\n`;
}

/** Whether `sig` is a valid ed25519 signature of `manifestBytes` for this public key. */
export function signatureMatches(manifestBytes, sig, publicKeyPem) {
  try {
    return crypto.verify(null, manifestBytes, crypto.createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

const USAGE = 'usage: generate-release-manifest.mjs --dir <assets> --version <v> [--key <pemfile>] [--verify-with <file holding the public key>]';

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const dir = args.dir;
  const version = args.version || process.env.GITHUB_REF_NAME;
  if (!dir || !version) {
    console.error(USAGE);
    process.exit(2);
  }
  const privateKeyPem = args.key ? fs.readFileSync(args.key, 'utf8') : process.env.UPDATE_SIGNING_KEY;
  if (!privateKeyPem) {
    console.error('no signing key: pass --key <pemfile> or set UPDATE_SIGNING_KEY');
    process.exit(2);
  }
  const manifest = buildManifest(dir, version);
  const bytes = serializeManifest(manifest);
  const sig = signManifest(bytes, privateKeyPem);
  // WHY --verify-with (2026-09-11): a WRONG private key signs just as happily as
  // the right one; only the public key built into the app can tell them apart,
  // and without this check the first sign of a bad UPDATE_SIGNING_KEY secret
  // would be every user's Update button refusing the release. Nothing is
  // written unless the signature verifies.
  if (args['verify-with']) {
    const publicKeyPem = publicKeyPemFrom(fs.readFileSync(args['verify-with'], 'utf8'));
    if (!signatureMatches(bytes, sig, publicKeyPem)) {
      console.error(`the signing key does not match the public key in ${args['verify-with']}: the app would refuse this manifest, so nothing was written`);
      process.exit(1);
    }
    console.log(`signature verifies against ${args['verify-with']}`);
  }
  const manifestPath = path.join(dir, 'youcoded-release.json');
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(manifestPath + '.sig', sig);
  console.log(`wrote ${manifestPath} (${manifest.assets.length} assets) + .sig`);
  for (const a of manifest.assets) console.log(`  ${a.name}  ${a.size} bytes  ${a.sha256}`);
}

// Run as a CLI only when invoked directly (not when imported by a test).
// WHY pathToFileURL (2026-09-11): hand-built `file://` + a path is only right on
// Unix. On Windows `process.argv[1]` is `D:\a\...`, whose real URL is
// `file:///D:/a/...`, so the comparison failed, the CLI silently did nothing, and
// the test that runs it went red on the Windows build leg.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
