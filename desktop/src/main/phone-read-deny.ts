// phone-read-deny.ts — the ONE check every file read a PHONE can reach goes through.
//
// WHY (2026-10-01 one-core R3-SEC): reads were guarded by small per-channel lists (.ssh, .netrc, dotenv) that
// never covered a project's `.git/config`, `.git-credentials`, `id_rsa` or `*.pem`, and fs:read-head had no
// folder gate at all. The list lives in harness/tools/credential-paths.ts (isPhoneDeniedPath, which extends the
// native assistant's credential list without changing it); this file decides it on the REAL path:
// symlinks are resolved first, so a harmless-looking link inside a project that points at a secret is caught,
// and the name the phone typed is checked too. The computer's own windows never call this.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalize } from '../shared/artifacts/canonicalize';
import { isPhoneDeniedPath } from './harness/tools/credential-paths';

/** The code every phone read answers when it is refused here. The screens word it "kept on the computer". */
export const KEPT_ON_COMPUTER = 'kept-on-computer';

/** The home folder in both spellings (as set, and with symlinks resolved), canonical. */
async function homes(): Promise<string[]> {
  const set = os.homedir();
  const real = await fs.promises.realpath(set).catch(() => set);
  return [...new Set([canonicalize(set, null), canonicalize(real, null)])];
}

/**
 * Must a phone be refused the file at any of these paths? Each is checked as typed (made absolute) AND with
 * symlinks resolved. A path that does not exist is checked by name only: there is nothing to read.
 */
export async function isPhoneDeniedFile(...candidates: Array<string | undefined | null>): Promise<boolean> {
  const hs = await homes();
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const forms = [canonicalize(path.resolve(raw), null)];
    const real = await fs.promises.realpath(raw).catch(() => null);
    if (real) forms.push(canonicalize(real, null));
    for (const form of forms) for (const h of hs) if (isPhoneDeniedPath(form, h)) return true;
  }
  return false;
}
