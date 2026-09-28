// Downloads the pinned Office add-on (itsdestin/youcoded-office, AGPL) into office-addon/.
// WHY at build and dev time, not first use: contract R2 — Office ships INSIDE the installer.
// WHY a separate program in a separate folder: the MIT app and the AGPL editors stay apart (R2).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(here, '..');
const DEST = path.join(DESKTOP, 'office-addon');

export function platformKey(platform = process.platform, arch = process.arch) {
  const p = { linux: 'linux', darwin: 'mac', win32: 'win' }[platform];
  return p ? `${p}-${arch}` : null;
}

export function planFetch(pin, manifest, key) {
  const entry = key && pin.platforms[key];
  if (!entry) return { action: 'unsupported' };
  if (manifest && manifest.version === pin.version) return { action: 'skip' };
  return { action: 'download', url: entry.url, sha256: entry.sha256 };
}

async function main() {
  const pin = JSON.parse(await readFile(path.join(DESKTOP, 'office-pin.json'), 'utf8'));
  const manifest = await readFile(path.join(DEST, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  const plan = planFetch(pin, manifest, platformKey());
  if (plan.action === 'skip') return console.log(`office add-on ${pin.version} present`);
  if (plan.action === 'unsupported') return console.log(`office add-on: no bundle for ${platformKey()} yet — Office will say it is not available`);
  const res = await fetch(plan.url);
  if (!res.ok) throw new Error(`office add-on download failed: HTTP ${res.status} ${plan.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== plan.sha256) throw new Error(`office add-on checksum mismatch: expected ${plan.sha256}, got ${got}`);
  const tgz = path.join(os.tmpdir(), `youcoded-office-${pin.version}.tar.gz`);
  await writeFile(tgz, buf);
  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });
  await promisify(execFile)('tar', ['-xzf', tgz, '-C', DEST]);
  await rm(tgz, { force: true });
  console.log(`office add-on ${pin.version} installed in office-addon/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
