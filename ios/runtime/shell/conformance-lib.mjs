// conformance-lib.mjs — what both runs of the conformance list share: the files the list expects to find, and how an
// answer is judged. (The list itself is conformance.json.) Plain JavaScript on purpose: it runs on the build machine
// under Node 18 and, in the simulator build only, inside the app.
import fs from 'node:fs';
import path from 'node:path';

/** Files the list expects, made by Node (the shell cannot make a hidden file: that is what is being tested).
 *  Names that are secret wherever they sit, so this is safe to run beside a real user's files. */
export function seedFixture(dir) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.netrc'), 'machine example.com password TOPSECRET\n');
  fs.writeFileSync(path.join(dir, 'sub', 'id_rsa'), 'TOPSECRET private key\n');
}

/** A case: { cmd, out?, outRe?, errRe?, code? }. `out` is the exact standard output; `outRe` / `errRe` are patterns;
 *  `code` is the exit status (default 0). Returns null when the answer matches, else a one-line reason. */
export function judge(c, result) {
  const { stdout, stderr, exitCode } = result;
  if (exitCode !== (c.code ?? 0)) return `exit ${exitCode}, wanted ${c.code ?? 0} (stderr: ${stderr.trim().slice(0, 120)})`;
  if (c.out !== undefined && stdout !== c.out) return `output ${JSON.stringify(stdout.slice(0, 160))}, wanted ${JSON.stringify(c.out)}`;
  if (c.outRe !== undefined && !new RegExp(c.outRe).test(stdout)) return `output ${JSON.stringify(stdout.slice(0, 160))} does not match /${c.outRe}/`;
  if (c.errRe !== undefined && !new RegExp(c.errRe).test(stderr)) return `error text ${JSON.stringify(stderr.slice(0, 160))} does not match /${c.errRe}/`;
  if (c.errRe === undefined && c.errEmpty && stderr !== '') return `unexpected error text ${JSON.stringify(stderr.slice(0, 160))}`;
  return null;
}
