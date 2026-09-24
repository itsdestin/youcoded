import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { tokenize, splitHeredocs, inlineShellScript, inlineInterpreterScript, type Word } from '../src/main/harness/tools/shell-words';
import { destructiveRmReason } from '../src/main/harness/tools/rm-target';
import { secretPathIn } from '../src/main/harness/tools/bash-secret-paths';

const words = (cmd: string) => tokenize(cmd, true).tokens.filter((t): t is Word => !('op' in t && t.op)).map((w) => w.value);

describe('shell-words tokenizer', () => {
  it('an unquoted # starting a word ends the command (a comment)', () => {
    expect(words('rm -rf build # clean everything in ~')).toEqual(['rm', '-rf', 'build']);
    expect(words('echo a#b "#x"')).toEqual(['echo', 'a#b', '#x']);
  });

  it('heredoc bodies are split out with the command they feed', () => {
    const { text, bodies } = splitHeredocs("cat > notes.md <<'EOF'\nrm -rf ~\nEOF\necho done");
    expect(text).toBe("cat > notes.md <<'EOF'\necho done");
    expect(bodies).toEqual([{ body: 'rm -rf ~', feeder: 'cat' }]);
    expect(splitHeredocs('sudo bash <<X\nls\nX').bodies[0].feeder).toBe('bash');
    expect(splitHeredocs('git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"').bodies[0].feeder).toBe('cat');
  });

  it('finds the script of sh -c, sh -c --, bash -lc and eval', () => {
    const args = (cmd: string) => tokenize(cmd, true).tokens.slice(1) as Word[];
    expect(inlineShellScript('bash', args("bash -c 'rm -rf ~'"))).toBe('rm -rf ~');
    expect(inlineShellScript('sh', args("sh -c -- 'ls'"))).toBe('ls');
    expect(inlineShellScript('bash', args("bash -lc 'ls'"))).toBe('ls');
    expect(inlineShellScript('eval', args('eval "rm -rf ~"'))).toBe('rm -rf ~');
    expect(inlineShellScript('bash', args('bash scripts/x.sh'))).toBeNull();
    expect(inlineInterpreterScript('node', args('node -e "x()"'))).toBe('x()');
    expect(inlineInterpreterScript('deno', args('deno eval "x()"'))).toBe('x()');
  });
});

// The re-review's everyday sweep (2026-09-23): real commands a developer types
// daily. Both floors must stay quiet on all of them except the few that really
// do delete a protected folder or read a secret file — each listed with why.
describe('everyday commands stay quiet on both floors', () => {
  const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/everyday-shell-commands.txt', import.meta.url)), 'utf8');
  const commands = fixture.split('\n@@\n').map((c) => c.replace(/\n$/, '')).filter(Boolean);
  const ctx = { cwd: '/home/u/proj', home: '/home/u' };
  const expectedAsks = new Map<string, 'rm' | 'secret'>([
    ['rm -rf "$BUILD_DIR"/*', 'rm'],        // empty $BUILD_DIR → the whole disk
    ['rm -rf ./*', 'rm'],                    // everything in the workspace
    ['docker compose --env-file .env up -d', 'secret'], // loads .env into the containers
    ["export $(grep -v '^#' .env | xargs)", 'secret'],   // reads .env
    ['vim .envrc', 'secret'],                // opens a secret file
  ]);

  it('the fixture is the full sweep', () => {
    expect(commands.length).toBe(76);
  });

  it.each(commands)('%s', (cmd) => {
    const rm = destructiveRmReason(cmd, ctx);
    const secret = secretPathIn(cmd, ctx);
    const want = expectedAsks.get(cmd);
    expect(rm !== null).toBe(want === 'rm');
    expect(secret !== null).toBe(want === 'secret');
  });
});
