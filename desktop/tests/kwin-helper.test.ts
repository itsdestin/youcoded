import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { KwinHelper, type KwinHelperIo } from '../src/main/kwin-helper';
import type { KdeSession } from '../src/main/kde-dbus';

// ---------------------------------------------------------------------------
// Part 1 — the script that runs INSIDE KWin.
//
// The helper is plain JavaScript, so the real shipped file is loaded into a
// sandbox with a fake `workspace` and fake windows and exercised directly.
// These tests are the identity gate: they are the reason a web page cannot
// name itself "YC:mascot@0,0" and get always-on-top plus arbitrary
// repositioning out of the compositor.
// ---------------------------------------------------------------------------

const HELPER_MAIN = path.resolve(__dirname, '../assets/kwin-helper/contents/code/main.js');
const BUNDLED_DIR = path.resolve(__dirname, '../assets/kwin-helper');

type Handler = (...args: unknown[]) => void;
function signal() {
  const handlers: Handler[] = [];
  return {
    handlers,
    connect(fn: Handler) { handlers.push(fn); },
    disconnect(fn: Handler) {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
    emit(...args: unknown[]) { for (const fn of handlers.slice()) fn(...args); },
  };
}

class FakeWindow {
  caption: string;
  resourceClass: string;
  pid: number;
  frameGeometry = { x: 0, y: 0, width: 112, height: 112 };
  keepAbove = false;
  skipTaskbar = false;
  skipSwitcher = false;
  skipPager = false;
  minimized = false;
  captionChanged = signal();
  minimizedChanged = signal();

  constructor(caption: string, resourceClass = 'youcoded', pid = 4242) {
    this.caption = caption;
    this.resourceClass = resourceClass;
    this.pid = pid;
  }

  rename(caption: string): void {
    this.caption = caption;
    this.captionChanged.emit();
  }

  get position(): string { return `${this.frameGeometry.x},${this.frameGeometry.y}`; }
}

function bootHelper() {
  const logs: string[] = [];
  const existing: FakeWindow[] = [];
  const workspace = {
    windowList: () => existing.slice(),
    windowAdded: signal(),
    windowRemoved: signal(),
  };
  vm.runInContext(
    fs.readFileSync(HELPER_MAIN, 'utf8'),
    vm.createContext({ workspace, print: (s: string) => logs.push(s) }),
  );
  return {
    logs,
    add(w: FakeWindow) { workspace.windowAdded.emit(w); return w; },
    remove(w: FakeWindow) { workspace.windowRemoved.emit(w); },
  };
}

describe('the KWin helper script — identity', () => {
  it('moves and flags a window that is ours and asks correctly', () => {
    const kwin = bootHelper();
    const w = kwin.add(new FakeWindow('YC:mascot@300,200'));
    expect(w.position).toBe('300,200');
    // The three flags the app itself cannot set on Wayland, plus keep-above.
    expect([w.keepAbove, w.skipTaskbar, w.skipSwitcher, w.skipPager]).toEqual([true, true, true, true]);
    // Renaming is the whole channel: a second name is a second move.
    w.rename('YC:mascot@301,205');
    expect(w.position).toBe('301,205');
  });

  it('REFUSES a foreign resourceClass even with a perfect caption', () => {
    // R1-2: a browser puts the PAGE's own title in its caption, so a web page
    // could name itself correctly. It cannot change firefox's WM_CLASS.
    const kwin = bootHelper();
    const hostile = kwin.add(new FakeWindow('YC:mascot@300,200', 'firefox'));
    expect(hostile.position).toBe('0,0');
    expect(hostile.keepAbove).toBe(false);
    // and it is never even connected, so no helper JS runs inside the
    // compositor on that window's future title changes
    expect(hostile.captionChanged.handlers).toHaveLength(0);
    hostile.rename('YC:mascot@500,500');
    expect(hostile.position).toBe('0,0');
  });

  it('refuses every hostile spelling of the caption', () => {
    const kwin = bootHelper();
    const refused = [
      'Some Document — YC:mascot@300,200',   // not anchored at the start
      'YC:mascot@300,200 — Untitled',        // not anchored at the end
      'YC:evil@300,200',                     // a role we do not have
      'YC:mascot@300,200#tokenguess',        // a smuggled token: the grammar is tokenless
      'YC:mascot@abc,200',                   // not numbers
      'YC:mascot@1234567,200',               // 7 digits: the writer's own bound is 6
      'YC:mascot@99999999,200',              // and anything longer
      'YC:mascot@300, 200',                  // whitespace
      'yc:mascot@300,200',                   // case
      'YC:mascot@300,200\nYC:bar@1,1',       // a second line
      '',
    ];
    for (const caption of refused) {
      const w = kwin.add(new FakeWindow(caption));
      expect(`${caption} -> ${w.position}`).toBe(`${caption} -> 0,0`);
      expect(w.keepAbove).toBe(false);
    }
  });

  it('connects our main window but never flags or moves it', () => {
    // The app's own main window shares our resourceClass. Filtering on the
    // class alone would pin YouCoded itself above everything.
    const kwin = bootHelper();
    const main = kwin.add(new FakeWindow('YouCoded'));
    expect(main.captionChanged.handlers).toHaveLength(1);
    expect(main.keepAbove).toBe(false);
    expect(main.position).toBe('0,0');
  });

  it('keeps two instances apart by pid, and never crosses between them', () => {
    // A dev build and the installed app both report resourceClass "youcoded"
    // (measured — package.json's `name` is where WM_CLASS comes from), so pid
    // is the only thing that separates them.
    const kwin = bootHelper();
    const live = kwin.add(new FakeWindow('YC:mascot@100,100', 'youcoded', 111));
    const dev = kwin.add(new FakeWindow('YC:mascot@900,900', 'youcoded', 222));
    expect(live.position).toBe('100,100');
    expect(dev.position).toBe('900,900');
    live.rename('YC:mascot@105,105');
    expect(live.position).toBe('105,105');
    expect(dev.position).toBe('900,900');
  });

  it('evicts an older window holding the same role in the same instance', () => {
    // The chat window is destroyed and recreated as the user opens and closes
    // it. A stale record must not leave the replacement unmovable.
    const kwin = bootHelper();
    const first = kwin.add(new FakeWindow('YC:chat@10,10', 'youcoded', 111));
    const second = kwin.add(new FakeWindow('YC:chat@20,20', 'youcoded', 111));
    expect(second.position).toBe('20,20');
    expect(first.captionChanged.handlers).toHaveLength(0);
    expect(second.captionChanged.handlers).toHaveLength(1);
    // and a window of the same role in a DIFFERENT instance is left alone
    const other = kwin.add(new FakeWindow('YC:chat@30,30', 'youcoded', 222));
    expect(other.captionChanged.handlers).toHaveLength(1);
    expect(second.captionChanged.handlers).toHaveLength(1);
  });

  it('disconnects on windowRemoved', () => {
    const kwin = bootHelper();
    const w = kwin.add(new FakeWindow('YC:bar@5,5'));
    expect(w.captionChanged.handlers).toHaveLength(1);
    kwin.remove(w);
    expect(w.captionChanged.handlers).toHaveLength(0);
    expect(w.minimizedChanged.handlers).toHaveLength(0);
  });

  it('re-asserts the flags and the position when a window is restored', () => {
    // Wayland hands a restored window a NEW surface, so nothing set before the
    // minimise can be assumed to have survived it.
    const kwin = bootHelper();
    const w = kwin.add(new FakeWindow('YC:mascot@300,200'));
    w.keepAbove = false;
    w.skipTaskbar = false;
    w.frameGeometry = { x: 0, y: 0, width: 112, height: 112 };
    w.minimized = false;
    w.minimizedChanged.emit();
    expect(w.keepAbove).toBe(true);
    expect(w.skipTaskbar).toBe(true);
    expect(w.position).toBe('300,200');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the installer lifecycle.
//
// Everything that touches DBus, kwriteconfig6 or the user's config is injected,
// so the whole lifecycle runs with no compositor anywhere. The filesystem is
// real, in a throwaway directory.
// ---------------------------------------------------------------------------

type LoggedCall = {
  /** 'dbus' = a call with a reply, 'void' = reconfigure, 'bin' = kwriteconfig6 */
  kind: 'dbus' | 'void' | 'bin';
  args: string[];
  /** Which of our package directories existed AT THE MOMENT of the call. */
  dirsPresent: string[];
};

const KWIN_6_WAYLAND: KdeSession = { kwinMajor: 6, wayland: true, screens: [] };

function makeRig(overrides: Partial<KwinHelperIo> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwin-helper-test-'));
  const userDataDir = path.join(root, 'profile');
  const scriptsDir = path.join(root, 'kwin-scripts');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  const calls: LoggedCall[] = [];
  const slept: number[] = [];
  // A fake clock, advanced only by things that really take time: the waits
  // below, and `dbusCostMs` for a test about a compositor that answers slowly.
  let clock = 0;
  const cost = { dbusMs: 0 };
  const present = (): string[] => {
    try { return fs.readdirSync(scriptsDir).sort(); } catch { return []; }
  };

  // Defaults are the happy path; a test overrides the one answer it is about.
  const replies = {
    isScriptLoaded: 'true',
    // Answers isScriptLoaded in order, one per call, then falls back to
    // `isScriptLoaded` above. Lets a test say "false, false, then true".
    loadedSequence: null as string[] | null,
    unloadScript: { ok: true as const, stdout: 'false\n' } as
      | { ok: true; stdout: string }
      | { ok: false; reason: string },
    reconfigure: { ok: true } as { ok: boolean; error?: string },
    kwriteconfigError: null as string | null,
  };

  const io: KwinHelperIo = {
    platform: 'linux',
    ozonePlatform: 'wayland',
    userDataDir,
    bundledDir: BUNDLED_DIR,
    scriptsDir,
    kdeCall: (args) => {
      calls.push({ kind: 'dbus', args, dirsPresent: present() });
      clock += cost.dbusMs;
      if (args.some((a) => a.endsWith('isScriptLoaded'))) {
        const next = replies.loadedSequence?.shift();
        return Promise.resolve({ ok: true as const, stdout: next ?? replies.isScriptLoaded });
      }
      return Promise.resolve(replies.unloadScript);
    },
    kdeVoidCall: (args) => {
      calls.push({ kind: 'void', args, dirsPresent: present() });
      return Promise.resolve(replies.reconfigure);
    },
    readKdeSession: () => Promise.resolve(KWIN_6_WAYLAND),
    runBinary: (bin, args) => {
      calls.push({ kind: 'bin', args: [bin, ...args], dirsPresent: present() });
      if (replies.kwriteconfigError) return Promise.reject(new Error(replies.kwriteconfigError));
      return Promise.resolve('');
    },
    // Instant, so the load wait costs the suite nothing. `slept` records what
    // the real one would have waited, which is what the budget test reads.
    sleep: (ms: number) => { slept.push(ms); clock += ms; return Promise.resolve(); },
    now: () => clock,
    ...overrides,
  };

  return {
    root,
    scriptsDir,
    userDataDir,
    calls,
    slept,
    cost,
    replies,
    io,
    helper: new KwinHelper(io),
    settings: (): Record<string, unknown> => {
      try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'kwin-helper.json'), 'utf8')); } catch { return {}; }
    },
    /** The flat sequence of what was asked of the desktop, for order assertions. */
    trace: (): string[] => calls.map((c) => c.args.find((a) => a.includes('Scripting.') || a.includes('KWin.reconfigure')) ?? c.args.join(' ')),
  };
}

let rigs: string[] = [];
beforeEach(() => { rigs = []; });
afterEach(() => {
  for (const dir of rigs) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function rig(overrides: Partial<KwinHelperIo> = {}) {
  const r = makeRig(overrides);
  rigs.push(r.root);
  return r;
}

describe('the per-install token', () => {
  it('is stable for one profile and different for another', () => {
    const a = rig();
    const b = rig();
    expect(a.helper.pluginId()).toMatch(/^youcodedbuddyhelper-[a-z0-9]{12}$/);
    expect(a.helper.pluginId()).toBe(new KwinHelper(a.io).pluginId());
    expect(a.helper.pluginId()).not.toBe(b.helper.pluginId());
  });

  it('keeps the token it already stored, even if the profile path changed', () => {
    // A derived-only token would change with the path and this install would
    // instantly become the orphan of its own package.
    const r = rig();
    fs.writeFileSync(path.join(r.userDataDir, 'kwin-helper.json'), JSON.stringify({ token: 'deadbeef' }));
    expect(r.helper.pluginId()).toBe('youcodedbuddyhelper-deadbeef');
  });

  it('is not in the caption grammar', () => {
    // §2: the caption is user-visible in places skipTaskbar does not reach, so
    // the token lives in the plugin id and never travels in a window title.
    const kwin = bootHelper();
    const w = kwin.add(new FakeWindow('YC:mascot@1,2'));
    expect(w.position).toBe('1,2');
    const smuggled = kwin.add(new FakeWindow('YC:mascot@3,4@youcodedbuddyhelper-deadbeef'));
    expect(smuggled.position).toBe('0,0');
  });
});

describe('helperStatus', () => {
  it('needs no helper off Linux, and asks the desktop nothing', async () => {
    const r = rig({ platform: 'darwin' });
    expect(await r.helper.status()).toEqual({ needed: false, supported: false, installed: false });
    expect(r.calls).toHaveLength(0);
  });

  it('needs no helper on Linux under XWayland', async () => {
    // Probe Round 7: the same binary forced to --ozone-platform=x11 can move
    // its own windows. Every environment variable, and KWin's own Operation
    // Mode, are byte-identical to the native run — only this flips.
    const r = rig({ ozonePlatform: 'x11' });
    expect((await r.helper.status()).needed).toBe(false);
  });

  it('still reports installed truthfully on Linux when no helper is needed', async () => {
    // §4's second row, and it exists because of an R10 violation. Install on
    // Wayland, then log into X11 (or get an XWayland build after an update):
    // the script is STILL installed and STILL loaded in KWin, but `needed` is
    // now false. If status claimed installed:false there, the Remove helper
    // action would vanish and R10's "you can remove it again any time, from the
    // buddy's own settings" would be unkeepable — hand-editing kwinrc is the
    // only way out, and this user cannot do that.
    const r = rig({ ozonePlatform: 'x11' });
    expect(await r.helper.status()).toEqual({ needed: false, supported: true, installed: true });
  });

  it('can still remove the helper from that state', async () => {
    const r = rig({ ozonePlatform: 'x11' });
    fs.mkdirSync(path.join(r.scriptsDir, r.helper.pluginId()), { recursive: true });
    expect((await r.helper.remove()).ok).toBe(true);
  });

  it('fails safe when the ozone platform cannot be read', async () => {
    const r = rig({ ozonePlatform: '' });
    expect((await r.helper.status()).needed).toBe(false);
  });

  it('is unsupported, with a reason, on Plasma 5', async () => {
    const r = rig({ readKdeSession: () => Promise.resolve({ kwinMajor: 5, wayland: true, screens: [] }) });
    const status = await r.helper.status();
    expect(status).toMatchObject({ needed: true, supported: false });
    // The reason is read by a person in the buddy's settings, so it names the
    // thing they can recognise — their Plasma version — not an internal one.
    expect(status.reason).toContain('Plasma 5');
  });

  it('is unsupported on a KDE X11 session', async () => {
    const r = rig({ readKdeSession: () => Promise.resolve({ kwinMajor: 6, wayland: false, screens: [] }) });
    const status = await r.helper.status();
    expect(status.supported).toBe(false);
    expect(status.reason).toContain('does not need the helper');
  });

  it('still reports an installed helper on a real KDE X11 session', async () => {
    // R10, and the case §4's second row was actually written for. KWin answers
    // on X11 and says Operation Mode: X11, so `supported` is false — but the
    // script the user installed on Wayland is STILL in ~/.local/share/kwin and
    // still enabled. Forcing installed:false here made the Remove helper action
    // unreachable, leaving hand-editing kwinrc as the only way out.
    const r = rig({
      ozonePlatform: 'x11',
      readKdeSession: () => Promise.resolve({ kwinMajor: 6, wayland: false, screens: [] }),
    });
    const status = await r.helper.status();
    expect(status).toMatchObject({ needed: false, supported: false, installed: true });
  });

  it('does not claim a helper is installed when KDE never answered', async () => {
    const r = rig({ readKdeSession: () => Promise.resolve(null) });
    expect((await r.helper.status()).installed).toBe(false);
  });

  it('is unsupported, non-committally, when KWin does not answer', async () => {
    const r = rig({ readKdeSession: () => Promise.resolve(null) });
    const status = await r.helper.status();
    expect(status.supported).toBe(false);
    expect(status.reason).toBeTruthy();
  });

  it('reads `installed` from isScriptLoaded, NOT from files plus config', async () => {
    const r = rig();
    await r.helper.install();
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId()))).toBe(true);
    // Files and the config key are both in place — and KWin still says no.
    r.replies.isScriptLoaded = 'false\n';
    expect((await r.helper.status()).installed).toBe(false);
    r.replies.isScriptLoaded = 'true\n';
    expect((await r.helper.status()).installed).toBe(true);
  });
});

describe('install', () => {
  it('writes the package, stamps this install’s id, and enables it', async () => {
    const r = rig();
    const res = await r.helper.install();
    expect(res).toEqual({ ok: true });

    const dir = path.join(r.scriptsDir, r.helper.pluginId());
    expect(fs.existsSync(path.join(dir, 'contents', 'code', 'main.js'))).toBe(true);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    expect(metadata.KPlugin.Id).toBe(r.helper.pluginId());
    // The shipped placeholder must not survive onto disk.
    expect(metadata.KPlugin.Id).not.toBe('youcodedbuddyhelper');

    const kwrite = r.calls.find((c) => c.kind === 'bin');
    expect(kwrite?.args).toEqual([
      'kwriteconfig6', '--file', 'kwinrc', '--group', 'Plugins',
      '--key', `${r.helper.pluginId()}Enabled`, 'true',
    ]);
  });

  it('emits unloadScript BEFORE reconfigure', async () => {
    // Probe Round 4 U1: overwriting a loaded script's files and calling
    // reconfigure does NOT reload it — KWin keeps running the copy it parsed.
    // Get this order wrong and "updates replace the helper quietly" silently
    // becomes "at your next login".
    const r = rig();
    await r.helper.install();
    const trace = r.trace();
    const unload = trace.findIndex((t) => t.includes('unloadScript'));
    const reconfigure = trace.findIndex((t) => t.includes('reconfigure'));
    expect(unload).toBeGreaterThanOrEqual(0);
    expect(reconfigure).toBeGreaterThan(unload);
  });

  it('records the version only after reconfigure succeeds', async () => {
    const r = rig();
    await r.helper.install();
    expect(r.settings().helperLoadedVersion).toBe(r.helper.bundledVersion());
  });

  // ── the load wait ───────────────────────────────────────────────────────
  // MEASURED on KWin 6.7.3, 2026-09-04: `reconfigure` returns void immediately
  // and isScriptLoaded stays false for ~200ms (199/199/205 over three runs).
  // Without a wait, install reported success while the script was not running,
  // so the settings screen turned the buddy on and the app refused it in the
  // same breath — "goes back to disabled and says the helper isn't active"
  // (Destin, 2026-09-04), working only on a second try.

  it('waits for KWin to actually start the script before reporting success', async () => {
    const r = rig();
    // Answer 1 is consumed by install's own status() check before anything is
    // written; the wait after reconfigure then sees false, false, true.
    r.replies.loadedSequence = ['false', 'false', 'false', 'true'];
    const res = await r.helper.install();
    expect(res).toEqual({ ok: true });

    const trace = r.trace();
    const afterReconfigure = trace.slice(trace.findIndex((t) => t.includes('reconfigure')));
    expect(afterReconfigure.filter((t) => t.includes('isScriptLoaded'))).toHaveLength(3);
    expect(r.slept).toEqual([50, 50]);
  });

  it('fails, and records no version, when KWin never starts the script', async () => {
    const r = rig();
    r.replies.isScriptLoaded = 'false';
    const res = await r.helper.install();
    expect(res.ok).toBe(false);
    // No version marker, so the next launch repairs it instead of finding
    // "files present, versions equal, nothing to do".
    expect(r.settings().helperLoadedVersion).toBeUndefined();
    // Bounded: it gives up rather than waiting on a wedged compositor forever.
    expect(r.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000);
  });

  it('gives up on the clock, not on a count of tries', async () => {
    // Every try is a DBus call with its own 4s timeout. Budgeting by number of
    // tries would let a compositor that answers slowly hold the launch path for
    // a hundred times the intended wait — 400 seconds, not 5.
    const r = rig();
    r.replies.isScriptLoaded = 'false';
    r.cost.dbusMs = 4000;   // a compositor answering at its timeout
    await r.helper.install();
    expect(r.slept.length).toBeLessThanOrEqual(2);
  });

  it('leaves the package in place when only the load wait timed out', async () => {
    // The files are written and the config key is set — this is a KWin that has
    // not got to it yet, not a failed install. Deleting the package here would
    // throw away a helper that is about to start.
    const r = rig();
    r.replies.isScriptLoaded = 'false';
    await r.helper.install();
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId(), 'metadata.json'))).toBe(true);
  });

  it('refuses when this desktop needs no helper', async () => {
    const r = rig({ ozonePlatform: 'x11' });
    const res = await r.helper.install();
    expect(res.ok).toBe(false);
    expect(fs.readdirSync(r.scriptsDir)).toEqual([]);
  });

  it('refuses, with KWin’s own reason, when the helper cannot work here', async () => {
    const r = rig({ readKdeSession: () => Promise.resolve({ kwinMajor: 5, wayland: true, screens: [] }) });
    const res = await r.helper.install();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Plasma 5');
    expect(fs.readdirSync(r.scriptsDir)).toEqual([]);
  });
});

describe('half-install rollback (§1)', () => {
  it('removes the files it wrote when kwriteconfig6 fails, and reports the real error', async () => {
    const r = rig();
    r.replies.kwriteconfigError = 'kwriteconfig6: command not found';
    const res = await r.helper.install();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('kwriteconfig6: command not found');
    // Never leave files on disk with installed:false — that re-copies forever.
    expect(fs.readdirSync(r.scriptsDir)).toEqual([]);
    expect(r.settings().helperLoadedVersion).toBeUndefined();
  });

  it('removes the files it wrote when reconfigure fails on a FRESH install', async () => {
    const r = rig();
    r.replies.reconfigure = { ok: false, error: 'Error: org.freedesktop.DBus.Error.ServiceUnknown' };
    const res = await r.helper.install();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ServiceUnknown');
    expect(fs.readdirSync(r.scriptsDir)).toEqual([]);
    expect(r.settings().helperLoadedVersion).toBeUndefined();
  });
});

describe('R4-F6 — the version marker and its two crash windows', () => {
  /** An install that already succeeded once, then a build carrying a newer helper. */
  async function installedThenUpdated() {
    const r = rig();
    await r.helper.install();
    // Pretend the previous launch installed an older version of the package.
    const settingsFile = path.join(r.userDataDir, 'kwin-helper.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.helperLoadedVersion = '0.9';
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    r.calls.length = 0;
    return r;
  }

  it('re-runs the sequence at launch when the bundled version differs', async () => {
    const r = await installedThenUpdated();
    await r.helper.syncOnLaunch();
    const trace = r.trace();
    expect(trace.findIndex((t) => t.includes('unloadScript'))).toBeLessThan(
      trace.findIndex((t) => t.includes('reconfigure')),
    );
    expect(r.settings().helperLoadedVersion).toBe(r.helper.bundledVersion());
  });

  it('does nothing at launch when the versions already match', async () => {
    const r = rig();
    await r.helper.install();
    r.calls.length = 0;
    await r.helper.syncOnLaunch();
    expect(r.trace().filter((t) => t.includes('reconfigure'))).toEqual([]);
  });

  it('crash window 1 — unloadScript fails: no version is recorded and the next launch re-runs', async () => {
    const r = await installedThenUpdated();
    r.replies.unloadScript = { ok: false, reason: 'Error: org.freedesktop.DBus.Error.NoReply' };
    await r.helper.syncOnLaunch();
    // The stale marker survives, which is exactly what makes the next launch
    // try again instead of believing the user is up to date.
    expect(r.settings().helperLoadedVersion).toBe('0.9');
    // and the files are NOT rolled back — on an update there is nothing to roll
    // back to, and the retry needs the package directory to still be there.
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId()))).toBe(true);

    r.replies.unloadScript = { ok: true, stdout: 'true\n' };
    r.calls.length = 0;
    await r.helper.syncOnLaunch();
    expect(r.trace().some((t) => t.includes('reconfigure'))).toBe(true);
    expect(r.settings().helperLoadedVersion).toBe(r.helper.bundledVersion());
  });

  it('crash window 2 — reconfigure fails: no version is recorded and the next launch re-runs', async () => {
    const r = await installedThenUpdated();
    r.replies.reconfigure = { ok: false, error: 'Error: org.freedesktop.DBus.Error.NoReply' };
    await r.helper.syncOnLaunch();
    expect(r.settings().helperLoadedVersion).toBe('0.9');
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId()))).toBe(true);

    r.replies.reconfigure = { ok: true };
    r.calls.length = 0;
    await r.helper.syncOnLaunch();
    expect(r.settings().helperLoadedVersion).toBe(r.helper.bundledVersion());
  });

  it('never installs a helper the user has not asked for', async () => {
    const r = rig();
    await r.helper.syncOnLaunch();
    expect(fs.readdirSync(r.scriptsDir)).toEqual([]);
    expect(r.trace().some((t) => t.includes('reconfigure'))).toBe(false);
  });
});

describe('R4-F7 — orphan cleanup', () => {
  function plantOrphans(r: ReturnType<typeof rig>, ids: string[]) {
    for (const id of ids) {
      fs.mkdirSync(path.join(r.scriptsDir, id, 'contents', 'code'), { recursive: true });
      fs.writeFileSync(path.join(r.scriptsDir, id, 'metadata.json'), '{}');
    }
  }

  it('unloads each orphan BEFORE deleting its directory', async () => {
    // Round 4 U1: deleting a script's files does not stop KWin executing the
    // copy it already parsed. An orphan is not inert — it still matches our
    // WM_CLASS and caption grammar, so it keeps writing geometry every frame.
    const r = rig();
    plantOrphans(r, ['youcodedbuddyhelper-aaaa1111', 'youcodedbuddyhelper-bbbb2222']);
    await r.helper.cleanOrphans();

    for (const id of ['youcodedbuddyhelper-aaaa1111', 'youcodedbuddyhelper-bbbb2222']) {
      const unload = r.calls.find((c) => c.args.includes(id) && c.args.some((a) => a.endsWith('unloadScript')));
      expect(unload, `unloadScript for ${id}`).toBeDefined();
      // The directory was still on disk at the moment we asked KWin to unload.
      expect(unload?.dirsPresent).toContain(id);
      expect(fs.existsSync(path.join(r.scriptsDir, id))).toBe(false);
    }
  });

  it('DELETES the config key rather than setting it false', async () => {
    // Setting it false accrues one dead [Plugins] entry per token, forever.
    const r = rig();
    plantOrphans(r, ['youcodedbuddyhelper-aaaa1111']);
    await r.helper.cleanOrphans();
    const kwrite = r.calls.find((c) => c.kind === 'bin');
    expect(kwrite?.args).toEqual([
      'kwriteconfig6', '--file', 'kwinrc', '--group', 'Plugins',
      '--key', 'youcodedbuddyhelper-aaaa1111Enabled', '--delete',
    ]);
  });

  it('reconfigures once for the whole batch', async () => {
    const r = rig();
    plantOrphans(r, ['youcodedbuddyhelper-aaaa1111', 'youcodedbuddyhelper-bbbb2222', 'youcodedbuddyhelper']);
    await r.helper.cleanOrphans();
    expect(r.calls.filter((c) => c.kind === 'void')).toHaveLength(1);
    // and it is the LAST thing that happens
    expect(r.calls[r.calls.length - 1].kind).toBe('void');
  });

  it('never touches this install, or anyone else’s KWin script', async () => {
    const r = rig();
    await r.helper.install();
    plantOrphans(r, ['youcodedbuddyhelper-aaaa1111', 'tp-edges']);
    r.calls.length = 0;
    await r.helper.cleanOrphans();
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId()))).toBe(true);
    expect(fs.existsSync(path.join(r.scriptsDir, 'tp-edges'))).toBe(true);
    expect(r.calls.some((c) => c.args.includes('tp-edges'))).toBe(false);
    expect(r.calls.some((c) => c.args.includes(r.helper.pluginId()))).toBe(false);
  });

  it('does nothing, and asks the desktop nothing, when there are no orphans', async () => {
    const r = rig();
    await r.helper.cleanOrphans();
    expect(r.calls).toEqual([]);
  });

  it('runs at launch even on a session that needs no helper', async () => {
    // An orphan left by another profile keeps running inside the compositor
    // whether or not THIS session's windows need one.
    const r = rig({ ozonePlatform: 'x11' });
    plantOrphans(r, ['youcodedbuddyhelper-aaaa1111']);
    await r.helper.syncOnLaunch();
    expect(fs.existsSync(path.join(r.scriptsDir, 'youcodedbuddyhelper-aaaa1111'))).toBe(false);
  });
});

describe('remove', () => {
  it('follows §6’s order and targets only this install', async () => {
    const r = rig();
    await r.helper.install();
    plantOrphanDir(r.scriptsDir, 'youcodedbuddyhelper-aaaa1111');
    r.calls.length = 0;

    const res = await r.helper.remove();
    expect(res).toEqual({ ok: true });

    const id = r.helper.pluginId();
    const trace = r.calls.map((c) => `${c.kind}:${c.args.join(' ')}`);
    const unload = trace.findIndex((t) => t.includes('unloadScript'));
    const disable = trace.findIndex((t) => t.includes(`${id}Enabled false`));
    const reconfigure = trace.findIndex((t) => t.includes('reconfigure'));
    expect(unload).toBeGreaterThanOrEqual(0);
    expect(disable).toBeGreaterThan(unload);
    expect(reconfigure).toBeGreaterThan(disable);
    // The directory was still there when reconfigure was asked for, and is gone now.
    expect(r.calls[reconfigure].dirsPresent).toContain(id);
    expect(fs.existsSync(path.join(r.scriptsDir, id))).toBe(false);
    // Another install's package is not this install's business.
    expect(fs.existsSync(path.join(r.scriptsDir, 'youcodedbuddyhelper-aaaa1111'))).toBe(true);
    // The marker is cleared so a later re-install runs the full sequence.
    expect(r.settings().helperLoadedVersion).toBeUndefined();
  });

  it('changes nothing when the script cannot be unloaded', async () => {
    // Deleting the files anyway would report success while KWin kept running
    // the script and the buddy kept moving — the one outcome the order exists
    // to prevent.
    const r = rig();
    await r.helper.install();
    r.replies.unloadScript = { ok: false, reason: 'Error: org.freedesktop.DBus.Error.NoReply' };
    const res = await r.helper.remove();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('NoReply');
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId()))).toBe(true);
  });

  it('reports the real error when reconfigure fails', async () => {
    const r = rig();
    await r.helper.install();
    r.replies.reconfigure = { ok: false, error: 'Error: org.freedesktop.DBus.Error.ServiceUnknown' };
    const res = await r.helper.remove();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ServiceUnknown');
    expect(fs.existsSync(path.join(r.scriptsDir, r.helper.pluginId()))).toBe(true);
  });
});

function plantOrphanDir(scriptsDir: string, id: string): void {
  fs.mkdirSync(path.join(scriptsDir, id), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, id, 'metadata.json'), '{}');
}

describe('the bundled package itself', () => {
  it('ships a valid KWin script package', () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, 'metadata.json'), 'utf8'));
    expect(metadata.KPackageStructure).toBe('KWin/Script');
    expect(metadata['X-Plasma-API']).toBe('javascript');
    expect(metadata['X-Plasma-MainScript']).toBe('code/main.js');
    expect(fs.existsSync(path.join(BUNDLED_DIR, 'contents', 'code', 'main.js'))).toBe(true);
    expect(typeof metadata.KPlugin.Version).toBe('string');
  });
});

describe('the shipped KWin script stays inside the engine subset KWin accepts', () => {
  it('parses as ES5', async () => {
    // WHY this is a test and not a style note: KWin's script engine does not
    // warn about syntax it dislikes — the whole script silently never loads,
    // the buddy stops moving, `installed` reads false, and pressing Add helper
    // changes nothing. No error reaches any surface. The unit tests above load
    // this file into Node, which accepts arrow functions, template literals,
    // Map/Set, spread and optional chaining, so they cannot catch it.
    const { parse } = await import('acorn');
    const src = fs.readFileSync(HELPER_MAIN, 'utf8');
    expect(() => parse(src, { ecmaVersion: 5 })).not.toThrow();
  });
});

describe('orphan sweep', () => {
  const LIVE = 'youcodedbuddyhelper-aaaaaaaaaaaa';
  const DEAD = 'youcodedbuddyhelper-bbbbbbbbbbbb';

  function plant(scriptsDir: string, id: string, owner: string | null): void {
    const dir = path.join(scriptsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta: Record<string, unknown> = { KPlugin: { Id: id } };
    if (owner !== null) meta['X-YouCoded-Profile'] = owner;
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta), 'utf8');
  }

  it('never touches a package whose owning profile still exists', async () => {
    // THE LIVE-APP FAILURE THIS PREVENTS. A dev instance gets its own userData
    // directory (main.ts:286, from YOUCODED_PROFILE, which run-dev.sh always
    // exports), so its plugin id differs from production's — and without this
    // check production's helper looks exactly like an orphan. Launching a dev
    // instance would unload it from KWin and delete its files, the real app's
    // buddy would stop moving mid-session with no message, and it would never
    // repair itself (syncOnLaunch bails when its own package is missing).
    const r = rig();
    const liveProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-live-profile-'));
    plant(r.scriptsDir, LIVE, liveProfile);
    await r.helper.cleanOrphans();
    expect(fs.existsSync(path.join(r.scriptsDir, LIVE))).toBe(true);
    expect(r.calls.filter((c) => c.args.some((a: string) => a.includes(LIVE)))).toHaveLength(0);
    fs.rmSync(liveProfile, { recursive: true, force: true });
  });

  it('still sweeps a package whose owning profile is gone', async () => {
    const r = rig();
    plant(r.scriptsDir, DEAD, path.join(os.tmpdir(), 'yc-profile-that-was-deleted'));
    await r.helper.cleanOrphans();
    expect(fs.existsSync(path.join(r.scriptsDir, DEAD))).toBe(false);
  });

  it('still sweeps a package with no recorded profile at all', async () => {
    // A pre-fix install, or the probe's old package. Nothing is running it.
    const r = rig();
    plant(r.scriptsDir, DEAD, null);
    await r.helper.cleanOrphans();
    expect(fs.existsSync(path.join(r.scriptsDir, DEAD))).toBe(false);
  });

  it('stamps the owning profile into the package it installs', async () => {
    const r = rig();
    await r.helper.install();
    const meta: unknown = JSON.parse(
      fs.readFileSync(path.join(r.scriptsDir, r.helper.pluginId(), 'metadata.json'), 'utf8'),
    );
    expect((meta as Record<string, unknown>)['X-YouCoded-Profile']).toBe(r.userDataDir);
  });
});
