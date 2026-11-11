// @vitest-environment jsdom
// account-context.test.tsx
// Tests for the AccountProvider React context.
// Runs in jsdom so React DOM + document are available.
//
// Timer note: the provider now registers a 15-minute setInterval (focus/interval
// profile revalidation) whenever signedIn is true. vi.runAllTimersAsync() would
// try to exhaust that infinite interval and throw at the loop limit, so these
// tests advance time with a BOUNDED vi.advanceTimersByTimeAsync(N) (N well under
// 15min) — the poll loop's short setTimeout fires, the revalidation interval
// never does. pollIntervalMs is set to 10ms so the poll loop resolves quickly.

import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  AccountProvider,
  useAccount,
} from "../src/renderer/state/account-context";

// Bounded advance — flushes the poll loop's 10ms timer + pending microtasks
// without ever reaching the 15-minute revalidation interval.
const STEP_MS = 60;
async function settle(ms = STEP_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Simple probe component that renders current auth state
function Probe() {
  const { signedIn, startSignIn, user } = useAccount();
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <button data-testid="go" onClick={() => void startSignIn()}>
        go
      </button>
    </div>
  );
}

// Helper — build a fresh mock and assign to globalThis.window.claude
function makeMock() {
  return {
    account: {
      // start() returns ApiResult<AuthStartResponse>
      start: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          device_code: "d",
          user_code: "U",
          auth_url: "http://a",
          expires_in: 900,
        },
      }),
      // poll() returns ApiResult<AuthPollResponse>
      // First call → pending; second call → complete
      poll: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
        .mockResolvedValueOnce({
          ok: true,
          value: { status: "complete", token: "TOK" },
        }),
      // Plain returns (NOT wrapped in ApiResult):
      signedIn: vi
        .fn()
        .mockResolvedValueOnce(false) // initial refresh on mount
        .mockResolvedValue(true),     // after sign-in completes
      user: vi
        .fn()
        .mockResolvedValueOnce(null)  // initial refresh on mount
        .mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
      // account:refresh — force /auth/me; returns the fresh user or null.
      refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
      signOut: vi.fn().mockResolvedValue(undefined),
      // Account-mutation methods (accounts Phase 1). ApiResult-shaped returns.
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

// Probe that exposes the three account-mutation actions plus current state, so
// tests can drive updateProfile / setHandle / deleteAccount and observe the
// resulting state + surfaced error message.
function ActionsProbe() {
  const { signedIn, user, updateProfile, setHandle, deleteAccount } =
    useAccount();
  const [err, setErr] = useState("");
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <span data-testid="handle">{user?.handle ?? ""}</span>
      <span data-testid="err">{err}</span>
      <button data-testid="upd" onClick={() => void updateProfile("X").catch((e) => setErr(e.message))}>
        upd
      </button>
      <button data-testid="seth" onClick={() => void setHandle("newhandle").catch((e) => setErr(e.message))}>
        seth
      </button>
      <button data-testid="del" onClick={() => void deleteAccount().catch((e) => setErr(e.message))}>
        del
      </button>
    </div>
  );
}

// Probe exposing signInError + the sign-in trigger (Part 4a).
function SignInErrorProbe() {
  const { signInError, signInPending, startSignIn } = useAccount();
  return (
    <div>
      <span data-testid="signin-error">{signInError ?? ""}</span>
      <span data-testid="pending">{signInPending ? "pending" : "idle"}</span>
      <button data-testid="go" onClick={() => void startSignIn()}>go</button>
    </div>
  );
}

// Probe exposing state + both startSignIn and signOut (Part 4b — epoch guard).
function EpochProbe() {
  const { signedIn, user, startSignIn, signOut } = useAccount();
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <button data-testid="go" onClick={() => void startSignIn()}>go</button>
      <button data-testid="so" onClick={() => void signOut()}>so</button>
    </div>
  );
}

// Probe exposing the refresh() action + state (Part 4c) plus signOut (epoch
// guard on refresh — a refresh resolving after signOut must not resurrect state).
function RefreshProbe() {
  const { signedIn, user, refresh, signOut } = useAccount();
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <button data-testid="refresh" onClick={() => void refresh()}>refresh</button>
      <button data-testid="so" onClick={() => void signOut()}>so</button>
    </div>
  );
}

describe("AccountProvider", () => {
  beforeEach(() => {
    // Fake timers so setTimeout in the poll loop resolves instantly
    vi.useFakeTimers();
    // Assign a fresh mock before each test
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = makeMock();
  });

  afterEach(() => {
    // Clean up the rendered tree between tests (prevents element duplication)
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts as signed-out", async () => {
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <Probe />
      </AccountProvider>
    );

    // Let the initial reloadFromStore() promises resolve (signedIn + user calls)
    await settle();

    // After initial refresh, signedIn() returned false → state should be "out"
    expect(getByTestId("state").textContent).toBe("out");
  });

  it("transitions to signed-in after sign-in flow completes", async () => {
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <Probe />
      </AccountProvider>
    );

    // Wait for initial mount refresh to complete
    await settle();

    // Confirm starts out
    expect(getByTestId("state").textContent).toBe("out");

    // Click the sign-in button — starts the device-code flow. A single bounded
    // advance covers start() → poll#1 pending → 10ms sleep → poll#2 complete →
    // reloadFromStore.
    await act(async () => {
      getByTestId("go").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    // After "complete", reloadFromStore() called signedIn() → true and user() → user obj
    expect(getByTestId("state").textContent).toBe("in");
    expect(getByTestId("user").textContent).toBe("u");
  });

  // ── Account-mutation actions (accounts Phase 1) ─────────────────────────────

  it("updateProfile throws with the server message when !res.ok", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        updateProfile: vi.fn().mockResolvedValue({ ok: false, message: "name too long" }),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await settle();

    await act(async () => {
      getByTestId("upd").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    // The context rethrows new Error(res.message); the probe surfaces it.
    expect(getByTestId("err").textContent).toBe("name too long");
  });

  it("setHandle success refreshes user so the new handle renders", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        // Mount → handle null; after setHandle refresh → handle "newhandle".
        user: vi
          .fn()
          .mockResolvedValueOnce({ id: "github:1", login: "u", avatar_url: "http://a", handle: null })
          .mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a", handle: "newhandle" }),
        refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a", handle: "newhandle" }),
        updateProfile: vi.fn(),
        setHandle: vi.fn().mockResolvedValue({ ok: true }),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("handle").textContent).toBe("");

    await act(async () => {
      getByTestId("seth").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    // reloadFromStore() re-read user() → new handle now rendered.
    expect(getByTestId("handle").textContent).toBe("newhandle");
  });

  it("deleteAccount success clears signedIn + user", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("state").textContent).toBe("in");

    await act(async () => {
      getByTestId("del").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });

  it("setHandle 401 clears the session — context flips signed-out AND surfaces the error", async () => {
    // Regression: a pre-migration (or 90-day-idle-expired) token leaves the client
    // locally "signed in" but every auth'd call 401s. The main process now clears
    // the session on a 401, so signedIn()/user() read false/null on the reload the
    // context runs BEFORE re-throwing. Assert the UI both flips signed-out and still
    // shows the error message.
    (globalThis as any).window.claude = {
      account: {
        // Mount → signed in; post-401 reload → signed out (main cleared it).
        signedIn: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
        user: vi
          .fn()
          .mockResolvedValueOnce({ id: "github:1", login: "u", avatar_url: "http://a" })
          .mockResolvedValue(null),
        refresh: vi.fn().mockResolvedValue(null),
        updateProfile: vi.fn(),
        setHandle: vi.fn().mockResolvedValue({ ok: false, status: 401, message: "invalid token" }),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("state").textContent).toBe("in");

    await act(async () => {
      getByTestId("seth").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    // The error still surfaces to the caller (the popup shows it)...
    expect(getByTestId("err").textContent).toBe("invalid token");
    // ...and the app has flipped to signed-out so sign-in prompts return.
    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });

  it("deleteAccount failure throws and leaves state unchanged", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn().mockResolvedValue({ ok: false, message: "server error" }),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <ActionsProbe />
      </AccountProvider>
    );
    await settle();

    await act(async () => {
      getByTestId("del").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    // Error surfaced; signed-in state untouched (no optimistic clear on failure).
    expect(getByTestId("err").textContent).toBe("server error");
    expect(getByTestId("state").textContent).toBe("in");
    expect(getByTestId("user").textContent).toBe("u");
  });

  // ── Phase 2: signInError surfacing, epoch cancellation, refresh() ───────────

  it("startSignIn failure sets signInError; a retry clears it (knowledge-debt #6)", async () => {
    (globalThis as any).window.claude = {
      account: {
        // First attempt: start() fails. Retry: start() ok → poll completes.
        start: vi
          .fn()
          .mockResolvedValueOnce({ ok: false, message: "auth server down" })
          .mockResolvedValueOnce({ ok: true, value: { device_code: "d", user_code: "U", auth_url: "http://a", expires_in: 900 } }),
        poll: vi.fn().mockResolvedValue({ ok: true, value: { status: "complete", token: "TOK" } }),
        signedIn: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
        user: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        signOut: vi.fn().mockResolvedValue(undefined),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <SignInErrorProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("signin-error").textContent).toBe("");

    // First attempt fails — signInError carries the mapped message.
    await act(async () => {
      getByTestId("go").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    expect(getByTestId("signin-error").textContent).toContain("auth server down");
    expect(getByTestId("pending").textContent).toBe("idle");

    // Retry succeeds — startSignIn clears signInError at entry and it stays clear.
    await act(async () => {
      getByTestId("go").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    expect(getByTestId("signin-error").textContent).toBe("");
  });

  it("a sign-in poll completing after signOut does NOT resurrect the session (knowledge-debt #5)", async () => {
    const poll = vi
      .fn()
      // poll#1 → pending (loop then sleeps pollIntervalMs); poll#2 (never reached
      // because the epoch guard aborts after signOut) → complete.
      .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
      .mockResolvedValueOnce({ ok: true, value: { status: "complete", token: "TOK" } });
    (globalThis as any).window.claude = {
      account: {
        start: vi.fn().mockResolvedValue({ ok: true, value: { device_code: "d", user_code: "U", auth_url: "http://a", expires_in: 900 } }),
        poll,
        // Mount → false. Any LATER reload (the resurrection we must prevent) → true.
        signedIn: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
        user: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        refresh: vi.fn().mockResolvedValue(null),
        signOut: vi.fn().mockResolvedValue(undefined),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <EpochProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("state").textContent).toBe("out");

    // Start sign-in; advance only 9ms (< the 10ms poll sleep) so poll#1 has
    // resolved (pending) and the loop is parked in its setTimeout, NOT yet firing poll#2.
    await act(async () => {
      getByTestId("go").click();
      await vi.advanceTimersByTimeAsync(9);
    });
    expect(poll).toHaveBeenCalledTimes(1);

    // Sign out mid-flight — bumps the epoch, flips state to signed-out.
    await act(async () => {
      getByTestId("so").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getByTestId("state").textContent).toBe("out");

    // Fire the parked 10ms sleep: the loop resumes, sees the epoch changed, and
    // returns WITHOUT calling poll#2 or reloadFromStore. State stays signed-out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(poll).toHaveBeenCalledTimes(1); // poll#2 (complete) never reached
    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });

  it("refresh() applies a changed user (knowledge-debt #8)", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "old", avatar_url: "http://a" }),
        // Forced /auth/me reveals a rename made on another device.
        refresh: vi.fn().mockResolvedValue({ id: "github:1", login: "new", avatar_url: "http://a" }),
        signOut: vi.fn(),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <RefreshProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("user").textContent).toBe("old");

    await act(async () => {
      getByTestId("refresh").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    expect(getByTestId("state").textContent).toBe("in");
    expect(getByTestId("user").textContent).toBe("new");
  });

  it("refresh() returning null signs the UI out (401 auto-sign-out propagates)", async () => {
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        // Main cleared the session on a 401 → refresh returns null.
        refresh: vi.fn().mockResolvedValue(null),
        signOut: vi.fn(),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <RefreshProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("state").textContent).toBe("in");

    await act(async () => {
      getByTestId("refresh").click();
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });

    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });

  it("a refresh() resolving after signOut does NOT resurrect the signed-in UI (epoch guard)", async () => {
    // Regression: refresh() runs on every focus/15-min tick. A signOut landing
    // while the main process's /auth/me is in flight must not flip the UI back
    // to signed-in when the refresh resolves OK with a user.
    (globalThis as any).window.claude = {
      account: {
        signedIn: vi.fn().mockResolvedValue(true),
        user: vi.fn().mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
        // Slow refresh: resolves WITH A USER only after 50ms (fake-timer time),
        // giving the test a window to sign out while it's in flight.
        refresh: vi.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ id: "github:1", login: "u", avatar_url: "http://a" }), 50),
            ),
        ),
        signOut: vi.fn().mockResolvedValue(undefined),
        updateProfile: vi.fn(),
        setHandle: vi.fn(),
        deleteAccount: vi.fn(),
      },
    };
    const { getByTestId } = render(
      <AccountProvider pollIntervalMs={10}>
        <RefreshProbe />
      </AccountProvider>
    );
    await settle();
    expect(getByTestId("state").textContent).toBe("in");

    // Start a refresh (parked in its 50ms timeout), then sign out before it resolves.
    await act(async () => {
      getByTestId("refresh").click();
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      getByTestId("so").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getByTestId("state").textContent).toBe("out");

    // Let the in-flight refresh resolve with a user — the epoch guard must
    // discard it; state stays signed-out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(getByTestId("state").textContent).toBe("out");
    expect(getByTestId("user").textContent).toBe("");
  });
});

// The "signed out by itself" notice (card #216): the main process sends a presence event of type "session-lost".
describe("AccountProvider — signed out by the app", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function mountWith(openExternal: boolean) {
    let push: (ev: { type: string }) => void = () => {};
    const mock = makeMock();
    mock.account.signedIn = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    mock.account.user = vi.fn().mockResolvedValueOnce({ id: "github:1", login: "u", avatar_url: "a" }).mockResolvedValue(null);
    (globalThis.window as any).claude = {
      ...mock,
      capabilities: { openExternal },
      social: { onPresenceEvent: (cb: typeof push) => { push = cb; return () => {}; } },
    };
    const notices: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
    const onNotice = (e: Event) => notices.push((e as CustomEvent).detail);
    window.addEventListener("youcoded:notice", onNotice);
    const view = render(<AccountProvider pollIntervalMs={10}><Probe /></AccountProvider>);
    return { push: (ev: { type: string }) => push(ev), notices, mock, view, off: () => window.removeEventListener("youcoded:notice", onNotice) };
  }

  it("flips to signed-out and raises one notice whose button starts sign-in again", async () => {
    const t = mountWith(true);
    await settle();
    expect(t.view.getByTestId("state").textContent).toBe("in");
    await act(async () => { t.push({ type: "session-lost" }); });
    await settle();
    expect(t.view.getByTestId("state").textContent).toBe("out");
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0].message).toBe("You were signed out of your YouCoded account. Friends see you as offline until you sign in again.");
    expect(t.notices[0].action?.label).toBe("Sign in again");
    await act(async () => { t.notices[0].action!.onClick(); });
    await settle();
    expect(t.mock.account.start).toHaveBeenCalledTimes(1);
    t.off();
  });

  it("ignores other presence events", async () => {
    const t = mountWith(true);
    await settle();
    await act(async () => { t.push({ type: "connected" }); });
    expect(t.notices).toHaveLength(0);
    t.off();
  });

  it("gives a phone browser (which cannot sign in) no notice", async () => {
    const t = mountWith(false);
    await settle();
    await act(async () => { t.push({ type: "session-lost" }); });
    await settle();
    expect(t.notices).toHaveLength(0);
    t.off();
  });
});
