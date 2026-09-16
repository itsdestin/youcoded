import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Rect } from '../shared/buddy-geometry';

const execFileAsync = promisify(execFile);

// Re-exported so callers that only talk to KDE don't have to reach into the
// buddy geometry module for the rectangle shape. Same type, one definition.
export type { Rect };

// Modern Plasma 6 ships `qdbus6`; some distros/older Plasma still resolve only
// `qdbus`. Try the current name first, fall back to the legacy one. Lifted
// verbatim out of kwin-keep-above.ts, which now imports it from here — the
// technical design (§7) says reuse this discovery, do not re-implement it.
export const QDBUS_CANDIDATES = ['qdbus6', 'qdbus'] as const;

// A DBus round trip to KWin or plasmashell is 2-10 ms when the service is
// there (probe FINDINGS K4/K5). WHY a timeout at all: the work-area resolve is
// AWAITED before the very first buddy window is created (design §0.6), so a
// wedged qdbus — a half-dead compositor, a bus that never answers — would hang
// the buddy forever with no error anywhere. Four seconds is far past any real
// answer and far short of "the app looks broken".
const KDE_CALL_TIMEOUT_MS = 4000;

/**
 * Raw qdbus exec. Resolves the child's stdout; REJECTS on a spawn failure, a
 * non-zero exit, or the timeout.
 *
 * Deliberately dumb: it makes no judgement about the CONTENT of stdout. That
 * judgement lives in kdeCall() below, because kwin-keep-above.ts's own retry
 * loop predates it and must keep behaving exactly as it did (it passes no
 * options, so there is no timeout on that path either).
 */
export async function execQdbus(
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<string> {
  const { stdout } = await execFileAsync(
    bin,
    args,
    opts?.timeoutMs ? { timeout: opts.timeoutMs } : {},
  );
  return stdout;
}

// Resolved qdbus binary, cached after the first SUCCESSFUL discovery. A
// negative result is deliberately not cached: a session that had no qdbus at
// launch is a session where every later call fails anyway, and re-probing costs
// one failed spawn rather than permanently poisoning a machine where the
// package arrived later.
let cachedQdbusPath: string | null = null;

/** True when the OS could not find the program at all (as opposed to the
 *  program running and complaining). `code` is set by child_process on spawn
 *  failure; `errno`/`path` come along with it. */
function isMissingBinary(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * qdbus6, then qdbus. Cached after first success. null = neither exists.
 *
 * WHY `--help` as the probe: it needs no DBus service to be running, so this
 * answers "is the binary installed" without also asking "is KDE up" — two
 * different failures that need two different messages.
 */
export async function qdbusPath(): Promise<string | null> {
  if (cachedQdbusPath) return cachedQdbusPath;
  for (const candidate of QDBUS_CANDIDATES) {
    try {
      await execQdbus(candidate, ['--help'], { timeoutMs: KDE_CALL_TIMEOUT_MS });
      cachedQdbusPath = candidate;
      return candidate;
    } catch (err) {
      // The binary exists but exited non-zero on --help (older builds print
      // usage to stderr and exit 1). It is still the binary we want.
      if (!isMissingBinary(err)) {
        cachedQdbusPath = candidate;
        return candidate;
      }
      continue;
    }
  }
  return null;
}

export type KdeCallResult = { ok: true; stdout: string } | { ok: false; reason: string };

// qdbus writes its own complaints as "qdbus: <text>" / "qdbus6: <text>", and
// DBus transport errors surface as "Error: org.freedesktop.DBus.Error.*".
const QDBUS_COMPLAINT = /^qdbus[0-9]*: .*$/m;
const DBUS_ERROR_LINE = /^Error: org\.freedesktop\.DBus\.Error\..*$/m;

/**
 * Decides whether a qdbus run that EXITED ZERO actually failed. Returns the
 * offending text (used verbatim as the failure reason — never a guess), or
 * null when stdout looks like a real answer.
 *
 * WHY this exists, and why it is the single most load-bearing function in this
 * file: measured 2026-09-04, `qdbus6` cannot render a DBus struct without
 * `--literal`, and it writes that complaint to **stdout** and **exits 0**:
 *
 *   exit=0 stdout=[qdbus: I don't know how to display an argument of type '(iiii)', run with --literal.]
 *
 * A wrapper that trusts the exit code (which is what the repo had) would hand
 * that sentence to a number parser, get NaN, and quietly place the buddy 52 px
 * too low on top of the user's taskbar with no error anywhere.
 */
export function qdbusStdoutFailure(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return 'the DBus call returned no output';
  const complaint = QDBUS_COMPLAINT.exec(text) ?? DBUS_ERROR_LINE.exec(text);
  if (complaint) return complaint[0].trim();
  return null;
}

/** Turns an execFile rejection into a reason string that reports what actually
 *  happened. Never substitutes a guessed cause for the real one. */
function describeExecError(bin: string, err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; killed?: unknown };
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr.split('\n')[0].trim();
  if (typeof e?.message === 'string' && e.message.trim()) return e.message.trim();
  return `${bin} failed with no output`;
}

/**
 * One qdbus call. Treats an unparseable/error stdout as failure even at exit 0
 * — see qdbusStdoutFailure above. This is the wrapper every NEW KDE read must
 * use; kwin-keep-above.ts's raw loop is not enough.
 */
export async function kdeCall(args: string[]): Promise<KdeCallResult> {
  const bin = await qdbusPath();
  if (!bin) return { ok: false, reason: 'no qdbus6 or qdbus binary was found on PATH' };
  let stdout: string;
  try {
    stdout = await execQdbus(bin, args, { timeoutMs: KDE_CALL_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, reason: describeExecError(bin, err) };
  }
  const failure = qdbusStdoutFailure(stdout);
  if (failure) return { ok: false, reason: failure };
  return { ok: true, stdout };
}

export type KdeScreen = { name: string; enabled: boolean; bounds: Rect; scale: number };
export type KdeSession = { kwinMajor: number; wayland: boolean; screens: KdeScreen[] };

// WHY anchored to the start of a line with the words "KWin version": the
// supportInformation block opens with a section header that is literally the
// word "Version" on its own line, two lines above the real field:
//
//     Version
//     =======
//     KWin version: 6.7.3
//
// A loose /Version:?\s*(\d+)/ matches the header and returns garbage, which
// would let a Plasma 5 session pass the "KWin >= 6" gate (design §4, R3-F10).
const KWIN_VERSION = /^KWin version:\s*(\d+)/m;
const OPERATION_MODE = /^Operation Mode:\s*(.+)$/m;
// "Geometry: 0,0,1707x1067" — x,y then WxH. Verified against KWin 6.7.3.
const SCREEN_GEOMETRY = /^(-?\d+),(-?\d+),(\d+)x(\d+)$/;

/**
 * Parses org.kde.KWin.supportInformation()'s text into the three things this
 * feature needs from it: the KWin major version, whether the session is
 * Wayland, and the screen inventory (names, which Electron cannot supply —
 * `display.label` is "Built-in Screen", not "eDP-1").
 *
 * Exported for tests — pure.
 */
export function parseSupportInformation(text: string): KdeSession | null {
  const version = KWIN_VERSION.exec(text);
  if (!version) return null;
  const kwinMajor = Number(version[1]);
  if (!Number.isFinite(kwinMajor)) return null;
  const mode = OPERATION_MODE.exec(text);
  return {
    kwinMajor,
    wayland: (mode?.[1] ?? '').trim() === 'Wayland',
    screens: parseScreens(text),
  };
}

/**
 * The `Screens` section of supportInformation, which looks like this (KWin
 * 6.7.3, captured 2026-09-04):
 *
 *     Screens
 *     =======
 *     Number of Screens: 1
 *
 *     Screen 0:
 *     ---------
 *     Name: eDP-1
 *     Enabled: 1
 *     Geometry: 0,0,1707x1067
 *     Physical size: 288x180mm
 *     Scale: 1.5
 *
 * Section headers are underlined with "=", per-screen headers with "-", which
 * is how this tells "the next screen" from "the next section" without a list
 * of every section name.
 */
function parseScreens(text: string): KdeScreen[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(
    (line, i) => line.trim() === 'Screens' && /^=+$/.test((lines[i + 1] ?? '').trim()),
  );
  if (start < 0) return [];

  const screens: KdeScreen[] = [];
  let fields: Map<string, string> | null = null;

  const flush = (): void => {
    if (!fields) return;
    const name = fields.get('Name')?.trim() ?? '';
    const geometry = SCREEN_GEOMETRY.exec(fields.get('Geometry')?.trim() ?? '');
    // A screen with no name cannot be asked for its work area (the DBus call
    // takes the name), and one with no parseable geometry cannot be matched to
    // an Electron display. Either way there is nothing to do with it.
    if (name && geometry) {
      const enabledRaw = fields.get('Enabled')?.trim();
      const scale = Number(fields.get('Scale')?.trim());
      screens.push({
        name,
        // WHY absence means ENABLED: the field is present on KWin 6, so a
        // missing one means a KWin that formats this block differently. Reading
        // that as "disabled" would drop every screen and silently turn the whole
        // feature off; reading it as "enabled" costs nothing, because a screen
        // that isn't really there won't match any Electron display anyway.
        enabled: enabledRaw === undefined ? true : enabledRaw === '1',
        bounds: {
          x: Number(geometry[1]),
          y: Number(geometry[2]),
          width: Number(geometry[3]),
          height: Number(geometry[4]),
        },
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      });
    }
    fields = null;
  };

  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    // The next "====="-underlined header ends the Screens section.
    if (line && /^=+$/.test((lines[i + 1] ?? '').trim())) break;
    if (/^Screen \d+:$/.test(line)) {
      flush();
      fields = new Map();
      continue;
    }
    if (!fields) continue;   // e.g. the "Number of Screens: 1" line above the first screen
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (kv) fields.set(kv[1].trim(), kv[2]);
  }
  flush();
  return screens;
}

/** Parses org.kde.KWin.supportInformation(). null = KWin not reachable. */
export async function readKdeSession(): Promise<KdeSession | null> {
  const res = await kdeCall(['org.kde.KWin', '/KWin', 'org.kde.KWin.supportInformation']);
  if (!res.ok) return null;
  return parseSupportInformation(res.stdout);
}
