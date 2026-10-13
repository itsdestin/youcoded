// Downloads a Chromium for the Browser when the computer has no Chrome, Edge,
// Chromium or Brave (spec §1 — the common case on a Safari-only Mac).
//
// WHY playwright-core's own installer (its cli.js `install chromium`): it knows
// the right build for this playwright-core version and platform, verifies the
// download, and lays it out where browser-discovery.ts looks
// (PLAYWRIGHT_BROWSERS_PATH = <root>/browsers). It runs as a separate process
// under the app's own runtime (ELECTRON_RUN_AS_NODE), so nothing is installed
// system-wide and nothing blocks the worker while ~150 MB arrives.
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

import type { InstallState } from '../../shared/browser-types';
export type { InstallState } from '../../shared/browser-types';

export interface InstallerOptions {
  browsersDir: string;
  /** Absolute path of playwright-core's cli.js, OUTSIDE app.asar. */
  cliPath: string;
  /** The program that runs cli.js (the app's own binary, run as Node). */
  execPath?: string;
  onChange?: (s: InstallState) => void;
}

/** cli.js resolved to a real file: inside a packaged app it lives in
 *  app.asar.unpacked (electron-builder.yml asarUnpack), because a child process
 *  can't read files from inside the asar archive. */
export function playwrightCliPath(): string {
  const p = require.resolve('playwright-core/cli.js');
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export class BrowserInstaller {
  private state: InstallState = { phase: 'idle' };
  private child: ChildProcess | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly opts: InstallerOptions) {}

  get current(): InstallState { return this.state; }

  private set(s: InstallState): void {
    this.state = s;
    this.opts.onChange?.(s);
    if (s.phase === 'done' || s.phase === 'failed') {
      const w = this.waiters; this.waiters = [];
      for (const f of w) f();
    }
  }

  /** Start (or join) a download. Returns immediately; watch `current`/onChange. */
  start(): void {
    if (this.child) return;
    this.set({ phase: 'downloading', percent: 0 });
    let output = '';
    const child = spawn(this.opts.execPath ?? process.execPath, [this.opts.cliPath, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: this.opts.browsersDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      output = (output + s).slice(-4000);
      // Progress lines look like "|■■■■      |  40% of 167.3 MiB"; keep the highest seen.
      const all = [...s.matchAll(/(\d{1,3})%/g)].map((m) => Number(m[1])).filter((n) => n <= 100);
      if (all.length && this.state.phase === 'downloading') {
        const pct = Math.max(this.state.percent, all[all.length - 1]);
        if (pct !== this.state.percent) this.set({ phase: 'downloading', percent: pct });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      this.child = null;
      this.set({ phase: 'failed', error: err.message });
    });
    child.on('close', (code) => {
      this.child = null;
      if (code === 0) this.set({ phase: 'done' });
      else {
        const last = output.trim().split('\n').filter(Boolean).pop() ?? `exit code ${code}`;
        this.set({ phase: 'failed', error: last.replace(/\s+/g, ' ').slice(0, 300) });
      }
    });
  }

  cancel(): void {
    this.child?.kill();
  }

  /** Resolves when the running download ends (or at once when none is running). */
  whenSettled(): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
}
