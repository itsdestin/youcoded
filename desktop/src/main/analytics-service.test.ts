import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHmac } from "node:crypto";

let appVersion = "9.9.9";
vi.mock("electron", () => ({ app: { getVersion: () => appVersion } }));

// Mutable mock for node-machine-id — tests reassign machineIdImpl per case.
// Using a shared mutable reference (instead of vi.doMock per test) avoids the
// vi.doMock-doesn't-override issue when this test runs as part of the full suite.
let machineIdImpl: () => string = () => "test-machine-id-stable";
vi.mock("node-machine-id", () => ({
  machineIdSync: () => machineIdImpl(),
}));

// Release builds are stamped official; the checked-in default is false.
let official = true;
vi.mock("./official-build", () => ({ get OFFICIAL_BUILD() { return official; } }));

const STATE_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");
const TEAM_FILE = path.join(os.homedir(), ".claude", "youcoded-team-device");

type Call = { url: string; body: any };
const calls = (): Call[] => (globalThis.fetch as any).mock.calls.map((c: any[]) => ({ url: c[0] as string, body: JSON.parse(c[1].body as string) }));
const to = (suffix: string) => calls().filter((c) => c.url.endsWith(suffix));

function writeExisting(state: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

const origFetch = globalThis.fetch;
const origSmokeTest = process.env.YOUCODED_SMOKE_TEST;
const origNoAnalytics = process.env.YOUCODED_NO_ANALYTICS;

beforeEach(() => {
  machineIdImpl = () => "test-machine-id-stable";
  official = true;
  appVersion = "9.9.9";
  delete process.env.YOUCODED_SMOKE_TEST;
  // vitest.config.ts switches analytics off suite-wide; these cases exercise sending.
  delete process.env.YOUCODED_NO_ANALYTICS;
  for (const f of [STATE_FILE, TEAM_FILE]) try { fs.unlinkSync(f); } catch {}
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })
  ) as any;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = origFetch;
  if (origSmokeTest === undefined) delete process.env.YOUCODED_SMOKE_TEST;
  else process.env.YOUCODED_SMOKE_TEST = origSmokeTest;
  if (origNoAnalytics === undefined) delete process.env.YOUCODED_NO_ANALYTICS;
  else process.env.YOUCODED_NO_ANALYTICS = origNoAnalytics;
  for (const f of [STATE_FILE, TEAM_FILE]) try { fs.unlinkSync(f); } catch {}
});

async function importFresh() {
  vi.resetModules();
  return (await import("./analytics-service")) as typeof import("./analytics-service");
}

describe("analytics-service.runAnalyticsOnLaunch", () => {
  it("smoke-test launch sends nothing and creates no analytics state", async () => {
    process.env.YOUCODED_SMOKE_TEST = "1";
    machineIdImpl = () => { throw new Error("smoke tests must not calculate an identity"); };

    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  it("the no-analytics switch, an unofficial build and a test-build version each send nothing", async () => {
    process.env.YOUCODED_NO_ANALYTICS = "1";
    await (await importFresh()).runAnalyticsOnLaunch();
    delete process.env.YOUCODED_NO_ANALYTICS;

    official = false;
    await (await importFresh()).runAnalyticsOnLaunch();
    official = true;

    appVersion = "1.4.0-releasetest";
    await (await importFresh()).runAnalyticsOnLaunch();
    appVersion = "1.4.0-dev.3";
    await (await importFresh()).runAnalyticsOnLaunch();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  it("a beta version of an official build still checks in", async () => {
    appVersion = "1.4.0-beta.30";
    await (await importFresh()).runAnalyticsOnLaunch();
    expect(to("/app/heartbeat")).toHaveLength(1);
  });

  it("first launch: posts ONE heartbeat with deviceIdHash, saves lastPingedDate", async () => {
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const beats = to("/app/heartbeat");
    expect(beats).toHaveLength(1);
    const body = beats[0].body;
    expect(body.deviceIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.installId).toBeUndefined();
    expect(body.appVersion).toBe("9.9.9");
    expect(body.platform).toBe("desktop");
    expect(body.team).toBeUndefined();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.lastPingedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.installId).toBeUndefined();
    expect(state.fallbackDeviceId).toBeUndefined();
  });

  it("does NOT post /app/install (event was retired)", async () => {
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(calls().some((c) => c.url.endsWith("/app/install"))).toBe(false);
  });

  it("second launch same day: no posts", async () => {
    writeExisting({ optIn: true, lastPingedDate: new Date().toISOString().slice(0, 10) });
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("opt-out: zero network calls", async () => {
    writeExisting({ optIn: false, lastPingedDate: "" });
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("network failure: state.lastPingedDate not advanced", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("net"); }) as any;
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    let state: { lastPingedDate?: string } = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
    expect(state.lastPingedDate ?? "").toBe("");
  });

  it("machine-id read failure: persists fallbackDeviceId, hashes prefixed string", async () => {
    machineIdImpl = () => { throw new Error("no /etc/machine-id"); };
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.fallbackDeviceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(to("/app/heartbeat")[0].body.deviceIdHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("legacy installId/installReported in state file: silently dropped", async () => {
    writeExisting({
      installId: "c4b2a8f0-0000-4000-8000-000000000000",
      installReported: true,
      optIn: true,
      lastPingedDate: "1970-01-01",
    });
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.installId).toBeUndefined();
    expect(state.installReported).toBeUndefined();
    expect(state.optIn).toBe(true);
  });

  it("a team device's check-in is marked team", async () => {
    fs.mkdirSync(path.dirname(TEAM_FILE), { recursive: true });
    fs.writeFileSync(TEAM_FILE, "");
    await (await importFresh()).runAnalyticsOnLaunch();
    expect(to("/app/heartbeat")[0].body.team).toBe(true);
  });
});

describe("analytics-service on a phone", () => {
  it("checks in as android with the 1.3.0 phone identity and never asks node-machine-id", async () => {
    machineIdImpl = () => { throw new Error("a phone must not read the machine id"); };
    const svc = await importFresh();
    svc.setAndroidId("a1b2c3d4e5f60718");
    svc.setAnalyticsPlatform("android");
    await svc.runAnalyticsOnLaunch();
    const body = to("/app/heartbeat")[0].body;
    expect(body.platform).toBe("android");
    expect(body.os).toBe("");
    const { ANALYTICS_SALT } = await import("./analytics-salt");
    const expected = createHmac("sha256", ANALYTICS_SALT).update("a1b2c3d4e5f60718|android").digest("hex");
    expect(body.deviceIdHash).toBe(expected);
  });

  it("a phone without an ID keeps one random ID instead of sharing one", async () => {
    machineIdImpl = () => "localhost";
    const svc = await importFresh();
    svc.setAnalyticsPlatform("android");
    await svc.runAnalyticsOnLaunch();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.fallbackDeviceId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("analytics-service setup milestones and the opt-out notice", () => {
  it("a fresh install sends first_open once, then first_message once however many messages follow", async () => {
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    await vi.waitFor(() => expect(to("/app/milestone").map((c) => c.body.milestone)).toEqual(["first_open"]));

    svc.noteMilestone("first_message");
    svc.noteMilestone("first_message");
    await vi.waitFor(() => expect(to("/app/milestone").map((c) => c.body.milestone)).toEqual(["first_open", "first_message"]));
    const m = to("/app/milestone")[1].body;
    expect(m.deviceIdHash).toBe(to("/app/heartbeat")[0].body.deviceIdHash);

    // A later launch remembers what was sent.
    const again = await importFresh();
    again.noteMilestone("first_message");
    writeExisting({ ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")), lastPingedDate: "1970-01-01" });
    await again.runAnalyticsOnLaunch();
    expect(to("/app/milestone")).toHaveLength(2);
  });

  it("an install from before milestones existed never sends any", async () => {
    writeExisting({ optIn: true, lastPingedDate: "1970-01-01" });
    const svc = await importFresh();
    svc.noteMilestone("setup_done");
    await svc.runAnalyticsOnLaunch();
    svc.noteMilestone("first_message");
    expect(to("/app/heartbeat")).toHaveLength(1);
    expect(to("/app/milestone")).toHaveLength(0);
  });

  it("a milestone noted before the first check-in is sent with it", async () => {
    const svc = await importFresh();
    svc.noteMilestone("setup_failed_node");
    await svc.runAnalyticsOnLaunch();
    await vi.waitFor(() => expect(to("/app/milestone").map((c) => c.body.milestone).sort()).toEqual(["first_open", "setup_failed_node"]));
  });

  it("switching analytics off while setup steps are sending stays off", async () => {
    let release: () => void = () => {};
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch(); // fresh install: first_open goes out
    await vi.waitFor(() => expect(to("/app/milestone")).toHaveLength(1));
    globalThis.fetch = vi.fn((url: string) => new Promise((resolve) => {
      release = () => resolve(new Response("{}", { status: 200 }));
      if (!String(url).endsWith("/app/milestone")) release();
    })) as any;
    svc.noteMilestone("first_message");
    await vi.waitFor(() => expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(0));
    svc.setOptIn(false);
    release();
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).milestones.first_message).toBe(true));
    expect(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).optIn).toBe(false);
  });

  it("a damaged analytics file is treated as an existing install, never a new one", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, "{not json");
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(to("/app/heartbeat")).toHaveLength(1);
    expect(to("/app/milestone")).toHaveLength(0);
  });

  it("turning analytics off sends one notice without the device hash, once", async () => {
    writeExisting({ optIn: true, lastPingedDate: "1970-01-01" });
    const svc = await importFresh();
    svc.setOptIn(false);
    await vi.waitFor(() => expect(to("/app/opt-out")).toHaveLength(1));
    expect(to("/app/opt-out")[0].body.deviceIdHash).toBeUndefined();
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).optOutReported).toBe(true));
    svc.setOptIn(true);
    svc.setOptIn(false);
    // settle: give a second notice the chance to appear
    await new Promise((r) => setImmediate(r));
    expect(to("/app/opt-out")).toHaveLength(1);
  });
});

describe("analytics-service daily heartbeat while open", () => {
  it("msUntilNextCheck: waits until just after UTC midnight when that is under 3h away", async () => {
    const svc = await importFresh();
    const now = Date.UTC(2026, 8, 16, 23, 0, 0);
    expect(svc.msUntilNextCheck(now)).toBe(60 * 60 * 1000 + 1000);
  });

  it("msUntilNextCheck: never waits longer than 3 hours", async () => {
    const svc = await importFresh();
    const now = Date.UTC(2026, 8, 16, 1, 0, 0);
    expect(svc.msUntilNextCheck(now)).toBe(3 * 60 * 60 * 1000);
  });

  it("an app left open sends exactly one heartbeat per UTC day", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 20, 0, 0)));
    const svc = await importFresh();
    const beats = () => to("/app/heartbeat").length;

    svc.startDailyHeartbeat();
    await vi.waitFor(() => expect(beats()).toBe(1));

    // Same day: the next wake-up only looks at the clock.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(beats()).toBe(1);

    // Past UTC midnight: the new day's heartbeat goes out.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(beats()).toBe(2));

    // A further full day of wake-ups adds exactly one more.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await vi.waitFor(() => expect(beats()).toBe(3));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(beats()).toBe(3);
  });
});
