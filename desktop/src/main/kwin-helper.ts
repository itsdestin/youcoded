/**
 * kwin-helper.ts — installs, updates and removes the bundled KWin script that
 * lets the buddy move itself on a Wayland desktop.
 *
 * On native Wayland an app may not position or raise its own windows, and
 * Electron's setPosition() fails SILENTLY. The fix is a small script that runs
 * inside KWin itself (desktop/assets/kwin-helper/) and moves the window when
 * the app renames it. This file is everything around that script: deciding
 * whether it is needed at all, whether it can work here, putting it on disk,
 * telling KWin to load it, updating it, and taking it away again.
 *
 * Design: docs/active/design/2026-09-04-linux-buddy-helper/technical-design.md
 * (revision 7) §1, §4 and §6. Every runtime claim below was measured in
 * docs/active/prototypes/2026-09-04-buddy-kwin-helper-probe/FINDINGS.md.
 *
 * EVERYTHING THE COMPOSITOR TOUCHES IS INJECTED (KwinHelperIo). The unit tests
 * drive the whole lifecycle — install, update, rollback, orphan sweep — against
 * fakes and a temp directory, so none of it needs a running KDE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import {
  execQdbus,
  kdeCall,
  qdbusPath,
  qdbusStdoutFailure,
  readKdeSession,
  type KdeCallResult,
  type KdeSession,
} from './kde-dbus';

export type HelperStatus = {
  /**
   * The app cannot position its own windows here, so a helper is required at
   * all. NOT an environment variable and NOT KWin's "Operation Mode": probe
   * Round 7 measured XDG_SESSION_TYPE, WAYLAND_DISPLAY, DISPLAY,
   * XDG_CURRENT_DESKTOP and KWin's own Operation Mode as byte-identical
   * between a native-Wayland run and the same binary forced onto XWayland —
   * where setPosition genuinely works and no helper is wanted. Only Electron's
   * own resolved ozone platform flips. false ⇒ no helper UI, EXCEPT the Remove
   * helper action when `installed` is nonetheless true (§4, second row).
   */
  needed: boolean;
  /** A helper can work here: KWin >= 6 AND a Wayland session (§4). */
  supported: boolean;
  /** isScriptLoaded over DBus — never files-plus-config (§4). */
  installed: boolean;
  /** Why unsupported; for the honest disabled state. */
  reason?: string;
};

export type HelperResult = { ok: boolean; error?: string };

/** Everything that touches the compositor, the user's config or the clock. */
export type KwinHelperIo = {
  /** process.platform. */
  platform: string;
  /** Electron's RESOLVED ozone platform — `app.commandLine.getSwitchValue('ozone-platform')`. */
  ozonePlatform: string;
  /** This install's profile directory. The per-install token is derived from it. */
  userDataDir: string;
  /** Where the bundled package lives inside the app (desktop/assets/kwin-helper). */
  bundledDir: string;
  /** ~/.local/share/kwin/scripts */
  scriptsDir: string;
  /** A DBus call that RETURNS something (isScriptLoaded, unloadScript). */
  kdeCall: (args: string[]) => Promise<KdeCallResult>;
  /** A DBus call that returns VOID (reconfigure) — see kdeVoidCall below. */
  kdeVoidCall: (args: string[]) => Promise<HelperResult>;
  /** org.kde.KWin.supportInformation(), parsed. null = KWin not reachable. */
  readKdeSession: () => Promise<KdeSession | null>;
  /** Runs a plain binary (kwriteconfig6). Rejects on failure. */
  runBinary: (bin: string, args: string[]) => Promise<string>;
  /** Waits. Injected so the load wait below runs instantly in tests. */
  sleep: (ms: number) => Promise<void>;
  /** Date.now. Injected with sleep, so the wait's budget is drivable too. */
  now: () => number;
};

// The package name, and the prefix every install of it shares. The full plugin
// id is `<PLUGIN_ID_BASE>-<token>`: see helperPluginId().
const PLUGIN_ID_BASE = 'youcodedbuddyhelper';

// What counts as "one of ours" when sweeping for orphans. The un-suffixed form
// is included on purpose: the design probe installed a package under exactly
// that id while this feature was being measured, so a developer machine can
// still be carrying one.
const OURS = /^youcodedbuddyhelper(-[a-z0-9]+)?$/;

// KWin reads enabled scripts from ~/.config/kwinrc's [Plugins] group, one
// `<pluginId>Enabled` key each. Confirmed against a real installed script
// (tp-edges) on KWin 6.7.3.
const KWINRC = 'kwinrc';
const PLUGINS_GROUP = 'Plugins';

// Plasma 6's config writer. Plasma 5 ships kwriteconfig5, which is not a
// fallback: the helper needs KWin 6's scripting API and would never load there.
const KWRITECONFIG = 'kwriteconfig6';

// Same budget kde-dbus.ts uses for its own reads. A wedged compositor must not
// hang launch.
const CALL_TIMEOUT_MS = 4000;

const RECONFIGURE = ['org.kde.KWin', '/KWin', 'org.kde.KWin.reconfigure'];

// How long to wait for KWin to actually START the script after `reconfigure`,
// and how often to ask. MEASURED 2026-09-04 on KWin 6.7.3 (three consecutive
// unload+reconfigure cycles): isScriptLoaded answered `false` at 3ms and only
// flipped to `true` at 199ms, 199ms and 205ms. `reconfigure` returns void the
// instant KWin accepts it and tells us nothing about the load, so without this
// wait every install reported success while the script was not running yet —
// which is exactly what made "Add helper" turn the buddy on and then straight
// back off with "the helper is not running" (Destin, 2026-09-04). 5s is ~25x
// the measured figure.
const LOAD_WAIT_MS = 5000;
const LOAD_POLL_MS = 50;
const scriptingCall = (method: string, id: string): string[] => [
  'org.kde.KWin',
  '/Scripting',
  `org.kde.kwin.Scripting.${method}`,
  id,
];

type HelperSettings = { token?: string; helperLoadedVersion?: string };

/** Turns a rejected exec into a reason that reports what actually happened.
 *  Never substitutes a guessed cause for the real one. */
function describeError(err: unknown, fallback: string): string {
  const e = err as { stderr?: unknown; message?: unknown };
  if (typeof e?.stderr === 'string' && e.stderr.trim()) return e.stderr.trim().split('\n')[0];
  if (typeof e?.message === 'string' && e.message.trim()) return e.message.trim();
  return fallback;
}

/**
 * A DBus call to a method that returns VOID.
 *
 * WHY this cannot just be kde-dbus.ts's kdeCall: that wrapper treats empty
 * stdout as a failure, which is exactly right for a READ (a read that answered
 * nothing has failed) and exactly wrong here — `reconfigure` returns void, so
 * printing nothing IS the success case. The complaint/error detection is still
 * kde-dbus.ts's, reused rather than copied; only the empty case differs.
 */
async function kdeVoidCall(args: string[]): Promise<HelperResult> {
  const bin = await qdbusPath();
  if (!bin) return { ok: false, error: 'no qdbus6 or qdbus binary was found on PATH' };
  let stdout: string;
  try {
    stdout = await execQdbus(bin, args, { timeoutMs: CALL_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, error: describeError(err, `${bin} failed with no output`) };
  }
  const failure = stdout.trim() ? qdbusStdoutFailure(stdout) : null;
  return failure ? { ok: false, error: failure } : { ok: true };
}

/** Every file under `dir`, as paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export class KwinHelper {
  constructor(private readonly io: KwinHelperIo) {}

  // --- identity ---------------------------------------------------------

  private settingsPath(): string {
    return path.join(this.io.userDataDir, 'kwin-helper.json');
  }

  private readSettings(): HelperSettings {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as HelperSettings;
    } catch { /* absent or corrupt — treated as empty */ }
    return {};
  }

  private writeSettings(next: HelperSettings): void {
    try {
      fs.mkdirSync(this.io.userDataDir, { recursive: true });
      fs.writeFileSync(this.settingsPath(), JSON.stringify(next), 'utf8');
    } catch { /* read-only profile: the token is derived, so it still resolves */ }
  }

  /**
   * The per-install token. Derived from the profile directory, then REMEMBERED.
   *
   * WHY it exists: two YouCoded profiles on one machine (the built app and a
   * dev instance, or a reset profile) would otherwise fight over one KWin
   * package — each install overwriting the other's files. The token puts each
   * install in its own package, and cleanOrphans() removes the ones no live
   * profile owns any more.
   *
   * WHY it is remembered rather than only derived: if the profile directory is
   * ever renamed or moved, a purely derived token would change and this install
   * would instantly become the orphan of its own package.
   */
  private token(): string {
    const settings = this.readSettings();
    if (settings.token && /^[a-z0-9]{4,32}$/.test(settings.token)) return settings.token;
    const token = createHash('sha256').update(this.io.userDataDir).digest('hex').slice(0, 12);
    this.writeSettings({ ...settings, token });
    return token;
  }

  pluginId(): string {
    return `${PLUGIN_ID_BASE}-${this.token()}`;
  }

  private packageDir(): string {
    return path.join(this.io.scriptsDir, this.pluginId());
  }

  /** The Version of the package shipped inside this build. null = unreadable. */
  bundledVersion(): string | null {
    const version = this.bundledMetadata()?.KPlugin?.Version;
    return typeof version === 'string' && version ? version : null;
  }

  private bundledMetadata(): { KPlugin?: Record<string, unknown> & { Version?: unknown } } | null {
    try {
      // readFileSync is asar-aware; fs.cpSync and the recursive copy helpers are
      // NOT (design §1 / R1-13.1). Everything in this file reads and writes one
      // file at a time for exactly that reason, so the package works whether or
      // not it was unpacked out of app.asar.
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(this.io.bundledDir, 'metadata.json'), 'utf8'),
      );
      if (parsed && typeof parsed === 'object') {
        return parsed as { KPlugin?: Record<string, unknown> & { Version?: unknown } };
      }
      return null;
    } catch {
      return null;
    }
  }

  // --- status -----------------------------------------------------------

  /**
   * Does this session need a helper at all?
   *
   * Fail-safe: anything other than a confirmed native-Wayland Electron answers
   * NO. Getting this wrong in the "yes" direction takes a working buddy away
   * from a KDE X11 or XWayland user and hides it behind a consent card; getting
   * it wrong in the "no" direction leaves them exactly where they are today.
   */
  private isNeeded(): boolean {
    return this.io.platform === 'linux' && this.io.ozonePlatform === 'wayland';
  }

  /**
   * `kdeAnswered` is separate from `supported` on purpose: KDE can answer
   * clearly and still be a desktop the helper cannot run on (an X11 session, or
   * KWin 5). We still need to ask whether OUR script is loaded there — see
   * status() — because a helper installed on Wayland is still installed after
   * the user logs into X11.
   *
   * Every reason here is read by a person in the buddy's settings, so it says
   * what happened in plain words and never guesses a cause.
   */
  private async supportGate(): Promise<{ supported: boolean; reason?: string; kdeAnswered: boolean }> {
    const session = await this.io.readKdeSession();
    if (!session) {
      // Two different failures with two different meanings, so neither message
      // guesses: either the tool is missing, or KDE did not answer.
      const bin = await qdbusPath();
      return {
        supported: false,
        kdeAnswered: false,
        reason: bin
          ? "KDE didn't answer, so this desktop couldn't be checked. Restarting YouCoded usually clears it."
          : "A KDE command-line tool the helper needs (qdbus) isn't installed on this system.",
      };
    }
    if (session.kwinMajor < 6) {
      return { supported: false, kdeAnswered: true, reason: `This is KDE Plasma ${session.kwinMajor}; the helper needs Plasma 6 or newer.` };
    }
    if (!session.wayland) {
      return { supported: false, kdeAnswered: true, reason: 'This KDE session does not need the helper — the buddy can already be moved here.' };
    }
    return { supported: true, kdeAnswered: true };
  }

  /** installed = isScriptLoaded. Files-plus-config would report true when KWin
   *  has not reconfigured, or when the script threw on load (§4). */
  private async isLoaded(): Promise<boolean> {
    const res = await this.io.kdeCall(scriptingCall('isScriptLoaded', this.pluginId()));
    return res.ok && res.stdout.trim() === 'true';
  }

  /**
   * Poll until KWin reports the script running, or give up.
   *
   * Returns true the moment it is loaded. Never throws: a DBus failure mid-wait
   * is just another "not yet" until the budget runs out.
   */
  private async waitForLoad(pluginId: string): Promise<boolean> {
    // The budget is WALL-CLOCK, not a poll count. Every poll is a DBus call with
    // its own 4s timeout of its own, so counting polls would let a compositor
    // that answers slowly hold this for a hundred times the intended budget —
    // and this runs on the launch path, ahead of the buddy's IPC handlers.
    const deadline = this.io.now() + LOAD_WAIT_MS;
    for (;;) {
      const res = await this.io.kdeCall(scriptingCall('isScriptLoaded', pluginId));
      if (res.ok && res.stdout.trim() === 'true') return true;
      // Ask first, sleep second: never pay a wait for an answer nobody reads.
      if (this.io.now() >= deadline) return false;
      await this.io.sleep(LOAD_POLL_MS);
    }
  }

  async status(): Promise<HelperStatus> {
    // Off Linux there is no KDE to ask and never anything installed, so this is
    // the one short-circuit that asks the desktop nothing at all.
    if (this.io.platform !== 'linux') {
      return { needed: false, supported: false, installed: false };
    }

    const needed = this.isNeeded();
    const gate = await this.supportGate();

    // `installed` is reported TRUTHFULLY even when no helper is needed here
    // (§4, second row). A user can add the helper on Wayland and then log into
    // X11, or get an XWayland-backed build after an update: the script is still
    // installed and still loaded inside KWin, but `needed` is now false. Hiding
    // the whole helper section there would take away the Remove helper action
    // and break R10's promise — "you can remove it again any time, from the
    // buddy's own settings" — leaving hand-editing kwinrc as the only way out.
    // Ask whenever KDE answered at all — NOT only when the helper is supported
    // here (B5 review, F3). On a real KDE **X11** session KWin answers, reports
    // Operation Mode: X11, and `supported` is false — so gating the question on
    // `supported` forced installed:false and the Remove helper action never
    // rendered. That is precisely the "installed on Wayland, then logged into
    // X11" case §4's second row was written for, with hand-editing kwinrc as
    // the only way out. The script is still there; say so.
    const installed = gate.kdeAnswered ? await this.isLoaded() : false;

    if (!needed) return { needed: false, supported: gate.supported, installed };
    if (!gate.supported) {
      return { needed: true, supported: false, installed, reason: gate.reason };
    }
    return { needed: true, supported: true, installed };
  }

  // --- writing the package ---------------------------------------------

  private writeConfigKey(value: 'true' | 'false' | null, pluginId: string): Promise<string> {
    const key = `${pluginId}Enabled`;
    const args = ['--file', KWINRC, '--group', PLUGINS_GROUP, '--key', key];
    // A REMOVAL deletes the key rather than setting it false: [Plugins] would
    // otherwise accrue one dead entry per token, forever, every time a profile
    // is reset (§1).
    return this.io.runBinary(KWRITECONFIG, value === null ? [...args, '--delete'] : [...args, value]);
  }

  /** Copies the bundled package to `dest`, stamping in THIS install's plugin id. */
  private copyPackage(dest: string): void {
    const pluginId = this.pluginId();
    const metadata = this.bundledMetadata();
    if (!metadata) throw new Error(`the bundled helper package could not be read from ${this.io.bundledDir}`);
    for (const rel of listFiles(this.io.bundledDir)) {
      const target = path.join(dest, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (rel === 'metadata.json') {
        // The shipped metadata carries the un-suffixed id as a placeholder;
        // KWin keys the package by this value, so it has to become the
        // per-install one before it lands on disk.
        // X-YouCoded-Profile is how the orphan sweep tells a DEAD profile from a
        // LIVE one. Without it the sweep deletes any package that is not this
        // install's — and a dev instance gets its own userData directory
        // (main.ts:286, driven by YOUCODED_PROFILE, which run-dev.sh always
        // exports), so production and every dev instance are permanently each
        // other's "orphan". Launching a dev instance would unload and delete the
        // real app's helper mid-session, its buddy would stop moving with no
        // message, and it would never repair itself.
        const stamped = {
          ...metadata,
          KPlugin: { ...metadata.KPlugin, Id: pluginId },
          'X-YouCoded-Profile': this.io.userDataDir,
        };
        fs.writeFileSync(target, `${JSON.stringify(stamped, null, 4)}\n`, 'utf8');
      } else {
        fs.writeFileSync(target, fs.readFileSync(path.join(this.io.bundledDir, ...rel.split('/'))));
      }
    }
  }

  /**
   * The one sequence both install and update run: copy the files, tell KWin the
   * script is enabled, UNLOAD it, then reconfigure — and only then record the
   * version.
   *
   * THE ORDER IS A MEASUREMENT, NOT A PREFERENCE (probe Round 4, U1).
   * Overwriting a loaded script's files and calling `reconfigure` does NOT
   * reload it: the files change, isScriptLoaded stays true, and KWin goes on
   * running the copy it parsed at login. `unloadScript` first, then
   * `reconfigure`, does reload it in the same session. Without the unload the
   * promise "updates replace the helper quietly" silently degrades to "at your
   * next login", and a user who updated the app keeps running the previous
   * helper — possibly one built against an older caption grammar. `unloadScript`
   * on an id that is not loaded returns false harmlessly (U3), so the fresh
   * install runs the identical sequence.
   *
   * `rollback` is true only for a FRESH install. §1 requires that a failed
   * install leave nothing behind, because files on disk with installed:false
   * would be re-copied on every retry. On an UPDATE there is nothing to roll
   * back TO — the previous package's files are already overwritten — so a
   * failure there deliberately leaves the half-updated package in place and
   * relies on the version marker to re-run the whole sequence next launch.
   */
  private async applyPackage(opts: { rollback: boolean }): Promise<HelperResult> {
    const pluginId = this.pluginId();
    const dest = this.packageDir();

    const undo = async (): Promise<void> => {
      if (!opts.rollback) return;
      await this.writeConfigKey(null, pluginId).catch(() => { /* best effort */ });
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    try {
      this.copyPackage(dest);
    } catch (err) {
      // Gated on `rollback`, like every other failure path here. On an UPDATE
      // there is nothing to roll back TO — the previous package's files are
      // already overwritten — so deleting it would throw away a helper that was
      // working, and the version marker could not repair it (syncOnLaunch bails
      // when the package directory is missing). A half-updated package left in
      // place is what lets the next launch notice and re-run the sequence.
      await undo();
      return { ok: false, error: describeError(err, 'the helper files could not be written') };
    }

    try {
      await this.writeConfigKey('true', pluginId);
    } catch (err) {
      await undo();
      return { ok: false, error: describeError(err, `${KWRITECONFIG} could not enable the helper`) };
    }

    const unloaded = await this.io.kdeCall(scriptingCall('unloadScript', pluginId));
    if (!unloaded.ok) {
      await undo();
      // helperLoadedVersion is deliberately NOT written here. On the update
      // path that is what makes the next launch re-run the whole sequence
      // instead of seeing equal versions and leaving the user on a stale
      // helper that reports itself up to date (R4-F6, crash window 1).
      return { ok: false, error: unloaded.reason };
    }

    const reconfigured = await this.io.kdeVoidCall(RECONFIGURE);
    if (!reconfigured.ok) {
      await undo();
      // Crash window 2: the script is unloaded, so `installed` reads false and
      // the buddy is gated off. Again no version is recorded, so the next
      // launch repairs it rather than finding "files present, versions equal,
      // nothing to do".
      return { ok: false, error: reconfigured.error };
    }

    // KWin loads the script ASYNCHRONOUSLY: `reconfigure` returns as soon as the
    // compositor accepts the request, ~200ms before the script is running (see
    // LOAD_WAIT_MS). Step 3 above unloaded it, so `isScriptLoaded` is false
    // right now and flipping back to true is unambiguous proof that KWin
    // re-read the package and started THIS copy — which also closes the gap the
    // old comment here described, where nothing could tell a reload from the
    // stale script still running.
    if (!(await this.waitForLoad(pluginId))) {
      // Deliberately NOT rolled back: the files are written and the config key
      // is set, so this is a KWin that has not got to it yet rather than a
      // failed install, and the next launch's syncOnLaunch repairs it. No
      // version is recorded, so that repair will re-run the whole sequence.
      return { ok: false, error: 'KDE has not started the helper yet.' };
    }

    // ONLY NOW. The marker records WHAT WE DID, not what KWin is running —
    // nothing can verify the reload actually happened, because isScriptLoaded
    // is true for the old and the new script alike and no loaded script reports
    // its version over DBus. That is precisely why the marker must not be the
    // installed metadata.json, which step 1 has already overwritten.
    const version = this.bundledVersion();
    if (version) this.writeSettings({ ...this.readSettings(), helperLoadedVersion: version });
    return { ok: true };
  }

  // --- the public lifecycle ---------------------------------------------

  async install(): Promise<HelperResult> {
    const status = await this.status();
    if (!status.needed) {
      return { ok: false, error: 'This desktop can position the buddy without a helper, so nothing was installed.' };
    }
    if (!status.supported) {
      return { ok: false, error: status.reason ?? 'The helper is not supported on this desktop.' };
    }
    await this.cleanOrphans();
    // A package directory that is already there means this is a repair or a
    // re-enable, not a first install — so a failure must not delete files that
    // were working before this attempt.
    const fresh = !fs.existsSync(this.packageDir());
    return this.applyPackage({ rollback: fresh });
  }

  /**
   * Removal, in the order §6 requires. Anything else looks to the user like a
   * silent failure: delete the files first and KWin keeps running the copy it
   * already parsed until logout, so the buddy carries on moving after the user
   * has been told the helper is gone.
   */
  async remove(): Promise<HelperResult> {
    const pluginId = this.pluginId();

    const unloaded = await this.io.kdeCall(scriptingCall('unloadScript', pluginId));
    // Stop here rather than deleting anyway. If the script cannot be unloaded
    // it is still running, and removing its files would report success while
    // the buddy kept moving — the one outcome this order exists to prevent.
    if (!unloaded.ok) return { ok: false, error: unloaded.reason };

    try {
      await this.writeConfigKey('false', pluginId);
    } catch (err) {
      return { ok: false, error: describeError(err, `${KWRITECONFIG} could not disable the helper`) };
    }

    const reconfigured = await this.io.kdeVoidCall(RECONFIGURE);
    if (!reconfigured.ok) return { ok: false, error: reconfigured.error };

    try {
      fs.rmSync(this.packageDir(), { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: describeError(err, 'the helper files could not be removed') };
    }

    // Now that the script is unloaded and its files are gone, drop the config
    // key entirely (§1: never leave a dead [Plugins] entry behind). KWin has
    // already re-read the config as disabled, so this needs no second
    // reconfigure and its failure must not fail the removal.
    await this.writeConfigKey(null, pluginId).catch(() => { /* cosmetic */ });

    // Clearing the marker means a later re-install runs the full sequence
    // rather than believing this version is already loaded.
    const settings = this.readSettings();
    delete settings.helperLoadedVersion;
    this.writeSettings(settings);
    return { ok: true };
  }

  /**
   * Removes every YouCoded helper package that is not THIS install's.
   *
   * WHY unloadScript comes before deleting the directory (R4-F7): Round 4
   * measured that deleting a script's files does not stop KWin executing the
   * copy it already parsed. An orphan is not inert — it still matches our
   * WM_CLASS and our caption grammar, so N orphans mean N compositor handlers
   * writing geometry on every drag frame, and an orphan built against an older
   * caption grammar mis-parses the new one. A fresh or reset profile mints a
   * new token, which is exactly how orphans appear.
   */
  /**
   * Is this package owned by a profile that STILL EXISTS on disk?
   *
   * A package with no recorded profile is sweepable — that is a pre-fix install
   * or the probe's old un-suffixed package, and nothing is running it. A package
   * whose profile directory is still there belongs to a sibling install that may
   * be running RIGHT NOW (production while a dev instance launches, or the other
   * way round), and taking its helper out from under it is exactly the
   * live-app-safety failure this check exists to prevent.
   */
  private ownedByLiveProfile(id: string): boolean {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(this.io.scriptsDir, id, 'metadata.json'), 'utf8'),
      );
      const owner = (parsed as { 'X-YouCoded-Profile'?: unknown } | null)?.['X-YouCoded-Profile'];
      if (typeof owner !== 'string' || !owner) return false;
      return fs.existsSync(owner);
    } catch {
      // Unreadable metadata means we cannot vouch for it. Err towards leaving it
      // alone: a stale package is inert once unloaded, a deleted live one is not.
      return true;
    }
  }

  async cleanOrphans(): Promise<void> {
    const mine = this.pluginId();
    let orphans: string[];
    try {
      orphans = fs
        .readdirSync(this.io.scriptsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== mine && OURS.test(e.name))
        .map((e) => e.name)
        .filter((id) => !this.ownedByLiveProfile(id));
    } catch {
      return; // no KWin scripts directory on this machine: nothing to sweep
    }
    if (orphans.length === 0) return;

    for (const id of orphans) {
      await this.io.kdeCall(scriptingCall('unloadScript', id));
      await this.writeConfigKey(null, id).catch(() => { /* best effort */ });
      try {
        fs.rmSync(path.join(this.io.scriptsDir, id), { recursive: true, force: true });
      } catch { /* best effort — a leftover directory is inert once unloaded */ }
    }
    // One reconfigure for the whole batch, not one per orphan.
    await this.io.kdeVoidCall(RECONFIGURE);
  }

  /**
   * Launch-time housekeeping, run before the buddy exists.
   *
   * Never installs anything the user has not consented to: the update path is
   * gated on a package directory already being there. The orphan sweep runs
   * regardless of whether this session needs a helper, because an orphan left
   * by another profile keeps running inside the compositor either way.
   */
  async syncOnLaunch(): Promise<void> {
    if (this.io.platform !== 'linux') return;
    await this.cleanOrphans();
    if (!this.isNeeded()) return;
    if (!fs.existsSync(this.packageDir())) return;

    const bundled = this.bundledVersion();
    if (!bundled) return; // cannot read our own asset — do not churn the user's config
    if (this.readSettings().helperLoadedVersion === bundled) return;

    const res = await this.applyPackage({ rollback: false });
    if (!res.ok) {
      // Nothing is waiting on this, and there is no honest user-facing message
      // to show at launch — so report the REAL reason to the log and let the
      // next launch retry, which is what the unwritten version marker buys.
      console.warn(`[kwin-helper] update to ${bundled} did not complete: ${res.error ?? 'unknown'}`);
    }
  }
}

// --- the module-level contract (design §1's signatures) -------------------

let instance: KwinHelper | null = null;

function readOzonePlatform(): string {
  // Electron resolves --ozone-platform itself even though we never pass it;
  // this is the ONLY in-process signal that separates a native Wayland surface
  // from an XWayland one (probe Round 7). Read through an optional shape
  // because the test stub for `electron` carries no commandLine, and an import
  // must never crash on that.
  const cli = (app as { commandLine?: { getSwitchValue?: (name: string) => string } }).commandLine;
  try {
    return typeof cli?.getSwitchValue === 'function' ? cli.getSwitchValue('ozone-platform') : '';
  } catch {
    return '';
  }
}

function helper(): KwinHelper {
  if (instance) return instance;
  instance = new KwinHelper({
    platform: process.platform,
    ozonePlatform: readOzonePlatform(),
    userDataDir: app.getPath('userData'),
    // Same shape main.ts uses for the tray icon: compiled main lives in
    // dist/main, and assets/ sits two levels up beside it.
    bundledDir: path.join(__dirname, '../../assets/kwin-helper'),
    scriptsDir: path.join(os.homedir(), '.local', 'share', 'kwin', 'scripts'),
    kdeCall,
    kdeVoidCall,
    readKdeSession,
    runBinary: (bin, args) => execQdbus(bin, args, { timeoutMs: CALL_TIMEOUT_MS }),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
  });
  return instance;
}

/** youcodedbuddyhelper-<per-install token>. */
export function helperPluginId(): string {
  return helper().pluginId();
}

export function helperStatus(): Promise<HelperStatus> {
  return helper().status();
}

export function installHelper(): Promise<HelperResult> {
  return helper().install();
}

export function removeHelper(): Promise<HelperResult> {
  return helper().remove();
}

/** Orphan sweep + the R11 version check. Runs at launch, before the buddy. */
export function syncHelperOnLaunch(): Promise<void> {
  return helper().syncOnLaunch();
}
