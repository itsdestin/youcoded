import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("electron", () => ({ app: { getVersion: () => "9.9.9" } }));

// Mutable mock for node-machine-id — tests reassign machineIdImpl per case.
// Using a shared mutable reference (instead of vi.doMock per test) avoids the
// vi.doMock-doesn't-override issue when this test runs as part of the full suite.
let machineIdImpl: () => string = () => "test-machine-id-stable";
vi.mock("node-machine-id", () => ({
  machineIdSync: () => machineIdImpl(),
}));

const STATE_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");

describe("analytics-service.runAnalyticsOnLaunch", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    machineIdImpl = () => "test-machine-id-stable";
    try { fs.unlinkSync(STATE_FILE); } catch {}
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as any;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  async function importFresh() {
    vi.resetModules();
    return (await import("./analytics-service")) as typeof import("./analytics-service");
  }

  it("first launch: posts ONE heartbeat with deviceIdHash, saves lastPingedDate", async () => {
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const calls = (globalThis.fetch as any).mock.calls;
    expect(calls).toHaveLength(1);
    const url = calls[0][0] as string;
    const body = JSON.parse(calls[0][1].body as string);
    expect(url).toMatch(/\/app\/heartbeat$/);
    expect(body.deviceIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.installId).toBeUndefined();
    expect(body.appVersion).toBe("9.9.9");
    expect(body.platform).toBe("desktop");
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.lastPingedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.installId).toBeUndefined();
    expect(state.fallbackDeviceId).toBeUndefined();
  });

  it("does NOT post /app/install (event was retired)", async () => {
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((u: string) => u.endsWith("/app/install"))).toBe(false);
  });

  it("second launch same day: no posts", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      optIn: true,
      lastPingedDate: new Date().toISOString().slice(0, 10),
    }));
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("opt-out: zero network calls", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      optIn: false,
      lastPingedDate: "",
    }));
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("network failure: state.lastPingedDate not advanced", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("net"); }) as any;
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    // First-launch network failure: no state mutation happened (machine_id
    // succeeded so no fallback was persisted; postEvent failed so
    // lastPingedDate wasn't advanced). The file may not exist.
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
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.deviceIdHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("legacy installId/installReported in state file: silently dropped", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      installId: "c4b2a8f0-0000-4000-8000-000000000000",
      installReported: true,
      optIn: true,
      lastPingedDate: "1970-01-01",
    }));
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.installId).toBeUndefined();
    expect(state.installReported).toBeUndefined();
    expect(state.optIn).toBe(true);
  });
});

describe("analytics-service daily heartbeat while open", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    machineIdImpl = () => "test-machine-id-stable";
    try { fs.unlinkSync(STATE_FILE); } catch {}
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as any;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = origFetch;
    try { fs.unlinkSync(STATE_FILE); } catch {}
  });

  async function importFresh() {
    vi.resetModules();
    return (await import("./analytics-service")) as typeof import("./analytics-service");
  }

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
    const fetchMock = globalThis.fetch as any;

    svc.startDailyHeartbeat();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Same day: the next wake-up only looks at the clock.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past UTC midnight: the new day's heartbeat goes out.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // A further full day of wake-ups adds exactly one more.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
