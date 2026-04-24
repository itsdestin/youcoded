// Sends one /app/install when the install_id is first generated and one
// /app/heartbeat per UTC day, gated by an opt-out toggle. Fire-and-forget —
// any failure is swallowed and retried next launch. Zero behavioral impact
// if the network is unreachable.
//
// Privacy: the install_id is a random UUID, never tied to a user account or
// machine identifier. Country is NOT sent from the client — the Worker reads
// it from the CF-IPCountry header on the request.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const API_BASE = "https://wecoded-marketplace-api.destinj101.workers.dev";
const ANALYTICS_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");

interface AnalyticsState {
  installId: string;
  optIn: boolean;
  lastPingedDate: string;   // YYYY-MM-DD in UTC, or "" when never pinged
  installReported: boolean;
}

function defaultState(): AnalyticsState {
  return { installId: "", optIn: true, lastPingedDate: "", installReported: false };
}

// Map node's process.platform (win32 | darwin | linux | other) to the short
// strings the server validates against. Unknowns become "" — server allows
// empty os because Android clients send it that way.
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
    const parsed = JSON.parse(raw) as Partial<AnalyticsState>;
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function writeState(state: AnalyticsState): void {
  fs.mkdirSync(path.dirname(ANALYTICS_FILE), { recursive: true });
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(state, null, 2));
}

// Exported for the IPC opt-out handler in ipc-handlers.ts.
export function getOptIn(): boolean {
  return readState().optIn;
}

export function setOptIn(value: boolean): void {
  const state = readState();
  state.optIn = value;
  if (!state.installId) state.installId = randomUUID();
  writeState(state);
}

// Launch-time ping. Implemented in Task 5.3 (TDD: tests in 5.2 first).
export async function runAnalyticsOnLaunch(): Promise<void> {
  // stub — will be replaced
}
