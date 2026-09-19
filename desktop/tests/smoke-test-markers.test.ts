// The installer builds' launch check (scripts/smoke-test.js) passes only when the
// packaged app prints certain words on stdout/stderr. Those words live in two
// places — the check and the main process — and nothing tied them together: a
// refactor moved "Hooks installed" from a console.log into desktop.log, and every
// installer build then timed out with the app itself healthy. This pins that
// each word the check waits for is still PRINTED (console.*) by src/main.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const desktop = path.join(__dirname, '..');

function mainSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return mainSources(p);
    return /\.ts$/.test(e.name) ? [fs.readFileSync(p, 'utf8')] : [];
  });
}

describe('installer launch check', () => {
  const smoke = fs.readFileSync(path.join(desktop, 'scripts', 'smoke-test.js'), 'utf8');
  const markers = [...smoke.matchAll(/combined\.includes\('([^']+)'\)/g)].map((m) => m[1]);
  const printed = mainSources(path.join(desktop, 'src', 'main'))
    .flatMap((src) => [...src.matchAll(/console\.(?:log|info|warn|error)\(([^\n]*)/g)].map((m) => m[1]));

  it('waits for at least one marker', () => {
    expect(markers.length).toBeGreaterThan(0);
  });

  it('every marker it waits for is printed to the console by the main process', () => {
    const missing = markers.filter((m) => !printed.some((line) => line.includes(m)));
    expect(missing).toEqual([]);
  });
});
