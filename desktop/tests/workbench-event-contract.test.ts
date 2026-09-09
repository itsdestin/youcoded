// The workbench fake must not be the ONLY thing that emits an event the app
// listens for.
//
// WHY this exists: mock-only.ts's registry stops a fake CHANNEL shipping as
// real, and the mock contract test pins every hand-written channel against
// preload. Neither can see a custom EVENT. On 2026-09-09 the naming fake
// dispatched `youcoded:session-renamed` after a rename, the Resume Browser
// listened for it, and nothing in the product ever sent it — so renaming a
// saved conversation repainted perfectly in the workbench and not at all in the
// app. Six visual review rounds and a signed contract row (R8, R12) passed over
// it, because every one of them looked at the workbench. A fresh code reviewer
// reading the code found it in minutes.
//
// The rule: an event the fake dispatches is a promise the product has to keep.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const WORKBENCH = path.join(RENDERER, 'dev', 'workbench');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every `youcoded:…` event name dispatched in the given files. */
function dispatched(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/dispatchEvent\(\s*new CustomEvent\(\s*['"`](youcoded:[^'"`]+)['"`]/g)) {
      const list = found.get(m[1]) ?? [];
      list.push(path.relative(RENDERER, file));
      found.set(m[1], list);
    }
  }
  return found;
}

describe('workbench event contract', () => {
  it('every event the fake dispatches is also dispatched by the real app', () => {
    const workbenchFiles = walk(WORKBENCH);
    const productFiles = walk(RENDERER).filter((f) => !f.startsWith(WORKBENCH));
    const fake = dispatched(workbenchFiles);
    const real = dispatched(productFiles);

    const fakeOnly = [...fake.keys()].filter((name) => !real.has(name));
    expect(fakeOnly, [
      'These events exist ONLY in the workbench fake, so the surfaces that listen',
      'for them work under review and do nothing in the app:',
      ...fakeOnly.map((n) => `  ${n} — dispatched by ${fake.get(n)!.join(', ')}`),
      'Dispatch it from the product path too, or stop the fake dispatching it.',
    ].join('\n')).toEqual([]);
  });

  it('finds the events it claims to scan (it must not pass by scanning nothing)', () => {
    // A guard that silently matches zero files passes forever. This session had
    // four separate checks pass for the wrong reason; this one says what it saw.
    const fake = dispatched(walk(WORKBENCH));
    expect(fake.size).toBeGreaterThan(0);
  });
});
