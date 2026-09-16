import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
// WHY imported rather than declared here: the qdbus binary list and the exec
// wrapper now live in kde-dbus.ts, so this file and the buddy work-area
// resolver discover qdbus the same way instead of keeping two copies that can
// drift. Nothing about THIS file's behaviour changed — execQdbus with no
// options is the same execFile call, and the candidate loop below is untouched.
import { QDBUS_CANDIDATES, execQdbus } from './kde-dbus';

// WHY a fixed plugin name (not per-invocation): KWin's Scripting DBus
// interface keys loaded scripts by pluginName, and unloadScript() takes that
// name (not the file path) to tear one down. Reusing this one name across
// calls means a stale/never-unloaded script from a crashed prior run gets
// silently replaced rather than accumulating under new names.
const PLUGIN_NAME = 'youcoded-buddy-keepabove';

/**
 * Pure builder for the one-shot KWin script that pins (or unpins) the
 * window whose caption exactly matches `title`. Kept free of any DBus/
 * filesystem side effects so it's unit-testable — see
 * tests/kwin-keep-above.test.ts.
 *
 * WHY JSON.stringify (never raw string interpolation): the title is spliced
 * into a JS string literal inside the generated script text. An unescaped
 * title containing a quote or backslash (a malicious or just unlucky window
 * caption) could break out of that literal and inject arbitrary KWin script
 * code, which KWin would then execute with the compositor's privileges.
 * JSON.stringify produces a safe, self-contained JS string literal for any
 * input.
 */
export function buildKeepAboveScript(title: string, keepAbove: boolean): string {
  const TITLE_JSON = JSON.stringify(title);
  const KEEP = keepAbove ? 'true' : 'false';
  return (
    `for (const w of workspace.windowList()) {\n` +
    `  if (w.caption === ${TITLE_JSON}) { w.keepAbove = ${KEEP}; }\n` +
    `}\n`
  );
}

/**
 * Injects buildKeepAboveScript(title, keepAbove) into the running KWin
 * instance over its Scripting DBus interface: loadScript → run →
 * unloadScript (recipe validated live 2026-07-22 against KWin 6.7.3 on
 * Plasma Wayland — see docs/active/prototypes/2026-07-22-buddy-wayland-
 * workbench/FINDINGS.md and kwin-probe.js for the archived probe).
 *
 * NEVER throws. Returns false on any failure — missing qdbus6/qdbus binary,
 * no org.kde.KWin DBus service (GNOME, wlroots, non-KDE Linux), a script
 * load/run error — so callers can fire this unconditionally as a silent
 * no-op everywhere the KWin scripting API doesn't exist.
 */
export async function applyKwinKeepAbove(title: string, keepAbove: boolean): Promise<boolean> {
  // Unique per-call filename: two toggles in flight at once (rapid Settings
  // clicking) must not race each other's write/read/unlink of the same path.
  const scriptPath = join(tmpdir(), `youcoded-buddy-keepabove-${randomUUID()}.js`);
  try {
    await writeFile(scriptPath, buildKeepAboveScript(title, keepAbove), 'utf8');
    for (const qdbus of QDBUS_CANDIDATES) {
      // Tracks whether loadScript actually succeeded THIS iteration, so the
      // finally block below knows whether there's anything to unload —
      // covers both the success path AND run() rejecting after a
      // successful load (fix: previously only the success path unloaded,
      // leaking the script under PLUGIN_NAME on a partial failure).
      let loaded = false;
      try {
        const stdout = await execQdbus(qdbus, [
          'org.kde.KWin',
          '/Scripting',
          'org.kde.kwin.Scripting.loadScript',
          scriptPath,
          PLUGIN_NAME,
        ]);
        // loadScript returns the numeric script id as bare stdout text
        // (e.g. "3") on success. A missing/malformed id means this qdbus
        // binary resolved but KWin's scripting service didn't respond
        // sanely — treat as failure and don't try running a bogus id.
        const id = stdout.trim();
        if (!id || Number.isNaN(Number(id))) continue;
        loaded = true;
        await execQdbus(qdbus, [
          'org.kde.KWin',
          `/Scripting/Script${id}`,
          'org.kde.kwin.Script.run',
        ]);
        return true;
      } catch {
        // Either this qdbus binary is missing / the loadScript DBus call
        // failed (no KWin service, wrong session type, etc) — nothing was
        // loaded, `loaded` stays false — or loadScript succeeded but run()
        // rejected, in which case `loaded` is true and the finally below
        // unloads it. Either way, try the next candidate name.
        continue;
      } finally {
        if (loaded) {
          // Best-effort cleanup on this path too: run() may have partially
          // applied (or thrown after applying — KWin scripts execute
          // synchronously so a reject here means run() itself errored, not
          // that keepAbove was left half-set), but leaving the plugin name
          // loaded either way just wastes a slot until the next call
          // replaces it, so don't let a failed unload block the retry loop.
          await execQdbus(qdbus, [
            'org.kde.KWin',
            '/Scripting',
            'org.kde.kwin.Scripting.unloadScript',
            PLUGIN_NAME,
          ]).catch(() => {});
        }
      }
    }
    return false;
  } catch {
    // writeFile failed (e.g. no writable tmpdir) — no DBus call was made.
    return false;
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}
