// Sends one /app/heartbeat per UTC day, gated by an opt-out toggle.
// WHY once per day is a CONTRACT, not a tuning knob: AboutPopup.tsx promises
// users "anonymous usage data … once per day". Sending more often (to fix a
// counting gap, say) rewrites that copy — a product decision. The day boundary
// is UTC on every device; the owner dashboard chooses which clock it counts by.
// Identity is HMAC_SHA256(SALT, machine_id || platform), computed
// client-side. Fire-and-forget — any failure is swallowed and retried
// next launch. Zero behavioral impact if the network is unreachable.
//
// Besides the daily check-in, two kinds of one-time message exist (Destin,
// 2026-10-31, analytics deck U-2 / U-6), both listed in About → Privacy:
//   - setup MILESTONES, each sent at most once per device, ever, and only on a
//     fresh install: first_open, setup_done, first_message, setup_failed_<step>.
//   - one OPT-OUT notice when the switch is turned off, then nothing again.
//
// Privacy: the raw machine_id never leaves the device. See the design
// spec at docs/superpowers/specs/2026-05-01-device-id-analytics-design.md
// for the threat model.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID, createHmac } from "node:crypto";
import { machineIdSync } from "node-machine-id";
import { ANALYTICS_SALT } from "./analytics-salt";
import { OFFICIAL_BUILD } from "./official-build";

// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
const API_BASE = "https://api.youcoded.ai";
const ANALYTICS_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");
// WHY a separate marker file, not a setting: scripts (the dev workspace's setup,
// VM provisioning) create it with one command, and its presence alone says
// "this is a team device" — check-ins still go out, marked, and the owner
// dashboard leaves them out unless "My devices" is on (analytics deck D-2).
export const TEAM_DEVICE_FILE = path.join(os.homedir(), ".claude", "youcoded-team-device");

export type AnalyticsPlatform = "desktop" | "android";
export type Milestone = "first_open" | "setup_done" | "first_message" | `setup_failed_${string}`;

interface AnalyticsState {
  optIn: boolean;
  lastPingedDate: string;       // YYYY-MM-DD UTC, or "" when never pinged
  fallbackDeviceId?: string;    // present only if machine_id read failed
  // Setup milestones already sent (true) or still owed (false). The key
  // "baseline" = an install that existed before milestones did: it sends none.
  milestones?: Record<string, boolean>;
  optOutReported?: boolean;
}

function defaultState(): AnalyticsState {
  return { optIn: true, lastPingedDate: "" };
}

// Which kind of device this copy runs on. The Android app runs this same
// backend headless (headless-boot.ts sets "android"); everything else is a computer.
// WHY explicit, not process.platform: 1.3.1–1.3.3 phones checked in as
// "desktop" because this file assumed it (analytics audit, 2026-10-31).
let platformKind: AnalyticsPlatform = "desktop";
export function setAnalyticsPlatform(kind: AnalyticsPlatform): void {
  platformKind = kind;
}

function mapOs(platform: NodeJS.Platform): string {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  return "";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Why this copy must send nothing at all, or null when it may send.
// WHY each: automated smoke tests and throwaway VMs are not users
// (YOUCODED_NO_ANALYTICS is the general "test run" switch every test script
// sets, deck D-3); only official releases count (deck D-1); test-build
// versions are belt-and-braces for a mis-stamped build.
export function analyticsSuppression(
  env: NodeJS.ProcessEnv = process.env,
  version: string = app.getVersion(),
  official: boolean = OFFICIAL_BUILD,
): "smoke-test" | "switched-off" | "unofficial-build" | "test-build" | null {
  if (env.YOUCODED_SMOKE_TEST === "1") return "smoke-test";
  if (env.YOUCODED_NO_ANALYTICS === "1") return "switched-off";
  if (!official) return "unofficial-build";
  if (/-(dev|releasetest)(\.|$)/.test(version)) return "test-build";
  return null;
}

function readState(): AnalyticsState | null {
  try {
    const raw = fs.readFileSync(ANALYTICS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AnalyticsState> & {
      installId?: string;
      installReported?: boolean;
    };
    // Drop legacy installId / installReported silently — they're meaningless
    // post-cutover. The on-disk file gets rewritten on the next writeState().
    return {
      optIn: typeof parsed.optIn === "boolean" ? parsed.optIn : true,
      lastPingedDate: typeof parsed.lastPingedDate === "string" ? parsed.lastPingedDate : "",
      fallbackDeviceId: typeof parsed.fallbackDeviceId === "string" ? parsed.fallbackDeviceId : undefined,
      milestones: parsed.milestones && typeof parsed.milestones === "object" ? { ...parsed.milestones } : undefined,
      optOutReported: parsed.optOutReported === true ? true : undefined,
    };
  } catch {
    // null = no readable file: a fresh install (see milestones below).
    return null;
  }
}

function writeState(state: AnalyticsState): void {
  fs.mkdirSync(path.dirname(ANALYTICS_FILE), { recursive: true });
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(state, null, 2));
}

export function getOptIn(): boolean {
  return (readState() ?? defaultState()).optIn;
}

export function setOptIn(value: boolean): void {
  const state = readState() ?? defaultState();
  const wasOn = state.optIn;
  state.optIn = value;
  writeState(state);
  // The one opt-out notice (deck U-6): only on an on→off flip, once per device.
  if (wasOn && !value && !state.optOutReported && analyticsSuppression() === null) {
    void reportOptOut();
  }
}

async function reportOptOut(): Promise<void> {
  const team = await isTeamDevice();
  // WHY no device hash: the person just asked us to stop identifying this
  // device, so the notice carries only what a dashboard total needs.
  const ok = await postEvent("/app/opt-out", {
    appVersion: app.getVersion(),
    platform: platformKind,
    os: platformKind === "android" ? "" : mapOs(process.platform),
    ...(team ? { team: true } : {}),
  });
  if (ok) {
    const state = readState() ?? defaultState();
    state.optOutReported = true;
    writeState(state);
  }
}

export async function isTeamDevice(): Promise<boolean> {
  try {
    await fs.promises.access(TEAM_DEVICE_FILE);
    return true;
  } catch {
    return false;
  }
}

// Computes the device-id hash. Mutates state.fallbackDeviceId and persists
// the state file when the machine_id read fails.
export function deviceIdHash(state: AnalyticsState): string {
  let raw = "";
  let suffix: string = process.platform;
  if (platformKind === "android") {
    // WHY the phone's own ID, handed over by the Android shell
    // (BackendService.kt → YOUCODED_ANDROID_ID, read once by headless-main.ts):
    // it survives reinstalls, and `${ANDROID_ID}|android` is exactly the 1.3.0
    // phone app's formula, so updated phones get their old identity back (deck
    // F-2). node-machine-id is never asked on a phone: it either fails or
    // answers the shared hostname "localhost", which would merge every phone.
    raw = androidId;
    suffix = "android";
  } else {
    try {
      raw = machineIdSync(true);  // `true` = return raw machine_id rather than the SHA-256 of it
    } catch {
      // swallowed — caught by the length check below
    }
  }
  if (!raw || raw.length < 8) {
    if (!state.fallbackDeviceId) {
      state.fallbackDeviceId = randomUUID();
      writeState(state);
    }
    raw = `fallback:${state.fallbackDeviceId}`;
  }
  return createHmac("sha256", ANALYTICS_SALT)
    .update(`${raw}|${suffix}`)
    .digest("hex");
}

let androidId = "";
export function setAndroidId(id: string | undefined): void {
  androidId = typeof id === "string" ? id.trim() : "";
}

async function postEvent(p: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Setup milestones ───────────────────────────────────────────────────────
// In memory so the hot paths that note them (every chat send, every setup
// step) cost one Map read; the file is touched only when a NEW one appears.
const MILESTONE_RE = /^(first_open|setup_done|first_message|setup_failed_[a-z]{1,24})$/;
let known: Record<string, boolean> | null = null; // null until the first daily run loads it
const pendingBeforeLoad = new Set<string>();
let flushing: Promise<void> | null = null;

export function noteMilestone(name: Milestone): void {
  if (!MILESTONE_RE.test(name)) return;
  if (known === null) { pendingBeforeLoad.add(name); return; }
  if (known.baseline || name in known) return;
  known[name] = false;
  void flushMilestones();
}

// Sends every owed milestone. Never blocks: async file I/O only.
async function flushMilestones(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!known || known.baseline || analyticsSuppression() !== null) return;
      const owed = Object.keys(known).filter((k) => known![k] === false);
      if (owed.length === 0) return;
      let state: AnalyticsState;
      try { state = JSON.parse(await fs.promises.readFile(ANALYTICS_FILE, "utf8")); } catch { return; }
      if (!state.optIn) return;
      // WHY wait for the daily run's hash: computing it here would call
      // node-machine-id (a synchronous child process) from a chat send.
      const hash = cachedHash;
      if (!hash) return;
      const team = await isTeamDevice();
      for (const milestone of owed) {
        const ok = await postEvent("/app/milestone", {
          deviceIdHash: hash,
          appVersion: app.getVersion(),
          platform: platformKind,
          os: platformKind === "android" ? "" : mapOs(process.platform),
          milestone,
          ...(team ? { team: true } : {}),
        });
        if (ok) known[milestone] = true;
      }
      state.milestones = { ...known };
      await fs.promises.writeFile(ANALYTICS_FILE, JSON.stringify(state, null, 2));
    } catch {
      // Analytics never surfaces an error; owed milestones retry on the next daily run.
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

// The hash the daily run computed; milestones flush only once it exists.
let cachedHash = "";

// Loads the milestone record at the first daily run. A missing file means a
// fresh install (first_open is owed); an existing file without milestones is
// an install from before milestones existed — it never sends any, so long-time
// users don't appear as new people walking through setup.
function loadMilestones(state: AnalyticsState, fresh: boolean): void {
  if (!state.milestones) state.milestones = fresh ? { first_open: false } : { baseline: true };
  known = state.milestones;
  for (const name of pendingBeforeLoad) if (!known.baseline && !(name in known)) known[name] = false;
  pendingBeforeLoad.clear();
}

export async function runAnalyticsOnLaunch(): Promise<void> {
  // WHY: packaged CI smoke tests use ephemeral machines; counting them creates
  // phantom devices and retention cohorts, and must not mutate analytics state.
  if (analyticsSuppression() !== null) return;

  const loaded = readState();
  const state = loaded ?? defaultState();
  if (known === null) {
    loadMilestones(state, loaded === null);
    writeState(state);
  }
  if (!state.optIn) return;

  const today = todayUtc();
  if (state.lastPingedDate !== today) {
    const hash = deviceIdHash(state);
    cachedHash = hash;
    const team = await isTeamDevice();

    const ok = await postEvent("/app/heartbeat", {
      deviceIdHash: hash,
      appVersion: app.getVersion(),
      platform: platformKind,
      os: platformKind === "android" ? "" : mapOs(process.platform),
      ...(team ? { team: true } : {}),
    });
    if (ok) {
      // Re-read: a milestone flush may have written the file meanwhile.
      const fresh = readState() ?? state;
      fresh.lastPingedDate = today;
      fresh.milestones = known ?? fresh.milestones;
      if (state.fallbackDeviceId) fresh.fallbackDeviceId = state.fallbackDeviceId;
      writeState(fresh);
    }
  } else if (!cachedHash) {
    cachedHash = deviceIdHash(state);
  }
  await flushMilestones();
}

// WHY a cap: a sleeping computer pauses this countdown, so a single wait until
// midnight could run hours late after the lid opens. Each wake-up only looks at
// the clock; the network is used at most once per UTC day (runAnalyticsOnLaunch
// is gated on lastPingedDate).
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;

// Milliseconds until the next UTC midnight (plus one second of margin so the
// check lands safely inside the new day), capped at MAX_WAIT_MS.
export function msUntilNextCheck(now: number = Date.now()): number {
  const d = new Date(now);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 1000;
  return Math.min(nextMidnight - now, MAX_WAIT_MS);
}

let dailyTimer: ReturnType<typeof setTimeout> | null = null;

// Sends today's heartbeat now (if not yet sent), then keeps sending one per
// UTC day for as long as the app stays open.
// WHY: the heartbeat used to fire only at launch, so an app left open for days
// was counted on its first day only.
export function startDailyHeartbeat(opts: { platform?: AnalyticsPlatform } = {}): void {
  if (opts.platform) setAnalyticsPlatform(opts.platform);
  if (dailyTimer) clearTimeout(dailyTimer);
  const tick = (): void => {
    // .catch first: a failed state-file write must neither surface as an
    // unhandled rejection nor stop the next day's check from being scheduled.
    void runAnalyticsOnLaunch().catch(() => {}).finally(() => {
      dailyTimer = setTimeout(tick, msUntilNextCheck());
      // Never keep the process alive just for analytics.
      dailyTimer.unref?.();
    });
  };
  tick();
}
