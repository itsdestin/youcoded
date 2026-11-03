// @vitest-environment jsdom
// AccountProvider React context. Timer note: while signedIn the provider registers a 15-minute revalidation setInterval, so
// vi.runAllTimersAsync() would hit the loop limit; tests advance a BOUNDED amount (well under 15 min) with pollIntervalMs=10.

import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { AccountProvider, useAccount } from "../src/renderer/state/account-context";

const STEP_MS = 60;
const USER = { id: "github:1", login: "u", avatar_url: "http://a" };
const START_OK = { ok: true, value: { device_code: "d", user_code: "U", auth_url: "http://a", expires_in: 900 } };

/** One probe exposing every piece of state and every action; tests click what they need. */
function Probe() {
  const { signedIn, user, signInError, signInPending, startSignIn, signOut, refresh, updateProfile, setHandle, deleteAccount } = useAccount();
  const [err, setErr] = useState("");
  const call = (fn: () => Promise<unknown>) => () => void fn().catch((e) => setErr(e.message));
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <span data-testid="handle">{user?.handle ?? ""}</span>
      <span data-testid="err">{err}</span>
      <span data-testid="signin-error">{signInError ?? ""}</span>
      <span data-testid="pending">{signInPending ? "pending" : "idle"}</span>
      <button data-testid="go" onClick={() => void startSignIn()} />
      <button data-testid="so" onClick={() => void signOut()} />
      <button data-testid="refresh" onClick={() => void refresh()} />
      <button data-testid="upd" onClick={call(() => updateProfile("X"))} />
      <button data-testid="seth" onClick={call(() => setHandle("newhandle"))} />
      <button data-testid="del" onClick={call(() => deleteAccount())} />
    </div>
  );
}

/** Installs window.claude.account with the given overrides over a signed-in default, renders the provider, and lets mount settle. */
async function mount(account: Record<string, unknown> = {}) {
  (globalThis as any).window.claude = {
    account: {
      signedIn: vi.fn().mockResolvedValue(true),
      user: vi.fn().mockResolvedValue(USER),
      refresh: vi.fn().mockResolvedValue(USER),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn(),
      setHandle: vi.fn(),
      deleteAccount: vi.fn(),
      ...account,
    },
  };
  const utils = render(<AccountProvider pollIntervalMs={10}><Probe /></AccountProvider>);
  await advance(STEP_MS);
  const text = (id: string) => utils.getByTestId(id).textContent;
  const click = (id: string, ms = STEP_MS) => advance(ms, () => utils.getByTestId(id).click());
  return { text, click };
}
async function advance(ms: number, before?: () => void) {
  await act(async () => {
    before?.();
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Signed-out on mount, signed-in after the first sign-in completes. */
const signedOutThenIn = () => ({
  start: vi.fn().mockResolvedValue(START_OK),
  signedIn: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
  user: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(USER),
});

describe("AccountProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).window = (globalThis as any).window ?? {};
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts signed-out, then signs in once the device-code flow completes (pending poll, then complete)", async () => {
    const m = await mount({
      ...signedOutThenIn(),
      poll: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
        .mockResolvedValueOnce({ ok: true, value: { status: "complete", token: "TOK" } }),
    });
    expect(m.text("state")).toBe("out");
    // One bounded advance covers start() -> poll#1 pending -> 10ms sleep -> poll#2 complete -> reloadFromStore.
    await m.click("go");
    expect(m.text("state")).toBe("in");
    expect(m.text("user")).toBe("u");
  });

  describe("account-mutation actions", () => {
    it("updateProfile throws with the server message when !res.ok", async () => {
      const m = await mount({ updateProfile: vi.fn().mockResolvedValue({ ok: false, message: "name too long" }) });
      await m.click("upd");
      expect(m.text("err")).toBe("name too long");
    });

    it("setHandle success refreshes user so the new handle renders", async () => {
      const m = await mount({
        user: vi.fn().mockResolvedValueOnce({ ...USER, handle: null }).mockResolvedValue({ ...USER, handle: "newhandle" }),
        setHandle: vi.fn().mockResolvedValue({ ok: true }),
      });
      expect(m.text("handle")).toBe("");
      await m.click("seth");
      expect(m.text("handle")).toBe("newhandle");
    });

    it("deleteAccount success clears signedIn + user", async () => {
      const m = await mount({ deleteAccount: vi.fn().mockResolvedValue({ ok: true }) });
      expect(m.text("state")).toBe("in");
      await m.click("del");
      expect(m.text("state")).toBe("out");
      expect(m.text("user")).toBe("");
    });

    // WHY: a pre-migration or 90-day-idle token leaves the client locally "signed in" while every call 401s; main clears the
    // session on a 401, so the reload the context runs BEFORE re-throwing reads signed-out. The UI must flip AND still show the error.
    it("setHandle 401 clears the session — context flips signed-out AND surfaces the error", async () => {
      const m = await mount({
        signedIn: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
        user: vi.fn().mockResolvedValueOnce(USER).mockResolvedValue(null),
        refresh: vi.fn().mockResolvedValue(null),
        setHandle: vi.fn().mockResolvedValue({ ok: false, status: 401, message: "invalid token" }),
      });
      expect(m.text("state")).toBe("in");
      await m.click("seth");
      expect(m.text("err")).toBe("invalid token");
      expect(m.text("state")).toBe("out");
      expect(m.text("user")).toBe("");
    });

    it("deleteAccount failure throws and leaves state unchanged (no optimistic clear)", async () => {
      const m = await mount({ deleteAccount: vi.fn().mockResolvedValue({ ok: false, message: "server error" }) });
      await m.click("del");
      expect(m.text("err")).toBe("server error");
      expect(m.text("state")).toBe("in");
      expect(m.text("user")).toBe("u");
    });
  });

  describe("sign-in errors, epoch cancellation and refresh()", () => {
    it("startSignIn failure sets signInError; a retry clears it", async () => {
      const m = await mount({
        ...signedOutThenIn(),
        start: vi.fn().mockResolvedValueOnce({ ok: false, message: "auth server down" }).mockResolvedValueOnce(START_OK),
        poll: vi.fn().mockResolvedValue({ ok: true, value: { status: "complete", token: "TOK" } }),
      });
      expect(m.text("signin-error")).toBe("");
      await m.click("go");
      expect(m.text("signin-error")).toContain("auth server down");
      expect(m.text("pending")).toBe("idle");
      await m.click("go");
      expect(m.text("signin-error")).toBe("");
    });

    it("a sign-in poll completing after signOut does NOT resurrect the session", async () => {
      const poll = vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
        .mockResolvedValueOnce({ ok: true, value: { status: "complete", token: "TOK" } }); // never reached: the epoch guard aborts after signOut
      const m = await mount({ ...signedOutThenIn(), poll, refresh: vi.fn().mockResolvedValue(null) });
      expect(m.text("state")).toBe("out");
      // Advance 9ms (< the 10ms poll sleep): poll#1 resolved pending and the loop is parked in its setTimeout.
      await m.click("go", 9);
      expect(poll).toHaveBeenCalledTimes(1);
      await m.click("so", 0);
      expect(m.text("state")).toBe("out");
      // The parked sleep fires: the loop sees the epoch changed and returns WITHOUT poll#2 or reloadFromStore.
      await advance(30);
      expect(poll).toHaveBeenCalledTimes(1);
      expect(m.text("state")).toBe("out");
      expect(m.text("user")).toBe("");
    });

    it("refresh() applies a changed user (a rename made on another device)", async () => {
      const m = await mount({
        user: vi.fn().mockResolvedValue({ ...USER, login: "old" }),
        refresh: vi.fn().mockResolvedValue({ ...USER, login: "new" }),
      });
      expect(m.text("user")).toBe("old");
      await m.click("refresh");
      expect(m.text("state")).toBe("in");
      expect(m.text("user")).toBe("new");
    });

    it("refresh() returning null signs the UI out (main cleared the session on a 401)", async () => {
      const m = await mount({ refresh: vi.fn().mockResolvedValue(null) });
      expect(m.text("state")).toBe("in");
      await m.click("refresh");
      expect(m.text("state")).toBe("out");
      expect(m.text("user")).toBe("");
    });

    // WHY: refresh() runs on every focus/15-min tick; a signOut landing while /auth/me is in flight must not flip the UI back to signed-in.
    it("a refresh() resolving after signOut does NOT resurrect the signed-in UI (epoch guard)", async () => {
      const m = await mount({
        refresh: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(USER), 50))), // resolves WITH A USER only after 50ms
      });
      expect(m.text("state")).toBe("in");
      await m.click("refresh", 10);
      await m.click("so", 0);
      expect(m.text("state")).toBe("out");
      await advance(100);
      expect(m.text("state")).toBe("out");
      expect(m.text("user")).toBe("");
    });
  });
});
