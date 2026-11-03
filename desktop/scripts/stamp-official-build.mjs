#!/usr/bin/env node
// Marks this checkout as an OFFICIAL release before it is built, so the app sends
// its anonymous daily check-in (src/main/official-build.ts says why). Run ONLY by
// desktop-release.yml and android-release.yml, after the version sync and before
// `npm run build` / build-web-ui.sh. Test-build workflows never run it.
//
// WHY it fails loudly: a release that silently stayed unstamped would vanish from
// every analytics count, and nobody would notice for weeks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'src', 'main', 'official-build.ts');
const before = 'export const OFFICIAL_BUILD: boolean = false;';
const after = 'export const OFFICIAL_BUILD: boolean = true;';

const text = fs.readFileSync(file, 'utf8');
if (text.includes(after)) {
  console.log('official-build: already stamped');
} else if (!text.includes(before)) {
  console.error(`official-build: expected "${before}" in ${file} — refusing to guess`);
  process.exit(1);
} else {
  fs.writeFileSync(file, text.replace(before, after));
  if (!fs.readFileSync(file, 'utf8').includes(after)) {
    console.error('official-build: stamp did not stick');
    process.exit(1);
  }
  console.log('official-build: stamped as an official release');
}
