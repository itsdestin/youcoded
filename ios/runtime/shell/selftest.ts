// selftest.ts — TEST ONLY. Bundled into the backend only when the simulator build sets YOUCODED_IOS_SHELL_SELFTEST=1
// (build-backend.mjs); a release build never contains it, or the test list.
//
// WHY (iPhone app, card #89): everything about the built-in command line was proven on Linux. The first time it can run
// on the phone's own engine (no JIT, no ICU) is inside the iPhone simulator that CI starts. This runs the same list of
// command lines (conformance.json) through the SAME path the Bash tool uses (spawnDetached → the registered spawner →
// a worker thread) as soon as the backend starts, and writes the verdict to backend.log, which CI collects and checks:
//   SHELL_SELFTEST PASS 44/44          or          SHELL_SELFTEST FAIL <command>: <why>   then   SHELL_SELFTEST DONE 43/44
import * as fs from 'fs';
import * as path from 'path';
import { spawnDetached } from '../../../desktop/src/main/harness/shell-registry';
// @ts-expect-error plain JavaScript shared with the build machine's runner
import { judge, seedFixture } from './conformance-lib.mjs';
import list from './conformance.json';

interface Case { cmd: string; out?: string; outRe?: string; errRe?: string; errEmpty?: boolean; code?: number }
type Result = { stdout: string; stderr: string; exitCode: number };

function runOne(cmd: string, cwd: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawnDetached('built-in', ['-c', cmd], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.once('close', (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

async function main(): Promise<void> {
  // WHY wait: this file is loaded together with the registration (register.ts) and the backend's own start-up; running
  // before they finish would find no shell registered. A moment later everything is in place.
  await new Promise((r) => setTimeout(r, 3000));
  // Inside HOME so the credential rules (which are anchored there) apply; named so it cannot be mistaken for a user's folder.
  const parent = fs.mkdtempSync(path.join(process.env.HOME ?? '', '.yc-shell-selftest-'));
  const work = path.join(parent, 'work');
  seedFixture(work);
  let passed = 0;
  const cases = list as Case[];
  for (const c of cases) {
    const r = await runOne(c.cmd, work);
    const why: string | null = judge(c, r);
    if (why) console.log(`SHELL_SELFTEST FAIL ${c.cmd}: ${why}`); else passed++;
  }
  fs.rmSync(parent, { recursive: true, force: true });
  console.log(passed === cases.length ? `SHELL_SELFTEST PASS ${passed}/${cases.length}` : `SHELL_SELFTEST DONE ${passed}/${cases.length}`);
}

main().catch((e) => console.log(`SHELL_SELFTEST FAIL the self-test itself stopped: ${e?.stack ?? e}`));
