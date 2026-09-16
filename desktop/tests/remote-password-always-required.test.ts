import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * Contract R9: a device needs the password even on your own private network.
 *
 * WHY a source scan rather than a behavioural test: the removed bypass had ten sites in
 * SettingsPanel.tsx alone, plus main, preload, the shim, the workbench mock and Kotlin. A
 * behavioural test proves the branch is gone from the one path it exercises; only a scan
 * proves nobody reintroduced the setting somewhere else.
 */
const ROOTS = ['src', '../app/src/main/kotlin'];
const EXT = /\.(ts|tsx|kt)$/;
const BANNED = /trustTailscale|isTailscaleIp|Skip password on Tailscale/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(entry)) out.push(p);
  }
  return out;
}

it('no code anywhere lets an address stand in for the password', () => {
  const base = new URL('..', import.meta.url).pathname;
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(base, root))) {
      const text = readFileSync(file, 'utf8');
      if (BANNED.test(text)) offenders.push(file.slice(base.length));
    }
  }
  expect(offenders).toEqual([]);
});
