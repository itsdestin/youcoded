// desktop/tests/sync-spaces-project-discovery.test.ts
// Real-git integration for cross-device project discovery/rename/stop (spec
// 2026-07-12). Two ManagedRoots + real bare remotes, mirroring
// the two-device case in sync-spaces-engine.test.ts. Exercises the registry + planner + transport
// directly (no service/Electron layer) so convergence is provable against git.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { ManagedRoots } from '../src/main/sync-spaces/managed-roots';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import { SpaceSyncEngine } from '../src/main/sync-spaces/engine';
import {
  readProjectRegistry, ensureProjectEntry, setProjectStopped,
} from '../src/main/sync-spaces/project-registry';
import { planReconcile, activeManagedSpaces } from '../src/main/sync-spaces/materialization-planner';
import type { SyncSpace } from '../src/main/sync-spaces/types';

// INTEGRATION test: spawns real `git`, and measured 19.6-27.3s in ISOLATION —
// i.e. 65-90% of the old 30s budget before any parallel load, so vitest's pool
// reliably pushed it over. A generous ceiling only bounds the FAILURE case.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-disc-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

function bare(name: string): string {
  const p = path.join(tmp, name); fs.mkdirSync(p);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', p]);
  return p;
}

it('device B discovers, materializes, and (after a stop) detaches a project', async () => {
  const personalBare = bare('personal.git');
  const appBare = bare('app.git');
  const laptop = new ManagedRoots(path.join(tmp, 'laptop'));
  const desktop = new ManagedRoots(path.join(tmp, 'desktop'));
  laptop.ensure(); desktop.ensure();

  const lT = new GitTransport({ deviceName: 'Laptop' });
  const dT = new GitTransport({ deviceName: 'Desktop' });
  // debounceMs is deliberately longer than this test's lifetime (the
  // sync-spaces-engine.test.ts:76 idiom), NOT the 200ms copied from
  // the two-device case in sync-spaces-engine — that test wants background syncs (pollMs: 300),
  // this one drives every sync explicitly below (pollMs: 0).
  //
  // WHY it must not fire: addSpace() starts a chokidar watcher on space.root,
  // so each registry write here schedules a debounced background syncSpace().
  // syncSpace() is single-flight — if one is already running it sets rerun and
  // returns IMMEDIATELY (engine.ts:114), so the test's own `await syncSpace()`
  // could resolve without having synced anything, and the peer then pulled a
  // stale registry ('active' instead of 'stopped'). A watcher that never fires
  // makes the explicit awaits the only syncs, which is what this test means.
  // This raced only under full-suite load — green on Windows and on an idle
  // Linux box, red on every ubuntu/macos CI run.
  const lEngine = new SpaceSyncEngine(lT, { debounceMs: 60_000, pollMs: 0, onEvent: () => {} });
  const dEngine = new SpaceSyncEngine(dT, { debounceMs: 60_000, pollMs: 0, onEvent: () => {} });

  // planReconcile takes live project NAMES, not space ids — convert exactly as
  // the service's runDiscovery does (id 'project:app' → name 'app').
  const dLiveNames = () =>
    dEngine.liveSpaceIds().filter(id => id.startsWith('project:')).map(id => id.slice('project:'.length));

  const lPersonal = laptop.spaces().find(s => s.kind === 'personal')!;
  const dPersonal = desktop.spaces().find(s => s.kind === 'personal')!;
  await lEngine.addSpace(lPersonal); await lT.setRemote(lPersonal, personalBare);
  await dEngine.addSpace(dPersonal); await dT.setRemote(dPersonal, personalBare);

  // Laptop creates + pushes the 'app' project and registers it in Personal.
  laptop.createProject('app');
  const lApp = laptop.spaces().find(s => s.id === 'project:app')!;
  await lEngine.addSpace(lApp); await lT.setRemote(lApp, appBare);
  fs.writeFileSync(path.join(lApp.root, 'CLAUDE.md'), '# app\n');
  await lEngine.syncSpace(lApp);
  ensureProjectEntry(laptop.personalRoot, { name: 'app', repoName: 'app' });
  await lEngine.syncSpace(lPersonal);

  // Desktop pulls Personal → the registry file must arrive (proves ProjectSync/ syncs).
  await dEngine.syncSpace(dPersonal);
  let registry = readProjectRegistry(desktop.personalRoot);
  expect(registry.map(e => e.name)).toEqual(['app']);

  // Desktop reconciles + materializes (mirrors runDiscovery, appBare stands in
  // for the repoName→URL the real ensureRemote returns).
  let plan = planReconcile(registry, desktop.listProjects().map(p => p.name), dLiveNames());
  expect(plan.toMaterialize.map(e => e.name)).toEqual(['app']);
  for (const entry of plan.toMaterialize) {
    desktop.createProject(entry.name);
    const space = desktop.spaces().find(s => s.id === `project:${entry.name}`) as SyncSpace;
    await dEngine.addSpace(space);
    await dT.setRemote(space, appBare);
    await dEngine.syncSpace(space);
  }
  expect(fs.readFileSync(path.join(desktop.projectsRoot, 'app', 'CLAUDE.md'), 'utf8')).toBe('# app\n');
  expect(desktop.listProjects().map(p => p.name)).toContain('app');

  // Laptop STOPS syncing 'app' and pushes the tombstone.
  await setProjectStopped(laptop.personalRoot, 'app', 'app');
  await lEngine.syncSpace(lPersonal);

  // Desktop pulls Personal → registry says stopped → reconcile detaches, keeps folder.
  await dEngine.syncSpace(dPersonal);
  registry = readProjectRegistry(desktop.personalRoot);
  expect(registry.find(e => e.name === 'app')!.state).toBe('stopped');
  plan = planReconcile(registry, desktop.listProjects().map(p => p.name), dLiveNames());
  expect(plan.toStop).toEqual(['app']);
  for (const name of plan.toStop) await dEngine.removeSpace(`project:${name}`);
  expect(dEngine.liveSpaceIds()).not.toContain('project:app'); // detached
  expect(fs.existsSync(path.join(desktop.projectsRoot, 'app', 'CLAUDE.md'))).toBe(true); // folder KEPT

  // Re-reconcile must NOT respawn a live space (activeManagedSpaces gate).
  const gated = activeManagedSpaces(registry, desktop.spaces());
  expect(gated.map(s => s.id)).not.toContain('project:app');
  const plan2 = planReconcile(registry, desktop.listProjects().map(p => p.name), dLiveNames());
  expect(plan2.toMaterialize).toEqual([]);
  expect(plan2.toStop).toEqual([]); // no live space to stop

  await lEngine.stop(); await dEngine.stop();
// Timeout comes from the file-level vi.setConfig above. It used to be an inline
// `}, 30_000)` third argument, which SILENTLY OVERRIDES vi.setConfig — that's
// why raising the file config alone didn't fix this test.
});
