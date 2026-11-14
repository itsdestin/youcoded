// PROOF that the ESM-only dependency (@noble/curves 2.x, "type": "module") loads the way the app
// actually ships main-process code.
//
// How the app bundles: desktop/tsconfig.json compiles src/main with `tsc` to CommonJS
// (module: commonjs, package "type": "commonjs") and Electron/Node run dist/main/*.js; there is no
// bundler for the main process. So a `import ... from '@noble/curves/ed25519.js'` becomes a
// synchronous require() of an ES module, which Node supports without a flag from 22.12 (20.19)
// as long as the module graph has no top-level await. The Android backend runs the same dist
// under Node 24.
//
// What this test does: compile ONLY the mesh crypto files with the project's own tsc and the
// project's own module settings (commonjs + bundler resolution) into a temp folder, then run the
// emitted JavaScript in a plain `node` child process that require()s it and performs a full
// pairing and a sealed frame. Vitest alone would NOT prove this, because vitest loads ESM natively.
//
// NOT proven here: Electron 44's own embedded Node (the Electron binary is not in this worktree and
// the installed app must not be run). The existing pdfjs-dist ESM load in harness/pdf-text.ts was
// verified under Electron 41's Node 24 by the same mechanism; Electron 44 ships a newer Node.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktop = path.resolve(__dirname, '../../../..');
const [major, minor] = process.versions.node.split('.').map(Number);
const supportsRequireEsm = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);

describe('ESM dependency under the app\'s real CommonJS build', () => {
  it('the dependency really is ESM-only (so this proof is not vacuous)', () => {
    const pkg = JSON.parse(readFileSync(path.join(desktop, 'node_modules/@noble/curves/package.json'), 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.version).toBe('2.4.0'); // exact pin: the Elligator2 export is marked "may be renamed"
    const declared = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).dependencies['@noble/curves'];
    expect(declared).toBe('2.4.0'); // exact, no caret
  });
  it.skipIf(!supportsRequireEsm)(
    'tsc (commonjs) output require()s it and completes a pairing plus a sealed frame in plain node',
    () => {
      const out = mkdtempSync(path.join(tmpdir(), 'mesh-esm-'));
      try {
        const tsc = path.join(desktop, 'node_modules/typescript/bin/tsc');
        const files = ['index.ts'].map((f) => path.join(desktop, 'src/main/mesh/crypto', f));
        execFileSync(process.execPath, [tsc, ...files, '--outDir', out, '--rootDir', path.join(desktop, 'src/main/mesh/crypto'), '--module', 'commonjs', '--moduleResolution', 'bundler', '--target', 'ES2022', '--lib', 'ES2022', '--esModuleInterop', '--skipLibCheck', '--strict', '--ignoreConfig', '--types', 'node', '--typeRoots', path.join(desktop, 'node_modules/@types')], { cwd: desktop, stdio: 'pipe' });
        const emitted = readFileSync(path.join(out, 'cpace.js'), 'utf8');
        expect(emitted).toMatch(/require\("@noble\/curves\/ed25519\.js"\)/); // CommonJS, not import()
        const script = `
          const m = require(${JSON.stringify(path.join(out, 'index.js'))});
          const a = m.generateIdentity();
          const setId = m.setIdFor(a.signKey);
          const S = m.newSetSecret();
          const state = { setId, secrets: new Map([[1, S]]), roster: [m.makeGenesisEntry(a, 'D', 'linux', 1)] };
          const E = new m.Existing(a, state, { onAddPrompt: () => true });
          const inv = E.openInvite('code');
          const N = new m.NewDevice(m.generateIdentity(), { room: inv.room, secret: inv.secret }, 'code', { name: 'p', platform: 'x' });
          let msgs = [N.start()];
          for (let i = 0; i < 8 && msgs.length; i++) { const next = []; for (const x of msgs) for (const r of E.onMessage('c', x)) next.push(...N.onMessage(r)); msgs = next; }
          if (!N.result || !N.result.ok) throw new Error('pairing failed: ' + JSON.stringify(N.result && N.result.why));
          const wire = new m.FrameSender({ identity: a, setId }).seal({ secret: S, gen: 1, group: 'g', kind: 'k', body: { ok: 1 } });
          const rx = new m.FrameReceiver({ setId, secretFor: () => S, signKeyFor: () => a.signKey });
          if (rx.open(wire).body.ok !== 1) throw new Error('frame');
          process.stdout.write('ESM-OK node ' + process.versions.node);
        `;
        const run = execFileSync(process.execPath, ['-e', script], { cwd: desktop, env: { ...process.env, NODE_PATH: path.join(desktop, 'node_modules') }, stdio: 'pipe' }).toString();
        expect(run).toMatch(/^ESM-OK node /);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
