import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Stub electron before importing the service (service imports app from electron).
vi.mock("electron", () => ({ app: { getVersion: () => "9.9.9" } }));

const STATE_FILE = path.join(os.homedir(), ".claude", "youcoded-analytics.json");

describe("analytics-service.runAnalyticsOnLaunch", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
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

  it("first launch: generates UUID, posts install, posts heartbeat, saves state", async () => {
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.installId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.installReported).toBe(true);
    expect(state.lastPingedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((u: string) => u.endsWith("/app/install"))).toBe(true);
    expect(calls.some((u: string) => u.endsWith("/app/heartbeat"))).toBe(true);
  });

  it("second launch same day: no posts", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      installId: "c4b2a8f0-0000-4000-8000-000000000000",
      optIn: true,
      lastPingedDate: new Date().toISOString().slice(0, 10),
      installReported: true,
    }));
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("launch after a day gap: only heartbeat, not install", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      installId: "c4b2a8f0-0000-4000-8000-000000000000",
      optIn: true,
      lastPingedDate: "1970-01-01",
      installReported: true,
    }));
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((u: string) => u.endsWith("/app/install"))).toBe(false);
    expect(calls.some((u: string) => u.endsWith("/app/heartbeat"))).toBe(true);
  });

  it("opt-out: zero network calls", async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      installId: "c4b2a8f0-0000-4000-8000-000000000000",
      optIn: false,
      lastPingedDate: "",
      installReported: false,
    }));
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("network failure: does not throw, does not mutate state", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("net"); }) as any;
    const svc = await importFresh();
    await svc.runAnalyticsOnLaunch();
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(state.lastPingedDate).toBe("");
    expect(state.installReported).toBe(false);
  });
});
