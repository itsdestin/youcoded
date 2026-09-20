// Sends one /app/heartbeat per UTC day, gated by an opt-out toggle.
// WHY once per day is a CONTRACT, not a tuning knob: AboutPopup.tsx promises
// users "anonymous usage data … once per day". Sending more often (to fix a
// counting gap, say) rewrites that copy — a product decision. The day boundary
// is UTC on every device; the owner dashboard chooses which clock it counts by.
// Identity is HMAC_SHA256(SALT, machine_id || platform), computed
// client-side. Fire-and-forget — any failure is swallowed and retried
// next launch. Zero behavioral impact if the network is unreachable.
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
import { isSmokeTest } from "./smoke-probe";

// WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
const API_BASE = "https://api.youcoded.ai";
const ANALYTICS_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");

interface AnalyticsState {
  optIn: boolean;
  lastPingedDate: string;       // YYYY-MM-DD UTC, or "" when never pinged
  fallbackDeviceId?: string;    // present only if machine_id read failed
}

function defaultState(): AnalyticsState {
  return { optIn: true, lastPingedDate: "" };
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

function readState(): AnalyticsState {
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
    };
  } catch {
    return defaultState();
  }
}

function writeState(state: AnalyticsState): void {
  fs.mkdirSync(path.dirname(ANALYTICS_FILE), { recursive: true });
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(state, null, 2));
}

export function getOptIn(): boolean {
  return readState().optIn;
}

export function setOptIn(value: boolean): void {
  const state = readState();
  state.optIn = value;
  writeState(state);
}

// Computes the device-id hash. Mutates state.fallbackDeviceId and persists
// the state file when the machine_id read fails.
export function deviceIdHash(state: AnalyticsState): string {
  let raw = "";
  try {
    raw = machineIdSync(true);  // `true` = return raw machine_id rather than the SHA-256 of it
  } catch {
    // swallowed — caught by the length check below
  }
  if (!raw || raw.length < 8) {
    if (!state.fallbackDeviceId) {
      state.fallbackDeviceId = randomUUID();
      writeState(state);
    }
    raw = `fallback:${state.fallbackDeviceId}`;
  }
  return createHmac("sha256", ANALYTICS_SALT)
    .update(`${raw}|${process.platform}`)
    .digest("hex");
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

export async function runAnalyticsOnLaunch(): Promise<void> {
  // WHY: packaged CI smoke tests use ephemeral machines; counting them creates
  // phantom devices and retention cohorts, and must not mutate analytics state.
  if (isSmokeTest()) return;

  const state = readState();
  if (!state.optIn) return;

  const today = todayUtc();
  if (state.lastPingedDate === today) return;

  const hash = deviceIdHash(state);

  const ok = await postEvent("/app/heartbeat", {
    deviceIdHash: hash,
    appVersion: app.getVersion(),
    platform: "desktop" as const,
    os: mapOs(process.platform),
  });
  if (ok) {
    state.lastPingedDate = today;
    writeState(state);
  }
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
export function startDailyHeartbeat(): void {
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
